// Launch Radar v3 — token-radar-01 (Node 22, standard library only).
//
// Reads the sealed snapshot (/input/snapshot.json), fits the value model at
// runtime, scores all 758 protocols, and writes the ranked board, the
// dashboard data, and the dossier. The model is fitted, not hardcoded:
//   log(mcap) = a + b * log(TVL), OLS on the 128 protocols whose token
//   already trades (mcap > 0). Growth, age and category terms were tested
//   and dropped: none survived four held-out tests (see the dashboard).
// Token odds fall with protocol age (Weibull survival fitted on the
// peers' own record), and every row carries a conformal 80% interval
// (per category when the category has >= 6 traded protocols, else global).
// The board is sorted globally by model-implied value, rank 1..758, so
// the gate's monotone-value rule holds for every row: candidates, traded
// anchors and excluded protocols alike are scored by the same function.
//
// Run: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4194304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// Gas price per transaction, by chain (public fee levels at the snapshot date).
const GAS_USD = { Ethereum: 8, Arbitrum: 0.30, Optimism: 0.10, Base: 0.05, Polygon: 0.05, BSC: 0.20, Avalanche: 0.30, Solana: 0.002 };
const GAS_DEFAULT_USD = 1;
const BRIDGE_USD = 5;

// Categories that keep a pre-token protocol off the candidate board.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
// The eight category dummies of the M5 model (tested, dropped).
const M5_CATEGORIES = ['Lending', 'Dexs', 'Liquid Staking', 'Yield', 'CEX', 'RWA', 'Canonical Bridge', 'Basis Trading'];
const EXCHANGE_NAMES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

// ---------------------------------------------------------------- arguments

/** --name <value> out of the arguments, or the fallback. */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// ---------------------------------------------------------------- snapshot

/** Parse and sanity-check the sealed snapshot. */
function parseSnapshot(text) {
  const s = JSON.parse(text);
  if (!s || !Array.isArray(s.protocols) || !Array.isArray(s.watchlist)) {
    throw new Error('snapshot: protocols and watchlist arrays are required');
  }
  for (const p of s.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error(`snapshot: protocol ${String(p && p.slug)} is missing slug, name or tvl_usd`);
    }
  }
  return s;
}

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const protocols = snapshot.protocols;
const watchlist = new Set(snapshot.watchlist);
const asOf = snapshot.as_of;

// ---------------------------------------------------------------- helpers

/** Median of numbers (mean of the two middle values when even). */
function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/** Quantile with linear interpolation (the numpy percentile default). */
function quantile(values, prob) {
  const v = values.slice().sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const i = (v.length - 1) * prob;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, v.length - 1);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/** Age in years from listed_at to the snapshot date; null when unlisted. */
function ageYears(p) {
  if (!p.listed_at) return null;
  const ms = Date.parse(asOf) - Date.parse(p.listed_at);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, ms / (365.25 * 24 * 3600 * 1000));
}

/** A protocol records no token: mcap, gecko_id and symbol are all null. */
function isPreToken(p) {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Why a pre-token protocol is not a launch candidate; null when it is one. */
function excludedReason(p) {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSION_SUFFIX.test(p.name)) return 'versioned name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped/staked word in name';
  const lower = p.name.toLowerCase();
  if (EXCHANGE_NAMES.some((e) => lower.startsWith(e))) return 'exchange name';
  return null;
}

/** Gas price of one transaction on a chain, in dollars. */
function gasPerTx(chain) {
  return GAS_USD[chain] !== undefined ? GAS_USD[chain] : GAS_DEFAULT_USD;
}

/** The chain a protocol lives on first (its primary deployment). */
function primaryChain(p) {
  return Array.isArray(p.chains) && p.chains.length > 0 ? p.chains[0] : 'Ethereum';
}

/** Whole dollars, rounded. */
function whole(x) {
  return Math.max(1, Math.round(x));
}

/** Short money: $12.4M, $836K, $512. */
function shortMoney(x) {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${x.toFixed(0)}`;
}

// ---------------------------------------------------------------- OLS fit

/** Median age of the traded set, used when a protocol has no listed_at. */
const fitSet = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
const medianTradedAge = median(fitSet.map(ageYears).filter((a) => a !== null));

/** Feature vector of a protocol for a model: [1, logTVL, growth?, age?, dummies?]. */
function features(p, model) {
  const x = [1, Math.log(p.tvl_usd)];
  if (model === 'M1' || model === 'M2' || model === 'M5') {
    x.push(p.change_7d === null || p.change_7d === undefined ? 0 : p.change_7d);
  }
  if (model === 'M2' || model === 'M5') {
    const a = ageYears(p);
    x.push(a === null ? medianTradedAge : a);
  }
  if (model === 'M5') {
    for (const c of M5_CATEGORIES) x.push(p.category === c ? 1 : 0);
  }
  return x;
}

/** Ordinary least squares by normal equations + Gaussian elimination. */
function ols(rows, model) {
  const m = features(rows[0], model).length;
  const A = [];
  const b = [];
  for (let i = 0; i < m; i++) {
    A.push(new Array(m).fill(0));
    b.push(0);
  }
  for (const p of rows) {
    const x = features(p, model);
    const y = Math.log(p.mcap_usd);
    for (let i = 0; i < m; i++) {
      b[i] += x[i] * y;
      for (let j = 0; j < m; j++) A[i][j] += x[i] * x[j];
    }
  }
  for (let i = 0; i < m; i++) A[i][i] += 1e-10;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    const tmp = M[col];
    M[col] = M[piv];
    M[piv] = tmp;
    const pv = M[col][col];
    for (let r = col + 1; r < m; r++) {
      const f = M[r][col] / pv;
      for (let cc = col; cc <= m; cc++) M[r][cc] -= f * M[col][cc];
    }
  }
  const beta = new Array(m).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    let s = M[i][m];
    for (let j = i + 1; j < m; j++) s -= M[i][j] * beta[j];
    beta[i] = s / M[i][i];
  }
  return beta;
}

/** Predicted log(mcap) of a protocol under a fitted model. */
function predict(beta, p, model) {
  const x = features(p, model);
  let s = 0;
  for (let i = 0; i < beta.length; i++) s += beta[i] * x[i];
  return s;
}

/** Median error ratio and within-2x share of a model on a test set. */
function evalRows(test, beta, model) {
  const errs = test.map((p) => Math.abs(Math.log(p.mcap_usd) - predict(beta, p, model)));
  const med = median(errs);
  const within2 = errs.filter((e) => e <= Math.log(2)).length / errs.length;
  return { medianRatio: Math.exp(med), within2 };
}

// ---------------------------------------------------------------- model fit

const MODELS = ['M0', 'M1', 'M2', 'M5'];

/** Full-sample fit of every model on the 128 traded protocols. */
const fullBeta = {};
for (const model of MODELS) fullBeta[model] = ols(fitSet, model);

/** R^2 and median error ratio of the M0 full fit. */
function fullFitStats() {
  const beta = fullBeta.M0;
  const ys = fitSet.map((p) => Math.log(p.mcap_usd));
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < fitSet.length; i++) {
    ssTot += (ys[i] - my) * (ys[i] - my);
    const r = ys[i] - predict(beta, fitSet[i], 'M0');
    ssRes += r * r;
  }
  const errs = fitSet.map((p) => Math.abs(Math.log(p.mcap_usd) - predict(beta, p, 'M0')));
  return { a: beta[0], b: beta[1], r2: 1 - ssRes / ssTot, medianRatio: Math.exp(median(errs)) };
}
const m0Stats = fullFitStats();

/** Four held-out tests of every model, all computed at runtime. */
function heldOutTable() {
  const table = {};
  for (const model of MODELS) {
    // Leave-one-out: 128 refits.
    const looErrs = [];
    for (let i = 0; i < fitSet.length; i++) {
      const rest = fitSet.slice(0, i).concat(fitSet.slice(i + 1));
      const beta = ols(rest, model);
      looErrs.push(Math.abs(Math.log(fitSet[i].mcap_usd) - predict(beta, fitSet[i], model)));
    }
    const loo = { medianRatio: Math.exp(median(looErrs)), within2: looErrs.filter((e) => e <= Math.log(2)).length / looErrs.length };
    // Ten-fold, deterministic folds by index (traded sorted by slug).
    const foldErrs = [];
    for (let f = 0; f < 10; f++) {
      const test = fitSet.filter((_, i) => i % 10 === f);
      const train = fitSet.filter((_, i) => i % 10 !== f);
      const beta = ols(train, model);
      for (const p of test) foldErrs.push(Math.abs(Math.log(p.mcap_usd) - predict(beta, p, model)));
    }
    const ten = { medianRatio: Math.exp(median(foldErrs)), within2: foldErrs.filter((e) => e <= Math.log(2)).length / foldErrs.length };
    // Walk-forward: train listed before 2025-01-01, test listed after.
    const wfTrain = fitSet.filter((p) => p.listed_at && p.listed_at < '2025-01-01');
    const wfTest = fitSet.filter((p) => p.listed_at && p.listed_at >= '2025-01-01');
    const wf = evalRows(wfTest, ols(wfTrain, model), model);
    wf.nTrain = wfTrain.length;
    wf.nTest = wfTest.length;
    // Older to newer: train the 70% oldest, test the 30% youngest.
    const byAge = fitSet.slice().sort((a, b) => {
      const ka = a.listed_at || '9999';
      const kb = b.listed_at || '9999';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const k = Math.floor(byAge.length * 0.7);
    const o2n = evalRows(byAge.slice(k), ols(byAge.slice(0, k), model), model);
    o2n.nTrain = k;
    o2n.nTest = byAge.length - k;
    table[model] = { loo, ten, wf, o2n };
  }
  return table;
}
const validation = heldOutTable();

// ---------------------------------------------------------------- conformal

/** Conformal 80% intervals from the M0 residuals, global + per category. */
function conformal() {
  const beta = fullBeta.M0;
  const byCat = {};
  const all = [];
  for (const p of fitSet) {
    const r = Math.abs(Math.log(p.mcap_usd) - predict(beta, p, 'M0'));
    all.push(r);
    const c = p.category === null ? '(none)' : p.category;
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(r);
  }
  const global = { q50: quantile(all, 0.5), q80: quantile(all, 0.8), q90: quantile(all, 0.9) };
  const perCat = {};
  for (const c of Object.keys(byCat)) {
    if (byCat[c].length >= 6) perCat[c] = quantile(byCat[c], 0.8);
  }
  return { global, perCat };
}
const conf = conformal();

/** The 80% log half-width for a protocol's category (global when thin). */
function confHalfWidth(p) {
  const c = p.category;
  if (c !== null && conf.perCat[c] !== undefined) return conf.perCat[c];
  return conf.global.q80;
}

// ---------------------------------------------------------------- token odds

/** Token odds fall with age: Weibull survival fitted on the peers' record. */
function weibull() {
  const bins = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 99]];
  const points = [];
  for (const [lo, hi] of bins) {
    const ps = protocols.filter((p) => {
      const a = ageYears(p);
      return a !== null && a >= lo && a < hi;
    });
    if (ps.length === 0) continue;
    const rate = ps.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length / ps.length;
    const mid = hi >= 99 ? 4.5 : (lo + hi) / 2;
    points.push({ a: mid, s: 1 - rate, n: ps.length, rate });
  }
  // OLS on log(-log S) = k * log(a) - k * log(lambda), five cohort points.
  const xs = points.map((pt) => Math.log(pt.a));
  const ys = points.map((pt) => Math.log(-Math.log(pt.s)));
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  const k = num / den;
  const c = my - k * mx;
  const lambda = Math.exp(-c / k);
  return { k, lambda, points };
}
const weib = weibull();

/** Survival without a token at age a (years) under the fitted Weibull. */
function survival(a) {
  return Math.exp(-Math.pow(a / weib.lambda, weib.k));
}

/** Chance of a launch in the next 12 months for a protocol of age a. */
function odds12m(a) {
  const s0 = survival(a);
  const s1 = survival(a + 1);
  return 1 - s1 / s0;
}

/** Age to use for odds: the protocol's own, or the pre-token median (1.75y). */
function oddsAge(p) {
  const a = ageYears(p);
  return a === null ? 1.75 : a;
}

// ---------------------------------------------------------------- farm plans

/** The category-specific core action of a candidate's farm plan. */
function coreAction(p, amt, gas) {
  const chain = primaryChain(p);
  const name = p.name;
  if (p.category === 'Lending') {
    return `Supply $${amt} of USDC to ${name}'s lending market on ${chain} and confirm the supply; you earn yield while your address is recorded as a user. Cost: ~$${gas} gas. Time: ~5 min.`;
  }
  if (p.category === 'Dexs') {
    return `Swap $${amt} into ${name}'s pool pair on ${chain} and add liquidity; keep the LP position open so the address accrues activity. Cost: ~$${gas} gas. Time: ~10 min.`;
  }
  if (p.category === 'Yield') {
    return `Deposit $${amt} into ${name}'s vault on ${chain} and confirm; the vault receipt token is your proof of use. Cost: ~$${gas} gas. Time: ~5 min.`;
  }
  if (p.category === 'RWA') {
    return `Buy or mint $${amt} of ${name}'s tokenised asset on ${chain} and hold it in the same wallet for at least a month. Cost: ~$${gas} gas. Time: ~10 min.`;
  }
  if (p.category === 'Basis Trading') {
    return `Open a $${amt} basis position through ${name} on ${chain} and hold it across at least one funding cycle. Cost: ~$${gas} gas. Time: ~10 min.`;
  }
  return `Use ${name}'s core feature on ${chain} with $${amt} and confirm the transaction; keep the position open for weeks, not hours. Cost: ~$${gas} gas. Time: ~10 min.`;
}

/** The farm steps of one row (6 for a candidate, 3 for traded or excluded). */
function farmStepsFor(p, ctx) {
  const chain = primaryChain(p);
  const gas = gasPerTx(chain);
  if (ctx.status === 'candidate') {
    const core = Math.max(50, Math.round(ctx.minCapital));
    const small = Math.max(25, Math.round(ctx.minCapital / 2));
    const steps = [];
    steps.push(`Fund a fresh wallet with at least $${ctx.minCapital} on ${chain} so every step below is payable; keep the wallet separate from your main funds. Cost: ~$${gas} gas. Time: ~5 min.`);
    steps.push(coreAction(p, core, gas));
    steps.push(`Return a week later and repeat the core action once more with $${small}; protocols reward repeat users, not one-off visitors. Cost: ~$${gas} gas. Time: ~10 min.`);
    if (Array.isArray(p.chains) && p.chains.length > 1) {
      steps.push(`Move $${small} to ${p.name}'s deployment on ${p.chains[1]} through a bridge and use the app there once; multi-chain users are the ones launches usually catch. Cost: ~$5 bridge + ~$${gas} gas. Time: ~15 min.`);
    } else {
      steps.push(`Do one more distinct action inside ${p.name} on ${chain} — a second feature, not the same button twice — so the wallet shows breadth of use. Cost: ~$${gas} gas. Time: ~10 min.`);
    }
    steps.push(`Screenshot your positions page and save every transaction hash in a note; without a record you cannot prove use if a claim opens. Cost: $0. Time: ~5 min.`);
    steps.push(`Check ${p.name}'s announcements and governance forum once a month for token or points news; a launch is announced there first, not on price sites. Cost: $0. Time: ~5 min a month.`);
    return steps;
  }
  if (ctx.status === 'traded') {
    const mcapNote = ctx.mcap !== null && ctx.mcap !== undefined
      ? `Its token records a market cap of ${shortMoney(ctx.mcap)}`
      : `Its token is recorded as trading, with no market cap in the snapshot`;
    return [
      `This protocol already trades — there is no launch left to farm. ${mcapNote}; do not buy it expecting a launch airdrop. Cost: $0. Time: ~2 min.`,
      `If you want exposure to ${p.name}, buy a small position on ${chain} only after reading the token's unlock schedule; size it as an investment, not a farm. Cost: ~$${gas} gas. Time: ~10 min.`,
      `Track the token's price and the protocol's TVL weekly; a falling TVL with a rising token price is the warning sign this radar watches. Cost: $0. Time: ~5 min a week.`,
    ];
  }
  return [
    `Do not farm this as a launch candidate: ${ctx.reason}. Its model-implied value is ${shortMoney(ctx.implied)}, but the exclusion rule keeps it off the candidate board. Cost: $0. Time: ~2 min.`,
    `Watch for a change instead: a new version, a spin-off, or a token record appearing would move it onto the radar; check its page monthly. Cost: $0. Time: ~5 min a month.`,
    `If you already use it, keep using it for its own sake — the product works — but do not expect a launch airdrop from this entry. Cost: $0. Time: ~2 min.`,
  ];
}

// ---------------------------------------------------------------- the board

/** The traded anchor nearest a row: same category, closest log TVL. */
function peerAnchor(p) {
  const logTvl = Math.log(p.tvl_usd);
  let best = null;
  let bestDiff = Infinity;
  for (const t of fitSet) {
    if (t.slug === p.slug) continue;
    if (t.category !== p.category) continue;
    const d = Math.abs(Math.log(t.tvl_usd) - logTvl);
    if (d < bestDiff) {
      bestDiff = d;
      best = t;
    }
  }
  if (best === null) {
    for (const t of fitSet) {
      if (t.slug === p.slug) continue;
      const d = Math.abs(Math.log(t.tvl_usd) - logTvl);
      if (d < bestDiff) {
        bestDiff = d;
        best = t;
      }
    }
  }
  if (best === null) return null;
  return { slug: best.slug, name: best.name, mcap_usd: best.mcap_usd, tvl_usd: best.tvl_usd };
}

/** Build every board row, then sort globally by model-implied value. */
function buildBoard() {
  const beta = fullBeta.M0;
  const rows = [];
  for (const p of protocols) {
    const pre = isPreToken(p);
    const reason = pre ? excludedReason(p) : null;
    const status = !pre ? 'traded' : reason === null ? 'candidate' : 'excluded';
    const implied = whole(Math.exp(predict(beta, p, 'M0')));
    const age = oddsAge(p);
    const odds = status === 'candidate' ? odds12m(age) : null;
    const ev = odds === null ? null : implied * odds;
    const half = confHalfWidth(p);
    const lo = whole(implied * Math.exp(-half));
    const hi = whole(implied * Math.exp(half));
    const chain = primaryChain(p);
    const gas = gasPerTx(chain);
    const multi = Array.isArray(p.chains) && p.chains.length > 1;
    let totalCost = 0;
    let minCapital = null;
    let verdict;
    let breakEven = null;
    if (status === 'candidate') {
      const txCost = 4 * gas;
      const bridgeCost = multi ? BRIDGE_USD : 0;
      totalCost = txCost + bridgeCost;
      minCapital = Math.max(50, Math.round(10 * txCost + bridgeCost));
      if (ev >= 3 * totalCost && odds >= 0.05) verdict = 'farm';
      else if (ev >= totalCost) verdict = 'watch';
      else verdict = 'thin';
      breakEven = totalCost / ev;
    } else if (status === 'traded') {
      totalCost = gas;
      verdict = 'traded';
    } else {
      verdict = 'excluded';
    }
    const steps = farmStepsFor(p, { status, minCapital, mcap: p.mcap_usd, reason, implied });
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: steps,
      status,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_years: age,
      mcap_usd: p.mcap_usd,
      model_implied_usd: implied,
      odds_12m: odds,
      ev_usd: ev === null ? null : Math.round(ev),
      lo_usd: lo,
      hi_usd: hi,
      peer: peerAnchor(p),
      gas_cost_usd: totalCost,
      min_capital_usd: minCapital,
      verdict,
      break_even_x: breakEven,
      excluded_reason: reason,
      on_watchlist: watchlist.has(p.slug),
    });
  }
  // One value function for all rows: global sort by implied, ties by slug.
  rows.sort((a, b) => {
    if (b.implied_value_usd !== a.implied_value_usd) return b.implied_value_usd - a.implied_value_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < rows.length; i++) rows[i].rank = i + 1;
  return rows;
}
const board = buildBoard();

/** The gate's own shape checks, run before anything is written. */
function boardIssue(rows) {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, not 100-4000`;
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${r.slug} has rank ${r.rank}, not ${i + 1}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) {
      return `row ${r.slug} has implied_value_usd ${r.implied_value_usd}`;
    }
    if (i > 0 && r.implied_value_usd > rows[i - 1].implied_value_usd) {
      return `implied value rises from rank ${i} to rank ${i + 1}`;
    }
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.slug} has ${Array.isArray(r.farm_steps) ? r.farm_steps.length : 0} farm steps, not 3-12`;
    }
    for (const s of r.farm_steps) {
      const t = String(s).trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has a farm step of ${t.length} characters, not 20-600`;
    }
  }
  const allSame = rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd);
  if (rows.length >= 2 && allSame) return 'every implied value is the same: not a ranking';
  for (const slug of watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}
const issue = boardIssue(board);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- dashboard data

/** The data.js the dashboard page reads: the board, the model, the tests. */
function dataScript() {
  const counts = { candidate: 0, traded: 0, excluded: 0 };
  const verdicts = { farm: 0, watch: 0, thin: 0, traded: 0, excluded: 0 };
  for (const r of board) {
    counts[r.status]++;
    verdicts[r.verdict]++;
  }
  const data = {
    meta: {
      title: 'Launch Radar v3',
      asOf,
      nProtocols: protocols.length,
      nWatchlist: watchlist.size,
      nCandidates: counts.candidate,
      nTraded: counts.traded,
      nExcluded: counts.excluded,
      nFitted: fitSet.length,
      verdicts,
      screenLine: 0.9439,
      model: { a: m0Stats.a, b: m0Stats.b, r2: m0Stats.r2, medianRatio: m0Stats.medianRatio },
    },
    validation,
    conformal: conf,
    weibull: {
      k: weib.k,
      lambda: weib.lambda,
      points: weib.points,
      oddsAt: [0.5, 1, 2, 3, 4, 5].map((a) => ({ age: a, odds: odds12m(a) })),
    },
    rows: board,
  };
  return `var LAUNCH_RADAR_V3 = ${JSON.stringify(data)};\n`;
}

// ---------------------------------------------------------------- write out

/** Copy one directory's regular files into `to`, skipping dot names. */
function copyFiles(from, to) {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript());

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

const nCand = board.filter((r) => r.status === 'candidate').length;
const nTraded = board.filter((r) => r.status === 'traded').length;
const nExcl = board.filter((r) => r.status === 'excluded').length;
const v0 = validation.M0;
process.stdout.write(
  `token radar: ${protocols.length} protocols, ${watchlist.size} on the watchlist, ${board.length} rows scored (${nCand} candidates, ${nTraded} traded, ${nExcl} excluded)\n` +
    `token radar: model log(mcap) = ${m0Stats.a.toFixed(4)} + ${m0Stats.b.toFixed(4)} * log(TVL), R2 = ${m0Stats.r2.toFixed(3)}, median ratio ${m0Stats.medianRatio.toFixed(2)}x\n` +
    `token radar: held-out M0 LOO ${v0.loo.medianRatio.toFixed(2)}x, 10-fold ${v0.ten.medianRatio.toFixed(2)}x, walk-forward ${v0.wf.medianRatio.toFixed(2)}x, older->newer ${v0.o2n.medianRatio.toFixed(2)}x\n` +
    `token radar: Weibull k = ${weib.k.toFixed(2)}, lambda = ${weib.lambda.toFixed(1)}y; conformal q80 = ${conf.global.q80.toFixed(2)} log\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
