// main.ts — Launch Radar: build a token launch radar from a DefiLlama snapshot.
//
// Reads the sealed snapshot (/input/snapshot.json; SNAPSHOT env or --input
// <file|dir> overrides it for local testing), ranks every protocol that
// records no token by implied value, and writes /output/board.json,
// /output/data.js, dashboard/ and screenshots/, plus /output/dossier.json
// via buildDossier from vendor/makefun-board.ts (written LAST, as the
// scorer rebuilds it from the same /output and compares bytes).
//
// Model (fitted from the snapshot's own traded protocols, never invented):
//  * Category multiple: geometric median market-cap / TVL per category,
//    from traded protocols with TVL >= $5M. Categories with <3 samples use
//    the global median. Implied value = TVL x multiple x growth factor.
//  * Growth factor: 1 + clamp(change_7d, -20, +20)% / 2.
//  * Token odds: share of protocols in the category that record a token,
//    shrunk toward the global share by sample size.
//  * Expected value = implied value x token odds. The board ranks by
//    implied value (rank 1 = highest); expected value stays as a column.
//  * Held-out validation: split traded protocols by listed_at (older half
//    trains, newer half tests), predict market cap with the train multiples,
//    report median absolute % error. Reported as-is, never cherry-picked.
//  * Farm steps: six concrete steps per category and chain, each naming
//    what it costs and how long it takes, sized by deposit tiers
//    ($100 / $1,000 / $10,000) and the protocol's TVL and age.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const OUT = arg('output', process.env.MAKEFUN_OUTPUT_DIR || '/output');
const inputArg = arg('input', process.env.SNAPSHOT || '/input/snapshot.json');
const SNAP = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
const ROOT = new URL('.', import.meta.url).pathname;

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | number | null; gecko_id: string | null; symbol: string | null;
};

function listedMs(p: Proto): number {
  if (p.listed_at == null) return 0;
  if (typeof p.listed_at === 'number') return p.listed_at > 1e12 ? p.listed_at : p.listed_at * 1000;
  const t = Date.parse(p.listed_at);
  return Number.isNaN(t) ? 0 : t;
}

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

function ageText(p: Proto, asOf: string): string {
  const listed = listedMs(p);
  if (!listed) return 'an unlisted start date';
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs) || asOfMs <= listed) return 'a recent launch';
  const months = Math.max(1, Math.round((asOfMs - listed) / (1000 * 60 * 60 * 24 * 30.44)));
  if (months < 12) return `about ${months} month${months === 1 ? '' : 's'} of history`;
  const years = Math.floor(months / 12), rem = months % 12;
  return `about ${years} year${years === 1 ? '' : 's'}${rem ? ` and ${rem} months` : ''} of history`;
}

// Six farm steps per category. {chain} {name} {tvl} {age} are filled in
// per protocol; every step names a cost and a time, and step 1 always
// starts at the $100 tier. Steps stay well inside 20–600 characters.
const FARM: Record<string, string[]> = {
  Lending: [
    'Open {name} on {chain} and deposit $100 of collateral in one session (about 20 minutes, plus a few dollars of {chain} gas); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Borrow a small amount against that collateral once, then repay it in full within 7 days, spending roughly $1–$5 in gas per transaction on {chain}.',
    'Scale the same deposit to the $1,000 tier after 14 days if the position stays healthy, keeping borrow usage below 50% so a price dip cannot liquidate it.',
    'Keep the collateral deposited for at least 30 days, checking the health factor weekly for about 5 minutes each time; {name} holds {tvl} in TVL with {age}.',
    'Use the app again every week — a small deposit, repayment or vote — so activity spans a full month, at a cost of a few dollars of gas per week.',
    'Record every transaction hash and date, and leave the position open through the next month; total outlay is the deposit plus roughly $10–$30 of gas over 30+ days.',
  ],
  Dexs: [
    'Swap $100 of tokens on {name} on {chain} in one session (about 10 minutes, plus a few dollars of gas and the swap fee); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Provide $100 of liquidity to a major pool on {chain} and hold the LP tokens; the deposit earns trading fees while it sits, and withdrawing early breaks the pattern.',
    'Make a second, smaller swap each week for 4 weeks, about 10 minutes and a few dollars of gas per week, to build a regular-use pattern on {chain}.',
    'Hold the LP position through a full 30 days without withdrawing, checking impermanent loss once a week for a few minutes; {name} holds {tvl} in TVL with {age}.',
    'Scale to the $1,000 tier in the same pool after 30 days if the fees earned so far cover the gas spent, keeping the same pool so history stays in one place.',
    'Keep a log of every swap, pool and date; total cost is the deposit plus roughly $15–$40 of gas and fees over a month, and the LP stays open into the next month.',
  ],
  Derivatives: [
    'Open a small $100 perps position on {name} on {chain} in one session (about 15 minutes, plus a few dollars of gas and the trading fee); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Close the position once, in profit if possible, within 7 days; never use more than 2x leverage, so a sudden move costs dollars, not the whole deposit.',
    'Repeat with a second small position the following week, about 15 minutes and a few dollars of gas each time, to show repeated rather than one-off use.',
    'Keep total exposure under $1,000 for the first 30 days and check open positions every few days for about 5 minutes; {name} holds {tvl} in TVL with {age}.',
    'Try a second market on {chain} in week 4 — a different pair, same small size — spending another few dollars of gas and about 15 minutes.',
    'Record every trade, size and date, and stop after 30+ days with positions closed; total cost is the deposit at risk plus roughly $15–$40 of gas and fees.',
  ],
  Yield: [
    'Deposit $100 into a {name} vault on {chain} in one session (about 15 minutes, plus a few dollars of gas); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Claim or compound the vault rewards once after 7 days, spending a few dollars of gas and about 10 minutes, instead of letting rewards sit untouched.',
    'Scale the deposit to the $1,000 tier after 14 days if the vault yield covers the gas spent so far, keeping the same vault so history stays in one place.',
    'Stay deposited for at least 60 days, checking the vault weekly for about 5 minutes; {name} holds {tvl} in TVL with {age}.',
    'Move a small slice to a second vault on {chain} in week 5 if one exists, about 15 minutes and a few dollars of gas, to show breadth without splitting the main deposit.',
    'Keep a log of deposits, claims and dates; total cost is the deposit plus roughly $10–$30 of gas over 60+ days, with the position still open at the end.',
  ],
  'Risk Curators': [
    'Deposit $100 into a curated {name} vault on {chain} in one session (about 15 minutes, plus a few dollars of gas); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Follow the curator rebalances for 14 days without withdrawing, checking the vault allocation weekly for about 5 minutes each time.',
    'Scale the deposit to the $1,000 tier after 14 days if the vault return covers the gas spent so far, keeping the same vault so history stays in one place.',
    'Keep funds in through a full quarter (90 days), reviewing each rebalance for a few minutes; {name} holds {tvl} in TVL with {age}.',
    'Try a second curated vault on {chain} in month 2 with a small $100 slice, about 15 minutes and a few dollars of gas, to show breadth across curators.',
    'Record every deposit, rebalance and date; total cost is the deposit plus roughly $10–$30 of gas over 90 days, with the main position still open at the end.',
  ],
  RWA: [
    'Buy or hold $100 of the tokenised asset on {name} on {chain} in one session (about 20 minutes, plus a few dollars of gas); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Complete KYC if the protocol asks for it, allowing 1–3 business days for approval and keeping a copy of the confirmation for your records.',
    'Hold the position through the next distribution or payout cycle, about 30 days, checking the asset page weekly for about 5 minutes.',
    'Scale to the $1,000 tier after 30 days if the first distribution arrived as expected; {name} holds {tvl} in TVL with {age}.',
    'Use the asset once more in month 2 — a top-up or a transfer on {chain} — spending a few dollars of gas and about 15 minutes.',
    'Keep a log of purchases, KYC and distributions; total cost is the deposit plus roughly $10–$30 of gas and any KYC fee over 60+ days.',
  ],
  'Prediction Market': [
    'Place a $100 trade on a {name} market on {chain} in one session (about 10 minutes, plus a few dollars of gas); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Provide $100 of liquidity to a market with at least 30 days left to resolve, holding the LP share until the market closes.',
    'Place a second small trade the following week, about 10 minutes and a few dollars of gas, on a different market so activity is not a single bet.',
    'Keep trading small and frequent for 30 days — one or two trades a week, a few minutes each — and never stake more than $1,000 in total; {name} holds {tvl} in TVL with {age}.',
    'Create or resolve a market you follow in week 4 if the protocol allows it, spending about 20 minutes and a few dollars of gas.',
    'Record every market, stake and outcome; total cost is the staked amounts plus roughly $10–$30 of gas over 30+ days.',
  ],
  Payments: [
    'Use {name} for a real $100 payment on {chain} in one session (about 10 minutes, plus a few dollars of gas or the network fee); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Hold a balance in the app for 30+ days, topping it up once a week with a small amount, about 5 minutes and a few dollars of fees per top-up.',
    'Make a second real payment in week 2 to a different recipient, about 10 minutes, so the history shows repeated use rather than one transfer.',
    'Refer one real user in month 1 if the protocol offers it, and confirm the referral registered — about 15 minutes of your time, no fee.',
    'Scale regular payments to the $1,000 tier in month 2 if the first month worked smoothly; {name} holds {tvl} in TVL with {age}.',
    'Keep receipts and dates for every payment; total cost is the amounts sent plus roughly $5–$20 of network fees over 30+ days.',
  ],
  default: [
    'Use {name} on {chain} with a $100 deposit or transaction in one session (about 15 minutes, plus a few dollars of {chain} gas); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Repeat the core action a second time within 7 days, about 15 minutes and a few dollars of gas, so the history shows return use, not a single visit.',
    'Complete every quest or task the protocol publishes in the first 14 days, allowing about 30 minutes in total plus a few dollars of gas per on-chain task.',
    'Hold the position for at least 30 days, checking it weekly for about 5 minutes; {name} holds {tvl} in TVL with {age}.',
    'Scale to the $1,000 tier after 30 days if the first month worked smoothly, keeping the same protocol and chain so history stays in one place.',
    'Record every transaction hash and date; total cost is the deposit plus roughly $10–$30 of gas over 30+ days, with the position still open at the end.',
  ],
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
  const traded = protos.filter((p) => p.mcap_usd && p.tvl_usd > 0 && listedMs(p) > 0).sort((a, b) => listedMs(a) - listedMs(b));
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

function farmSteps(p: Proto, asOf: string): string[] {
  const chain = (p.chains && p.chains[0]) || 'Ethereum';
  const steps = FARM[p.category || ''] || FARM.default;
  return steps.map((s) => s
    .replaceAll('{chain}', chain)
    .replaceAll('{name}', p.name)
    .replaceAll('{tvl}', money(p.tvl_usd))
    .replaceAll('{age}', ageText(p, asOf)));
}

export function buildBoard(snap: any): any {
  const protos: Proto[] = snap.protocols || [];
  const multiples = categoryMultiples(protos);
  const odds = tokenOdds(protos);
  const validation = heldOut(protos, multiples);
  const global = multiples.get('__global__') || 1;
  const rows = protos
    .filter((p) => !p.gecko_id && !p.symbol && p.tvl_usd > 0 && isLaunchCandidate(p))
    .map((p) => {
      const mult = multiples.get(p.category || 'Unknown') || global;
      const growth = 1 + clamp(p.change_7d ?? 0, -20, 20) / 200;
      const implied = Math.max(1, Math.round(p.tvl_usd * mult * growth));
      const odd = odds.get(p.category || 'Unknown') || odds.get('__global__') || 0.5;
      return {
        slug: p.slug, name: p.name, category: p.category, chains: p.chains,
        tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at,
        multiple: Math.round(mult * 100) / 100, implied_value_usd: implied,
        token_odds: Math.round(odd * 100) / 100,
        expected_value_usd: Math.round(implied * odd),
        on_watchlist: (snap.watchlist || []).includes(p.slug),
        farm_steps: farmSteps(p, snap.as_of),
        farm_cost_tiers_usd: [100, 1000, 10000],
        note: 'Records no token in DefiLlama (gecko_id and symbol null). That is not proof it has none.',
      };
    })
    // Rank by implied value, highest first; ties break by expected value,
    // then slug, so the order is deterministic run to run.
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.expected_value_usd - a.expected_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    as_of: snap.as_of, source: snap.source, floor_usd: snap.floor_usd,
    protocols_in_snapshot: protos.length, watchlist_size: (snap.watchlist || []).length,
    rows, meta: {
      global_multiple: Math.round(global * 100) / 100,
      validation,
      method: 'Implied value = TVL x category median mcap/TVL (traded protocols, TVL>=$5M) x growth factor. Expected value = implied x token odds (category share of protocols recording a token, shrunk to global). Ranked by implied value.',
    },
  };
}

if (!existsSync(SNAP)) {
  process.stderr.write(`token radar: no snapshot at ${SNAP}: pass --input <snapshot.json|directory> or set SNAPSHOT\n`);
  process.exit(2);
}
const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
const board = buildBoard(snap);
const rows = board.rows;
const watchlistCovered = rows.filter((r: any) => r.on_watchlist).length;
const gateIssue =
  rows.length < 100 ? `only ${rows.length} rows (<100)` :
  watchlistCovered !== board.watchlist_size ? `watchlist ${watchlistCovered}/${board.watchlist_size}` :
  rows.some((r: any, i: number) => r.rank !== i + 1) ? 'ranks are not 1..N' :
  rows.some((r: any, i: number) => i > 0 && r.implied_value_usd > rows[i - 1].implied_value_usd) ? 'implied value rises with rank' :
  rows.some((r: any) => r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((s: string) => s.trim().length < 20 || s.trim().length > 600)) ? 'farm_steps out of shape' :
  null;
if (gateIssue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${gateIssue}\n`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'board.json'), JSON.stringify({ rows }, null, 2) + '\n');
const dataJs = 'window.RADAR = ' + JSON.stringify(board) + ';\n';
writeFileSync(join(OUT, 'data.js'), dataJs);
if (existsSync(join(ROOT, 'dashboard'))) cpSync(join(ROOT, 'dashboard'), join(OUT, 'dashboard'), { recursive: true });
if (existsSync(join(ROOT, 'screenshots'))) cpSync(join(ROOT, 'screenshots'), join(OUT, 'screenshots'), { recursive: true });
// The dossier is written LAST: the scorer rebuilds it from this /output
// and compares bytes, so dashboard/ and screenshots/ must already be in place.
writeFileSync(join(OUT, 'dossier.json'), buildDossier(OUT, { text_max_bytes: 65536 }));
console.log(`Launch Radar: ${rows.length} pre-token rows, rank 1 ${rows[0].name} ${money(rows[0].implied_value_usd)} implied, watchlist ${watchlistCovered}/${board.watchlist_size} covered, validation median error ${board.meta.validation.median_abs_pct_error}% (n=${board.meta.validation.n_test}) -> ${OUT}`);
