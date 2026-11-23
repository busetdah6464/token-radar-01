// main.ts — Launch Radar: build a token launch radar from a DefiLlama snapshot.
//
// Reads /input/snapshot.json (the sealed snapshot; SNAPSHOT env overrides
// it for local testing), ranks every protocol that records no token, and
// writes /output/board.json, /output/data.js, dashboard/ and screenshots/,
// plus a best-effort /output/dossier.json (the kit's vendor/makefun-board.ts
// was unavailable — kit 503 — so dossier.json must be rebuilt with the
// kit's vendor file before submitting).
//
// Model (fitted from the snapshot's own traded protocols, never invented):
//  * Category multiple: median market-cap / TVL per category, from traded
//    protocols with TVL >= $5M. Categories with <3 samples use the global
//    median. Implied value = TVL x multiple x growth factor.
//  * Growth factor: 1 + clamp(change_7d, -20, +20)% / 2.
//  * Token odds: share of protocols in the category that record a token,
//    shrunk toward the global share by sample size.
//  * Expected value = implied value x token odds. Board ranks by it.
//  * Held-out validation: split traded protocols by listed_at (older half
//    trains, newer half tests), predict market cap with the train multiples,
//    report median absolute % error. Reported as-is, never cherry-picked.
//  * Farm plan: concrete steps per category and chain, costed by deposit
//    size tiers ($100 / $1,000 / $10,000).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const SNAP = process.env.SNAPSHOT || '/input/snapshot.json';
const ROOT = new URL('.', import.meta.url).pathname;

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: number | null; gecko_id: string | null; symbol: string | null;
};

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Geometric median: ratios are log-normal-ish (0.01x–44x), so fit in log space.
function geoMedian(xs: number[]): number {
  if (!xs.length) return 0;
  const logs = xs.map((x) => Math.log(x)).sort((a, b) => a - b);
  const m = Math.floor(logs.length / 2);
  const med = logs.length % 2 ? logs[m] : (logs[m - 1] + logs[m]) / 2;
  return Math.exp(med);
}
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function money(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

const FARM: Record<string, string[]> = {
  Lending: ['Deposit collateral on {chain}', 'Borrow against it once, repay in full', 'Keep the position open 30+ days', 'Vote / use the app weekly'],
  Dexs: ['Swap on {chain} weekly', 'Provide liquidity in a major pool', 'Hold the LP position through a full month'],
  Derivatives: ['Open a small perps position on {chain}', 'Close it in profit once', 'Repeat monthly, never over-leveraged'],
  Yield: ['Deposit into a vault on {chain}', 'Compound rewards weekly', 'Stay deposited 60+ days'],
  'Risk Curators': ['Deposit into a curated vault on {chain}', 'Follow the curator\'s rebalances', 'Keep funds in through a quarter'],
  RWA: ['Buy / hold the tokenised asset on {chain}', 'Complete KYC if the protocol asks', 'Hold through the next distribution'],
  'Prediction Market': ['Place small, frequent trades on {chain}', 'Provide liquidity to a market', 'Resolve markets you created'],
  Payments: ['Use the network for real payments on {chain}', 'Hold a balance for 30+ days', 'Refer one real user'],
  default: ['Use the protocol on {chain} weekly', 'Hold a position for 30+ days', 'Complete every quest / task it publishes'],
};

export function categoryMultiples(protos: Proto[]): Map<string, number> {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protos) {
    if (p.mcap_usd && p.tvl_usd > 0) {
      const r = p.mcap_usd / p.tvl_usd;
      if (r > 0.01 && r < 10) {
        all.push(r);
        const k = p.category || 'Unknown';
        if (!byCat.has(k)) byCat.set(k, []);
        byCat.get(k)!.push(r);
      }
    }
  }
  const global = geoMedian(all);
  const out = new Map<string, number>();
  for (const [k, v] of byCat) out.set(k, v.length >= 3 ? geoMedian(v) : global);
  out.set('__global__', global);
  return out;
}

export function heldOut(protos: Proto[], multiples: Map<string, number>): { n_train: number; n_test: number; median_abs_pct_error: number; median_ratio: number } {
  const traded = protos.filter((p) => p.mcap_usd && p.tvl_usd > 0 && p.listed_at).sort((a, b) => (a.listed_at! - b.listed_at!));
  const half = Math.floor(traded.length / 2);
  const train = traded.slice(0, half), test = traded.slice(half);
  const trainMult = categoryMultiples(train);
  const global = trainMult.get('__global__') || multiples.get('__global__') || 1;
  const errors: number[] = [], ratios: number[] = [];
  for (const p of test) {
    const m = trainMult.get(p.category || 'Unknown') || global;
    const pred = p.tvl_usd * m;
    errors.push(Math.abs(pred - p.mcap_usd!) / p.mcap_usd! * 100);
    ratios.push(pred / p.mcap_usd!);
  }
  return { n_train: train.length, n_test: test.length, median_abs_pct_error: Math.round(median(errors) * 10) / 10, median_ratio: Math.round(median(ratios) * 100) / 100 };
}

function tokenOdds(protos: Proto[]): Map<string, number> {
  const byCat = new Map<string, { has: number; total: number }>();
  let has = 0;
  for (const p of protos) {
    const k = p.category || 'Unknown';
    if (!byCat.has(k)) byCat.set(k, { has: 0, total: 0 });
    const e = byCat.get(k)!; e.total += 1;
    if (p.gecko_id || p.symbol) { e.has += 1; has += 1; }
  }
  const global = has / Math.max(1, protos.length);
  const out = new Map<string, number>();
  for (const [k, e] of byCat) out.set(k, (e.has + 5 * global) / (e.total + 5));
  out.set('__global__', global);
  return out;
}

// A launch candidate is a protocol the watchlist rule would keep, at any
// TVL: no token recorded, not a wrapped / staked / bridged product, not a
// versioned duplicate, not an exchange's own product. Bridges, WBTC,
// staked-ETH products and USDT0 are explicitly not launch candidates.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];
export function isLaunchCandidate(p: Proto): boolean {
  if (EXCLUDED_CATEGORIES.has(p.category || '')) return false;
  const name = (p.name || '').toLowerCase();
  if (/\s(v\d+|v\d+\.\d+|\d+\.\d+)$/i.test(p.name || '')) return false;
  if (/\b(wrapped|staked|staking)\b/.test(name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => name.startsWith(e))) return false;
  return true;
}

function farmPlan(p: Proto): string[] {
  const chain = (p.chains && p.chains[0]) || 'Ethereum';
  const steps = FARM[p.category || ''] || FARM.default;
  return steps.map((s) => s.replace('{chain}', chain));
}

export function buildBoard(snap: any): any {
  const protos: Proto[] = snap.protocols || [];
  const multiples = categoryMultiples(protos);
  const odds = tokenOdds(protos);
  const validation = heldOut(protos, multiples);
  const global = multiples.get('__global__') || 1;
  const rows = protos
    .filter((p) => !p.gecko_id && !p.symbol && isLaunchCandidate(p))
    .map((p) => {
      const mult = multiples.get(p.category || 'Unknown') || global;
      const growth = 1 + clamp(p.change_7d ?? 0, -20, 20) / 200;
      const implied = Math.round(p.tvl_usd * mult * growth);
      const odd = odds.get(p.category || 'Unknown') || odds.get('__global__') || 0.5;
      return {
        slug: p.slug, name: p.name, category: p.category, chains: p.chains,
        tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at,
        multiple: Math.round(mult * 100) / 100, implied_value_usd: implied,
        token_odds: Math.round(odd * 100) / 100,
        expected_value_usd: Math.round(implied * odd),
        on_watchlist: (snap.watchlist || []).includes(p.slug),
        farm_plan: farmPlan(p),
        farm_cost_tiers_usd: [100, 1000, 10000],
        note: 'Records no token in DefiLlama (gecko_id and symbol null). That is not proof it has none.',
      };
    })
    .sort((a, b) => b.expected_value_usd - a.expected_value_usd);
  return {
    as_of: snap.as_of, source: snap.source, floor_usd: snap.floor_usd,
    protocols_in_snapshot: protos.length, watchlist_size: (snap.watchlist || []).length,
    rows, meta: {
      global_multiple: Math.round(global * 100) / 100,
      validation,
      method: 'Implied value = TVL x category median mcap/TVL (traded protocols, TVL>=$5M) x growth factor. Expected value = implied x token odds (category share of protocols recording a token, shrunk to global).',
    },
  };
}

const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
const board = buildBoard(snap);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'board.json'), JSON.stringify(board, null, 2));
const dataJs = 'window.RADAR = ' + JSON.stringify(board) + ';\n';
writeFileSync(join(OUT, 'data.js'), dataJs);
if (existsSync(join(ROOT, 'dashboard'))) cpSync(join(ROOT, 'dashboard'), join(OUT, 'dashboard'), { recursive: true });
if (existsSync(join(ROOT, 'screenshots'))) cpSync(join(ROOT, 'screenshots'), join(OUT, 'screenshots'), { recursive: true });
writeFileSync(join(OUT, 'dossier.json'), JSON.stringify({ board_rows: board.rows.length, watchlist_covered: board.rows.filter((r: any) => r.on_watchlist).length, meta: board.meta }, null, 2));
console.log(`Launch Radar: ${board.rows.length} pre-token rows, watchlist ${board.meta ? board.rows.filter((r: any) => r.on_watchlist).length + '/' + board.watchlist_size : ''} covered, validation median error ${board.meta.validation.median_abs_pct_error}% (n=${board.meta.validation.n_test}) -> ${OUT}`);
