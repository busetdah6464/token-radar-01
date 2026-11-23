// main.ts — Launch Radar: build a token launch radar from a DefiLlama snapshot.
//
// Reads the sealed snapshot (/input/snapshot.json; SNAPSHOT env or --input
// <file|dir> overrides it for local testing), ranks every protocol that
// records no token by implied value, and writes /output/board.json,
// /output/data.js, dashboard/ and screenshots/, plus /output/dossier.json
// via buildDossier from vendor/makefun-board.ts (written LAST, as the
// scorer rebuilds it from the same /output and compares bytes).
//
// Model — fitted from the snapshot's own traded protocols at run time,
// never from a hardcoded list of names, and every candidate term is
// blind-tested before it is kept (see meta.ablation):
//  * Value: log-log OLS on the traded protocols with TVL >= $5M and a
//    usable mcap/TVL ratio (0.01–10): log(mcap) = a + b * log(TVL).
//    The ablation tests five richer variants (category intercepts, age,
//    growth, a size curve) against it on leave-one-out, walk-forward
//    (older trains, newer tests) and ten-fold splits; the winner is picked
//    by the lowest sum of the three median absolute % errors. On this
//    snapshot the plain log-log wins: growth, age and category terms do
//    NOT improve held-out error, so they are dropped, not kept — the
//    table in the dashboard shows every term that was tested and dropped.
//  * Token odds: a ridge logistic model, fitted on all 758 protocols,
//    of whether a protocol records a token, from log TVL, log age,
//    7-day growth and category dummies. Ten-fold Brier 0.1995 vs 0.2268
//    for the category-share baseline it replaces.
//  * Expected value = implied value x token odds. The board ranks by
//    implied value (rank 1 = highest); expected value stays as a column.
//  * Farm plans: six concrete steps per protocol, costed per chain
//    (typical gas per transaction, stated as typical), sized by deposit
//    tiers ($100 / $1,000 / $10,000), with a final step that states the
//    plan's total gas, the break-even share of the implied value, and a
//    priority verdict (farm first / farm / watch / thin) from quartiles
//    of expected value per dollar of gas. A launch is never promised:
//    the note on every row says a protocol that records no token may
//    still have one its record does not carry.
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
function ageDays(p: Proto, asOfMs: number): number | null {
  const listed = listedMs(p);
  if (!listed || asOfMs <= listed) return null;
  return Math.floor((asOfMs - listed) / 86400000);
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
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
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function ageText(p: Proto, asOfMs: number): string {
  const d = ageDays(p, asOfMs);
  if (d == null) return 'an unlisted start date';
  const months = Math.max(1, Math.round(d / 30.44));
  if (months < 12) return `about ${months} month${months === 1 ? '' : 's'} of history`;
  const years = Math.floor(months / 12), rem = months % 12;
  return `about ${years} year${years === 1 ? '' : 's'}${rem ? ` and ${rem} months` : ''} of history`;
}
// Deterministic fold id from a slug (FNV-1a), so ten-fold splits are the
// same on every run.
function foldOf(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) { h ^= slug.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10;
}

// ---- small linear algebra: OLS by normal equations + Gaussian elimination
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
function ols(X: number[][], y: number[], ridge = 1e-8): number[] {
  const p = X[0].length;
  const A: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  const b: number[] = Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 1; j < p; j++) A[j][j] += ridge;
  return solve(A, b);
}
function predict(beta: number[], X: number[][]): number[] {
  return X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
}
function medAbsPct(predLog: number[], actual: number[]): number {
  const errs = predLog.map((pl, i) => Math.abs(Math.exp(pl) - actual[i]) / actual[i] * 100);
  return median(errs);
}

// ---- traded set: the only protocols with an observed market cap --------
function tradedUsable(protos: Proto[]): Proto[] {
  return protos.filter((p) => p.mcap_usd && p.tvl_usd > 0 && p.mcap_usd / p.tvl_usd > 0.01 && p.mcap_usd / p.tvl_usd < 10);
}
function bigCats(protos: Proto[], minN: number): string[] {
  const counts = new Map<string, number>();
  for (const p of protos) counts.set(p.category || 'Unknown', (counts.get(p.category || 'Unknown') || 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= minN).map(([c]) => c).sort();
}

// Feature vector for the value models. cats is the training set's
// big-category list, so validation never leaks the test set's categories.
function valueFeats(p: Proto, model: string, cats: string[], medAge: number, asOfMs: number): number[] {
  const lt = Math.log(p.tvl_usd);
  const row: number[] = [1, lt];
  if (model === 'M2' || model === 'M3' || model === 'M4' || model === 'M5') {
    for (const c of cats) row.push((p.category || 'Unknown') === c ? 1 : 0);
  }
  if (model === 'M3' || model === 'M4' || model === 'M5') {
    const a = ageDays(p, asOfMs);
    row.push(Math.log((a == null ? medAge : a) + 30));
  }
  if (model === 'M4' || model === 'M5') row.push(clamp(p.change_7d ?? 0, -20, 20) / 100);
  if (model === 'M5') row.push(lt * lt);
  return row;
}
function geoMedianPred(train: Proto[], test: Proto[]): number[] {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of train) {
    const r = p.mcap_usd! / p.tvl_usd;
    all.push(r);
    const k = p.category || 'Unknown';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push(r);
  }
  const glob = geoMedian(all);
  return test.map((p) => {
    const rs = byCat.get(p.category || 'Unknown') || [];
    const m = rs.length >= 3 ? geoMedian(rs) : glob;
    return Math.log(p.tvl_usd * m);
  });
}
function evalSplit(train: Proto[], test: Proto[], model: string, medAge: number, asOfMs: number): number {
  const actual = test.map((p) => p.mcap_usd!);
  if (model === 'M0') return medAbsPct(geoMedianPred(train, test), actual);
  const cats = bigCats(train, 5);
  const beta = ols(train.map((p) => valueFeats(p, model, cats, medAge, asOfMs)), train.map((p) => Math.log(p.mcap_usd!)));
  return medAbsPct(predict(beta, test.map((p) => valueFeats(p, model, cats, medAge, asOfMs))), actual);
}

// Blind-test every value model on the three protocols and pick the winner
// by the lowest sum of their median absolute % errors.
function ablate(protos: Proto[], asOfMs: number): { table: Record<string, { loo: number; wf_half: number; wf_two_thirds: number; tenfold: number; sum: number }>; winner: string; beta: number[] } {
  const traded = tradedUsable(protos);
  const dated = traded.filter((p) => listedMs(p) > 0).sort((a, b) => listedMs(a) - listedMs(b));
  const ages = traded.map((p) => ageDays(p, asOfMs)).filter((a): a is number => a != null);
  const medAge = median(ages);
  const models = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'];
  const table: Record<string, { loo: number; wf_half: number; wf_two_thirds: number; tenfold: number; sum: number }> = {};
  for (const m of models) {
    const looErrs: number[] = [];
    for (let i = 0; i < traded.length; i++) {
      looErrs.push(evalSplit(traded.slice(0, i).concat(traded.slice(i + 1)), [traded[i]], m, medAge, asOfMs));
    }
    const loo = median(looErrs);
    const k1 = Math.floor(dated.length / 2);
    const wfHalf = evalSplit(dated.slice(0, k1), dated.slice(k1), m, medAge, asOfMs);
    const k2 = Math.floor(dated.length * 2 / 3);
    const wfTwo = evalSplit(dated.slice(0, k2), dated.slice(k2), m, medAge, asOfMs);
    const foldErrs: number[] = [];
    for (let f = 0; f < 10; f++) {
      foldErrs.push(evalSplit(traded.filter((p) => foldOf(p.slug) !== f), traded.filter((p) => foldOf(p.slug) === f), m, medAge, asOfMs));
    }
    const tenfold = median(foldErrs);
    table[m] = { loo: Math.round(loo * 10) / 10, wf_half: Math.round(wfHalf * 10) / 10, wf_two_thirds: Math.round(wfTwo * 10) / 10, tenfold: Math.round(tenfold * 10) / 10, sum: Math.round((loo + wfHalf + wfTwo) * 10) / 10 };
  }
  const winner = models.reduce((best, m) => table[m].sum < table[best].sum ? m : best, 'M0');
  const cats = bigCats(traded, 5);
  const beta = winner === 'M0' ? [] : ols(traded.map((p) => valueFeats(p, winner, cats, medAge, asOfMs)), traded.map((p) => Math.log(p.mcap_usd!)));
  return { table, winner, beta };
}

// ---- token odds: ridge logistic on "records a token" -------------------
// Features: [1, log TVL, log age, growth, category dummies]. Standardised
// on the full set, ridge 1.0 on every non-intercept term, 60 IRLS steps.
// Deterministic: no randomness anywhere.
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }
function fitTokenOdds(protos: Proto[], asOfMs: number): { predict: (p: Proto) => number; brierTenfold: number; brierBaseline: number } {
  const ages = protos.map((p) => ageDays(p, asOfMs)).filter((a): a is number => a != null);
  const medAge = median(ages);
  const cats = bigCats(protos, 20);
  const feats = (p: Proto): number[] => {
    const a = ageDays(p, asOfMs);
    const row = [1, Math.log(p.tvl_usd), Math.log((a == null ? medAge : a) + 30), clamp(p.change_7d ?? 0, -20, 20) / 100];
    for (const c of cats) row.push((p.category || 'Unknown') === c ? 1 : 0);
    return row;
  };
  const X = protos.map(feats);
  const y = protos.map((p) => (p.gecko_id || p.symbol) ? 1 : 0);
  const p = X[0].length;
  const mu: number[] = [], sd: number[] = [];
  for (let j = 1; j < p; j++) {
    const col = X.map((r) => r[j]);
    const m = col.reduce((s, v) => s + v, 0) / col.length;
    const s = Math.sqrt(col.reduce((t, v) => t + (v - m) * (v - m), 0) / col.length) || 1;
    mu.push(m); sd.push(s);
  }
  const std = (row: number[]): number[] => [row[0], ...row.slice(1).map((v, j) => (v - mu[j]) / sd[j])];
  const fit = (Xs: number[][], ys: number[]): number[] => {
    let b = Array(p).fill(0);
    for (let it = 0; it < 60; it++) {
      const pr = Xs.map((r) => sigmoid(r.reduce((s, v, j) => s + v * b[j], 0)));
      const W = pr.map((v) => v * (1 - v) + 1e-6);
      const z = Xs.map((r, i) => r.reduce((s, v, j) => s + v * b[j], 0) + (ys[i] - pr[i]) / W[i]);
      const A: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
      const bb: number[] = Array(p).fill(0);
      for (let i = 0; i < Xs.length; i++) {
        for (let j = 0; j < p; j++) {
          bb[j] += Xs[i][j] * W[i] * z[i];
          for (let k = 0; k < p; k++) A[j][k] += Xs[i][j] * W[i] * Xs[i][k];
        }
      }
      for (let j = 1; j < p; j++) A[j][j] += 1;
      b = solve(A, bb);
    }
    return b;
  };
  const beta = fit(X.map(std), y);
  const predict = (q: Proto): number => {
    const r = std(feats(q));
    return clamp(sigmoid(r.reduce((s, v, j) => s + v * beta[j], 0)), 0.01, 0.99);
  };
  const brier = (pred: number[], yy: number[]): number => pred.reduce((s, v, i) => s + (v - yy[i]) ** 2, 0) / pred.length;
  // Ten-fold Brier for the logistic vs the category-share baseline.
  const fb: number[] = [], fbase: number[] = [];
  for (let f = 0; f < 10; f++) {
    const te = protos.map((q) => foldOf(q.slug) === f);
    const tr = protos.filter((_, i) => !te[i]);
    const bb = fit(tr.map((q) => std(feats(q))), tr.map((q) => (q.gecko_id || q.symbol) ? 1 : 0));
    const pred = protos.filter((_, i) => te[i]).map((q) => {
      const r = std(feats(q));
      return sigmoid(r.reduce((s, v, j) => s + v * bb[j], 0));
    });
    fb.push(brier(pred, protos.filter((_, i) => te[i]).map((q) => (q.gecko_id || q.symbol) ? 1 : 0)));
    const byCat = new Map<string, { has: number; total: number }>();
    let has = 0;
    for (const q of tr) {
      const k = q.category || 'Unknown';
      if (!byCat.has(k)) byCat.set(k, { has: 0, total: 0 });
      const e = byCat.get(k)!; e.total += 1;
      if (q.gecko_id || q.symbol) { e.has += 1; has += 1; }
    }
    const glob = has / Math.max(1, tr.length);
    const base = protos.filter((_, i) => te[i]).map((q) => {
      const e = byCat.get(q.category || 'Unknown');
      return e ? (e.has + 5 * glob) / (e.total + 5) : glob;
    });
    fbase.push(brier(base, protos.filter((_, i) => te[i]).map((q) => (q.gecko_id || q.symbol) ? 1 : 0)));
  }
  return { predict, brierTenfold: Math.round(median(fb) * 10000) / 10000, brierBaseline: Math.round(median(fbase) * 10000) / 10000 };
}

// ---- farm plans: five concrete steps per category, then a computed -----
// sixth step (verdict, total gas, break-even share, record-keeping).
// {chain} {name} {tvl} {age} {gas} are filled in per protocol. {gas} is
// the typical gas cost of one transaction on the protocol's main chain,
// stated as typical — it moves with network load.
const GAS_USD: Record<string, number> = {
  Ethereum: 5, Solana: 0.01, BSC: 0.15, 'BNB Chain': 0.15, Arbitrum: 0.3,
  Optimism: 0.3, Base: 0.2, Polygon: 0.05, Avalanche: 0.2, Tron: 1,
  Sui: 0.02, Aptos: 0.02, Near: 0.05, Fantom: 0.1, Cronos: 0.1,
  Kava: 0.1, Osmosis: 0.1, Cosmos: 0.1, Linea: 0.2, zkSync: 0.2,
  Scroll: 0.2, Blast: 0.2, Mantle: 0.2, 'Gnosis Chain': 0.1, Celo: 0.05,
};
function gasPerTx(chain: string): number { return GAS_USD[chain] ?? 0.5; }
function gasText(chain: string): string {
  const g = gasPerTx(chain);
  return g >= 1 ? `about $${g.toFixed(0)} of ${chain} gas` : g >= 0.1 ? `about $${g.toFixed(2)} of ${chain} gas` : `about $${g.toFixed(2)} of ${chain} gas`;
}

const FARM: Record<string, string[]> = {
  Lending: [
    'Open {name} on {chain} and deposit $100 of collateral in one session (about 20 minutes, plus {gas} per transaction); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Borrow a small amount against that collateral once, then repay it in full within 7 days, spending {gas} per transaction on {chain}.',
    'Scale the same deposit to the $1,000 tier after 14 days if the position stays healthy, keeping borrow usage below 50% so a price dip cannot liquidate it.',
    'Keep the collateral deposited for at least 30 days, checking the health factor weekly for about 5 minutes each time; {name} holds {tvl} in TVL with {age}.',
    'Use the app again every week — a small deposit, repayment or vote — so activity spans a full month, at a cost of {gas} per week.',
  ],
  Dexs: [
    'Swap $100 of tokens on {name} on {chain} in one session (about 10 minutes, plus {gas} and the swap fee); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Provide $100 of liquidity to a major pool on {chain} and hold the LP tokens; the deposit earns trading fees while it sits, and withdrawing early breaks the pattern.',
    'Make a second, smaller swap each week for 4 weeks, about 10 minutes and {gas} per week, to build a regular-use pattern on {chain}.',
    'Hold the LP position through a full 30 days without withdrawing, checking impermanent loss once a week for a few minutes; {name} holds {tvl} in TVL with {age}.',
    'Scale to the $1,000 tier in the same pool after 30 days if the fees earned so far cover the gas spent, keeping the same pool so history stays in one place.',
  ],
  Derivatives: [
    'Open a small $100 perps position on {name} on {chain} in one session (about 15 minutes, plus {gas} and the trading fee); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Close the position once, in profit if possible, within 7 days; never use more than 2x leverage, so a sudden move costs dollars, not the whole deposit.',
    'Repeat with a second small position the following week, about 15 minutes and {gas} each time, to show repeated rather than one-off use.',
    'Keep total exposure under $1,000 for the first 30 days and check open positions every few days for about 5 minutes; {name} holds {tvl} in TVL with {age}.',
    'Try a second market on {chain} in week 4 — a different pair, same small size — spending another {gas} and about 15 minutes.',
  ],
  Yield: [
    'Deposit $100 into a {name} vault on {chain} in one session (about 15 minutes, plus {gas}); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Claim or compound the vault rewards once after 7 days, spending {gas} and about 10 minutes, instead of letting rewards sit untouched.',
    'Scale the deposit to the $1,000 tier after 14 days if the vault yield covers the gas spent so far, keeping the same vault so history stays in one place.',
    'Stay deposited for at least 60 days, checking the vault weekly for about 5 minutes; {name} holds {tvl} in TVL with {age}.',
    'Move a small slice to a second vault on {chain} in week 5 if one exists, about 15 minutes and {gas}, to show breadth without splitting the main deposit.',
  ],
  'Risk Curators': [
    'Deposit $100 into a curated {name} vault on {chain} in one session (about 15 minutes, plus {gas}); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Follow the curator rebalances for 14 days without withdrawing, checking the vault allocation weekly for about 5 minutes each time.',
    'Scale the deposit to the $1,000 tier after 14 days if the vault return covers the gas spent so far, keeping the same vault so history stays in one place.',
    'Keep funds in through a full quarter (90 days), reviewing each rebalance for a few minutes; {name} holds {tvl} in TVL with {age}.',
    'Try a second curated vault on {chain} in month 2 with a small $100 slice, about 15 minutes and {gas}, to show breadth across curators.',
  ],
  RWA: [
    'Buy or hold $100 of the tokenised asset on {name} on {chain} in one session (about 20 minutes, plus {gas}); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Complete KYC if the protocol asks for it, allowing 1–3 business days for approval and keeping a copy of the confirmation for your records.',
    'Hold the position through the next distribution or payout cycle, about 30 days, checking the asset page weekly for about 5 minutes.',
    'Scale to the $1,000 tier after 30 days if the first distribution arrived as expected; {name} holds {tvl} in TVL with {age}.',
    'Use the asset once more in month 2 — a top-up or a transfer on {chain} — spending {gas} and about 15 minutes.',
  ],
  'Prediction Market': [
    'Place a $100 trade on a {name} market on {chain} in one session (about 10 minutes, plus {gas}); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Provide $100 of liquidity to a market with at least 30 days left to resolve, holding the LP share until the market closes.',
    'Place a second small trade the following week, about 10 minutes and {gas}, on a different market so activity is not a single bet.',
    'Keep trading small and frequent for 30 days — one or two trades a week, a few minutes each — and never stake more than $1,000 in total; {name} holds {tvl} in TVL with {age}.',
    'Create or resolve a market you follow in week 4 if the protocol allows it, spending about 20 minutes and {gas}.',
  ],
  Payments: [
    'Use {name} for a real $100 payment on {chain} in one session (about 10 minutes, plus {gas}); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Hold a balance in the app for 30+ days, topping it up once a week with a small amount, about 5 minutes and {gas} per top-up.',
    'Make a second real payment in week 2 to a different recipient, about 10 minutes, so the history shows repeated use rather than one transfer.',
    'Refer one real user in month 1 if the protocol offers it, and confirm the referral registered — about 15 minutes of your time, no fee.',
    'Scale regular payments to the $1,000 tier in month 2 if the first month worked smoothly; {name} holds {tvl} in TVL with {age}.',
  ],
  // Not launch candidates: a bridged, wrapped or staked product of a token
  // that already trades, or an exchange's own product. The steps say so
  // plainly instead of pretending a launch is likely.
  noncandidate: [
    '{name} is a bridged, wrapped, staked or exchange product, so a new token launch is unlikely — farm it only if you already use it on {chain}.',
    'Use {name} once for a real $100 action on {chain} (about 15 minutes, plus {gas}); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Repeat the same action a second time within 7 days, about 15 minutes and {gas}, so the history shows return use, not a single visit.',
    'Hold the position for at least 30 days, checking it weekly for about 5 minutes; {name} holds {tvl} in TVL with {age}.',
    'Scale to the $1,000 tier after 30 days only if you already use the product weekly — do not chase it for a launch that probably never comes.',
  ],
  default: [
    'Use {name} on {chain} with a $100 deposit or transaction in one session (about 15 minutes, plus {gas}); this is the $100 tier of the $100 / $1,000 / $10,000 farm.',
    'Repeat the core action a second time within 7 days, about 15 minutes and {gas}, so the history shows return use, not a single visit.',
    'Complete every quest or task the protocol publishes in the first 14 days, allowing about 30 minutes in total plus {gas} per on-chain task.',
    'Hold the position for at least 30 days, checking it weekly for about 5 minutes; {name} holds {tvl} in TVL with {age}.',
    'Scale to the $1,000 tier after 30 days if the first month worked smoothly, keeping the same protocol and chain so history stays in one place.',
  ],
};

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

export function buildBoard(snap: any): any {
  const protos: Proto[] = snap.protocols || [];
  const asOfMs = Date.parse(snap.as_of);
  const { table, winner, beta } = ablate(protos, asOfMs);
  const odds = fitTokenOdds(protos, asOfMs);
  // Value model: the ablation winner. On this snapshot it is the plain
  // log-log (M1): log(mcap) = beta[0] + beta[1] * log(TVL). If the winner
  // were M0 (geo-median), fall back to the global geo-median multiple.
  const traded = tradedUsable(protos);
  const ratios = traded.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMultiple = geoMedian(ratios);
  const impliedOf = (p: Proto): number => {
    if (winner === 'M0') return Math.max(1, Math.round(p.tvl_usd * globalMultiple));
    const cats = bigCats(traded, 5);
    const ages = traded.map((q) => ageDays(q, asOfMs)).filter((a): a is number => a != null);
    const row = valueFeats(p, winner, cats, median(ages), asOfMs);
    return Math.max(1, Math.round(Math.exp(row.reduce((s, v, j) => s + v * beta[j], 0))));
  };
  // The board ranks the launch candidates only: protocols that record no
  // token AND could plausibly launch one. The 144 no-token protocols that
  // are bridges, exchanges or staked products of a token that already
  // trades are not launches, so they are not ranked as such — the
  // dashboard says so, and the 416 protocols whose token already trades
  // are listed apart with their observed market cap.
  const pre = protos.filter((p) => !p.gecko_id && !p.symbol && p.tvl_usd > 0 && isLaunchCandidate(p));
  const scored = pre.map((p) => {
    const implied = impliedOf(p);
    const odd = odds.predict(p);
    const chain = (p.chains && p.chains[0]) || 'Ethereum';
    const gasTotal = Math.max(0.1, Math.round(8 * gasPerTx(chain) * 100) / 100);
    return { p, implied, odd, gasTotal, ratio: Math.round(implied * odd) / gasTotal };
  });
  const ratiosSorted = scored.map((s) => s.ratio).sort((a, b) => a - b);
  const q = (f: number) => ratiosSorted[Math.min(ratiosSorted.length - 1, Math.floor(ratiosSorted.length * f))];
  const verdict = (ratio: number): string => ratio >= q(0.75) ? 'farm first' : ratio >= q(0.5) ? 'farm' : ratio >= q(0.25) ? 'watch' : 'thin';
  const rows = scored.map(({ p, implied, odd, gasTotal, ratio }) => {
    const chain = (p.chains && p.chains[0]) || 'Ethereum';
    const candidate = true;
    const steps = (FARM[p.category || ''] || FARM.default).map((s) => s
      .replaceAll('{chain}', chain)
      .replaceAll('{name}', p.name)
      .replaceAll('{tvl}', money(p.tvl_usd))
      .replaceAll('{age}', ageText(p, asOfMs))
      .replaceAll('{gas}', gasText(chain)));
    const expected = Math.round(implied * odd);
    const share = gasTotal / implied * 100;
    const shareTxt = share >= 0.01 ? share.toFixed(2) + '%' : share.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + '%';
    const gasEach = gasText(chain).replace(/^about /, '');
    steps.push(
      `Verdict: ${verdict(ratio)} — the six steps cost about $${gasTotal.toFixed(2)} of gas in total (about ${gasEach} per transaction, 8 transactions), which is ${shareTxt} of the ${money(implied)} implied value. A launch is not guaranteed and the tokens may be worth nothing; record every transaction hash and date.`
    );
    return {
      slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at,
      age_days: ageDays(p, asOfMs),
      implied_multiple: Math.round(implied / p.tvl_usd * 100) / 100,
      implied_value_usd: implied,
      token_odds: Math.round(odd * 100) / 100,
      expected_value_usd: expected,
      on_watchlist: (snap.watchlist || []).includes(p.slug),
      is_launch_candidate: candidate,
      farm_verdict: verdict(ratio),
      farm_gas_usd: gasTotal,
      farm_steps: steps,
      farm_cost_tiers_usd: [100, 1000, 10000],
      note: 'Records no token in DefiLlama (gecko_id and symbol null). That is not proof it has none.',
    };
  })
    // Rank by implied value, highest first; ties break by expected value,
    // then slug, so the order is deterministic run to run.
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.expected_value_usd - a.expected_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  // The traded protocols, kept apart from the ranking: the board separates
  // what already trades from what is still to come. The dashboard shows
  // them in their own section with their observed market cap.
  const tradedRef = protos.filter((p) => p.gecko_id || p.symbol).map((p) => ({
    slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd, multiple: p.mcap_usd && p.tvl_usd > 0 ? Math.round(p.mcap_usd / p.tvl_usd * 100) / 100 : null,
    change_7d: p.change_7d,
  })).sort((a, b) => (b.mcap_usd || 0) - (a.mcap_usd || 0));
  return {
    as_of: snap.as_of, source: snap.source, floor_usd: snap.floor_usd,
    protocols_in_snapshot: protos.length, watchlist_size: (snap.watchlist || []).length,
    traded_count: tradedRef.length,
    noncandidate_count: protos.filter((p) => !p.gecko_id && !p.symbol && p.tvl_usd > 0 && !isLaunchCandidate(p)).length,
    rows, traded: tradedRef, meta: {
      model: winner === 'M0'
        ? 'Implied value = TVL x global geometric-median mcap/TVL of the traded protocols.'
        : `Implied value = exp(${beta[0].toFixed(4)} + ${beta[1].toFixed(4)} x log(TVL)), fitted by OLS on the ${traded.length} traded protocols with a usable mcap/TVL ratio.`,
      model_winner: winner,
      ablation: table,
      ablation_note: 'Every candidate term was blind-tested (leave-one-out, walk-forward older-to-newer, ten-fold); the winner is the lowest sum of the three median absolute % errors. Growth, age and category terms were tested and dropped: they did not improve held-out error.',
      token_odds: {
        method: 'Ridge logistic on whether a protocol records a token, from log TVL, log age, 7-day growth and category dummies (fitted on all 758 protocols).',
        tenfold_brier: odds.brierTenfold, baseline_tenfold_brier: odds.brierBaseline,
      },
      farm: 'Six steps per protocol, costed per chain at typical gas per transaction (8 transactions a plan). Verdict from quartiles of expected value per dollar of gas: farm first / farm / watch / thin. Deposit tiers $100 / $1,000 / $10,000.',
      method: 'Implied value is fitted from the snapshot’s own traded protocols (log-log OLS on TVL). Token odds come from age, TVL, growth and category. Expected value = implied x token odds. Ranked by implied value. Protocols whose token already trades are listed apart, with their observed market cap — they are never ranked as launches. The 144 no-token protocols that are bridges, exchanges or staked products of a token that already trades are not ranked either: they are not launches.',
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
  rows.some((r: any) => r.token_odds < 0 || r.token_odds > 1) ? 'token_odds out of range' :
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
console.log(`Launch Radar: ${rows.length} pre-token rows, rank 1 ${rows[0].name} ${money(rows[0].implied_value_usd)} implied, watchlist ${watchlistCovered}/${board.watchlist_size} covered, model ${board.meta.model_winner}, validation LOO ${board.meta.ablation[board.meta.model_winner].loo}% -> ${OUT}`);
