// Launch Radar v4 — model, validation, odds, board and farm plans.
//
// Method (see README for the full statement):
//  * Fit set: traded protocols with TVL >= $5M and mcap/TVL in [0.01, 10] (n=111).
//    The 17 protocols the filter drops are extreme outliers (bridges and staked
//    products with tiny market caps against huge TVL, and the reverse).
//  * Value model: log(mcap) = a + b*log(TVL) + c*growth, growth = change_7d in
//    PER CENT clipped to [-50, +50] before fitting and before predicting. The
//    clip matters: one protocol reports +4,448% and without it would imply a
//    $372 trillion market cap. The model is chosen at runtime by the lowest sum
//    of four held-out median ratio errors (leave-one-out, 10-fold, walk-forward,
//    older-to-newer) among M0/M1/M2/M5.
//  * Token odds: ridge-logistic on log TVL, log age, clipped growth and category
//    dummies, chosen by 10-fold cross-validated Brier score against an age-only
//    Weibull and a category-share baseline.
//  * Conformal intervals: 80th percentile of |residual| on the filtered fit,
//    per category (global fallback), linear-interpolation quantile.
//  * Board: candidate-only (pre-token, not excluded), ranked by implied value
//    descending. Traded protocols anchor a separate section; excluded pre-token
//    protocols are listed separately with their reason. All 758 protocols are
//    accounted for.
//  * Farm: six concrete steps per candidate, costed by chain gas, minimum viable
//    capital = max($50, 10 x gas cost + bridge).

import { PythonRandom } from './mt19937.ts';

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The snapshot's market-cap field is a number here, but coerce defensively:
 *  a string such as '0' or '-1' parses to a number; anything unparseable is null. */
export function coerceMcap(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const protocols = (raw.protocols as Record<string, unknown>[]).map((p) => ({
    slug: String(p.slug ?? ''),
    name: String(p.name ?? ''),
    category: p.category === null || p.category === undefined ? null : String(p.category),
    chains: Array.isArray(p.chains) ? (p.chains as unknown[]).map((c) => String(c)) : [],
    tvl_usd: Number(p.tvl_usd ?? 0),
    change_7d: p.change_7d === null || p.change_7d === undefined ? null : Number(p.change_7d),
    mcap_usd: coerceMcap(p.mcap_usd),
    listed_at: p.listed_at === null || p.listed_at === undefined ? null : String(p.listed_at),
    gecko_id: p.gecko_id === null || p.gecko_id === undefined ? null : String(p.gecko_id),
    symbol: p.symbol === null || p.symbol === undefined ? null : String(p.symbol),
  }));
  return {
    as_of: String(raw.as_of ?? ''),
    source: String(raw.source ?? ''),
    floor_usd: Number(raw.floor_usd ?? 0),
    protocols,
    watchlist: Array.isArray(raw.watchlist) ? (raw.watchlist as unknown[]).map((w) => String(w)) : [],
  };
}

/** Days from a YYYY-MM-DD date to the snapshot date, never negative. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function ageDays(p: Protocol, asOf: string): number | null {
  return p.listed_at === null ? null : daysBetween(p.listed_at, asOf);
}

/** change_7d is a PER CENT figure (median about -9%). Null means unreported.
 *  Clip to +/-50 before any use: the raw +4,448% outlier would otherwise
 *  imply a $372 trillion market cap for one protocol. */
export function growthClipped(p: Protocol): number {
  if (p.change_7d === null || !Number.isFinite(p.change_7d)) return 0;
  return Math.max(-50, Math.min(50, p.change_7d));
}

export function hasToken(p: Protocol): boolean {
  return (p.mcap_usd !== null && p.mcap_usd > 0) || p.gecko_id !== null || p.symbol !== null;
}

export function isPreToken(p: Protocol): boolean {
  return !hasToken(p);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return (s[lo]! + s[hi]!) / 2;
}

/** Quantile with linear interpolation (the numpy percentile default), so the
 *  conformal widths match the reference computation exactly. */
export function quantileLinear(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 1;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  const s = Math.sqrt(v);
  return s === 0 ? 1 : s;
}

// ---- least squares by modified Gram-Schmidt QR (stable on raw scales) ----

/** Solve min ||X b - y|| for X (n x p), y (n). Returns b (p). Columns that are
 *  (numerically) dependent get a zero coefficient instead of blowing up. */
export function lstsq(X: number[][], y: number[]): number[] {
  const n = X.length;
  const p = X[0]!.length;
  // Q columns as arrays of length n, R as p x p.
  const Q: number[][] = [];
  const R: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let j = 0; j < p; j++) {
    let v = X.map((row) => row[j]!);
    for (let i = 0; i < j; i++) {
      let dot = 0;
      for (let r = 0; r < n; r++) dot += Q[i]![r]! * v[r]!;
      R[i]![j] = dot;
      for (let r = 0; r < n; r++) v[r]! -= dot * Q[i]![r]!;
    }
    let norm = 0;
    for (let r = 0; r < n; r++) norm += v[r]! * v[r]!;
    norm = Math.sqrt(norm);
    R[j]![j] = norm;
    if (norm < 1e-12) {
      Q.push(new Array<number>(n).fill(0));
    } else {
      Q.push(v.map((x) => x / norm));
    }
  }
  // Q'y
  const qty: number[] = [];
  for (let i = 0; i < p; i++) {
    let dot = 0;
    for (let r = 0; r < n; r++) dot += Q[i]![r]! * y[r]!;
    qty.push(dot);
  }
  // Back-substitution R b = Q'y
  const b = new Array<number>(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    if (Math.abs(R[i]![i]!) < 1e-12) {
      b[i] = 0;
      continue;
    }
    let s = qty[i]!;
    for (let j = i + 1; j < p; j++) s -= R[i]![j]! * b[j]!;
    b[i] = s / R[i]![i]!;
  }
  return b;
}

export function predictRow(X: number[][], b: number[]): number[] {
  return X.map((row) => row.reduce((s, x, j) => s + x * b[j]!, 0));
}

/** Median ratio error: median(exp(|log actual - log predicted|)). */
export function medianRatioError(y: number[], pred: number[]): number {
  const errs = y.map((v, i) => Math.exp(Math.abs(v - pred[i]!)));
  return median(errs);
}

// ---- value models ----

export type ModelName = 'M0' | 'M1' | 'M2' | 'M5';

export interface FitRow {
  p: Protocol;
  y: number; // log(mcap)
  logTvl: number;
  growth: number; // clipped per cent
  age: number; // days, null-age imputed to the fit set's median age
}

export function buildFitRows(snap: Snapshot): FitRow[] {
  const traded = snap.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd >= 5_000_000 &&
      p.mcap_usd / p.tvl_usd >= 0.01 && p.mcap_usd / p.tvl_usd <= 10,
  );
  const ages = traded.map((p) => ageDays(p, snap.as_of)).filter((a): a is number => a !== null);
  const medAge = median(ages);
  return traded.map((p) => ({
    p,
    y: Math.log(p.mcap_usd!),
    logTvl: Math.log(p.tvl_usd),
    growth: growthClipped(p),
    age: ageDays(p, snap.as_of) ?? medAge,
  }));
}

export function topCategories(rows: FitRow[], k: number): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = r.p.category ?? 'None';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([c]) => c);
}

export function designMatrix(rows: FitRow[], model: ModelName, cats: string[]): number[][] {
  return rows.map((r) => {
    const base = [1, r.logTvl];
    if (model === 'M0') return base;
    const withGrowth = [...base, r.growth];
    if (model === 'M1') return withGrowth;
    const withAge = [...withGrowth, r.age];
    if (model === 'M2') return withAge;
    const dummies = cats.map((c) => ((r.p.category ?? 'None') === c ? 1 : 0));
    return [...withAge, ...dummies];
  });
}

export const MODELS: ModelName[] = ['M0', 'M1', 'M2', 'M5'];

export interface ModelFit {
  name: ModelName;
  beta: number[];
  r2: number;
  medianErr: number;
}

export function fitModel(rows: FitRow[], model: ModelName, cats: string[]): ModelFit {
  const X = designMatrix(rows, model, cats);
  const y = rows.map((r) => r.y);
  const beta = lstsq(X, y);
  const pred = predictRow(X, beta);
  const yMean = mean(y);
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < y.length; i++) {
    ssTot += (y[i]! - yMean) ** 2;
    ssRes += (y[i]! - pred[i]!) ** 2;
  }
  return { name: model, beta, r2: 1 - ssRes / ssTot, medianErr: medianRatioError(y, pred) };
}

// ---- four-way held-out validation (all median ratio errors) ----

export const FOLD_SEED = 20261114;

export interface HeldOut {
  loo: number;
  tenFold: number;
  walkForward: number;
  olderToNewer: number;
  sum: number;
}

function errorOn(rows: FitRow[], model: ModelName, cats: string[], trainIdx: number[], testIdx: number[]): number {
  const X = designMatrix(rows, model, cats);
  const y = rows.map((r) => r.y);
  const beta = lstsq(trainIdx.map((i) => X[i]!), trainIdx.map((i) => y[i]!));
  const errs = testIdx.map((i) => Math.exp(Math.abs(y[i]! - X[i]!.reduce((s, x, j) => s + x * beta[j]!, 0))));
  return median(errs);
}

export function leaveOneOut(rows: FitRow[], model: ModelName, cats: string[]): number {
  const n = rows.length;
  const errs: number[] = [];
  for (let i = 0; i < n; i++) {
    const train = Array.from({ length: n }, (_, k) => k).filter((k) => k !== i);
    errs.push(errorOn(rows, model, cats, train, [i]));
  }
  return median(errs);
}

export function tenFold(rows: FitRow[], model: ModelName, cats: string[]): number {
  // Python random.Random(20261114).shuffle, folds = perm[k::10].
  const rng = new PythonRandom(FOLD_SEED);
  const perm = rng.shuffle(Array.from({ length: rows.length }, (_, i) => i));
  const X = designMatrix(rows, model, cats);
  const y = rows.map((r) => r.y);
  const errs: number[] = [];
  for (let k = 0; k < 10; k++) {
    const test = perm.filter((_, j) => j % 10 === k);
    const testSet = new Set(test);
    const train = perm.filter((i) => !testSet.has(i));
    const beta = lstsq(train.map((t) => X[t]!), train.map((t) => y[t]!));
    for (const i of test) {
      errs.push(Math.exp(Math.abs(y[i]! - X[i]!.reduce((s, x, j) => s + x * beta[j]!, 0))));
    }
  }
  return median(errs);
}

/** Walk-forward: train on protocols listed before 2025-01-01, test on those
 *  listed in 2025 or later (n_test = 26). Protocols with no listing date are
 *  in neither side. */
export function walkForward(rows: FitRow[], model: ModelName, cats: string[]): number {
  const train: number[] = [];
  const test: number[] = [];
  rows.forEach((r, i) => {
    if (r.p.listed_at === null) return;
    if (r.p.listed_at < '2025-01-01') train.push(i);
    else test.push(i);
  });
  return errorOn(rows, model, cats, train, test);
}

/** Older-to-newer: sort by age with unlisted protocols counted as age 0
 *  (newest), train on the oldest 70%, test on the newest 30%. */
export function olderToNewer(rows: FitRow[], model: ModelName, cats: string[], asOf: string): number {
  const order = rows
    .map((r, i) => ({ i, age: ageDays(r.p, asOf) ?? 0 }))
    .sort((a, b) => b.age - a.age)
    .map((o) => o.i);
  const nTrain = Math.floor(rows.length * 0.7);
  return errorOn(rows, model, cats, order.slice(0, nTrain), order.slice(nTrain));
}

export function heldOutAll(rows: FitRow[], model: ModelName, cats: string[], asOf: string): HeldOut {
  const loo = leaveOneOut(rows, model, cats);
  const tenFoldV = tenFold(rows, model, cats);
  const wf = walkForward(rows, model, cats);
  const o2n = olderToNewer(rows, model, cats, asOf);
  return { loo, tenFold: tenFoldV, walkForward: wf, olderToNewer: o2n, sum: loo + tenFoldV + wf + o2n };
}

/** The selection rule: lowest sum of the four median ratio errors. */
export function selectModel(rows: FitRow[], cats: string[], asOf: string): { fits: ModelFit[]; held: Record<ModelName, HeldOut>; winner: ModelName } {
  const fits = MODELS.map((m) => fitModel(rows, m, cats));
  const held = {} as Record<ModelName, HeldOut>;
  for (const m of MODELS) held[m] = heldOutAll(rows, m, cats, asOf);
  let winner: ModelName = 'M0';
  let best = Infinity;
  for (const m of MODELS) {
    if (held[m].sum < best) {
      best = held[m].sum;
      winner = m;
    }
  }
  return { fits, held, winner };
}

// ---- conformal intervals (80th percentile of |residual|, per category) ----

export interface Conformal {
  global: number;
  byCategory: Map<string, number>;
}

export function conformal(rows: FitRow[], fit: ModelFit, cats: string[]): Conformal {
  const X = designMatrix(rows, fit.name, cats);
  const pred = predictRow(X, fit.beta);
  const absResid = rows.map((r, i) => Math.abs(r.y - pred[i]!));
  const byCategory = new Map<string, number>();
  const catsSeen = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const c = r.p.category ?? 'None';
    const arr = catsSeen.get(c) ?? [];
    arr.push(absResid[i]!);
    catsSeen.set(c, arr);
  });
  for (const [c, arr] of catsSeen) {
    // A category with fewer than 6 fit points borrows the global width.
    byCategory.set(c, arr.length >= 6 ? quantileLinear(arr, 0.8) : quantileLinear(absResid, 0.8));
  }
  return { global: quantileLinear(absResid, 0.8), byCategory };
}

export function intervalFor(p: Protocol, conf: Conformal): number {
  return conf.byCategory.get(p.category ?? 'None') ?? conf.global;
}

// ---- token odds: ridge-logistic vs Weibull age-only vs category-share ----

export interface OddsFeatures {
  logTvl: number;
  logAge: number; // log(age_days + 1), null-age imputed to the median age
  growth: number; // clipped per cent
  category: string;
}

export function oddsFeatures(snap: Snapshot): OddsFeatures[] {
  const ages = snap.protocols.map((p) => ageDays(p, snap.as_of)).filter((a): a is number => a !== null);
  const medAge = median(ages);
  return snap.protocols.map((p) => ({
    logTvl: Math.log(p.tvl_usd),
    logAge: Math.log((ageDays(p, snap.as_of) ?? medAge) + 1),
    growth: growthClipped(p),
    category: p.category ?? 'None',
  }));
}

export function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

export interface LogisticModel {
  intercept: number;
  bLogTvl: number;
  bLogAge: number;
  bGrowth: number;
  catBeta: Map<string, number>;
  means: { logTvl: number; logAge: number; growth: number };
  sds: { logTvl: number; logAge: number; growth: number };
  categories: string[];
}

const LOGISTIC_LAMBDA = 1.0;
const LOGISTIC_ITERS = 2000;
const LOGISTIC_LR = 0.1;

/** Ridge-logistic by gradient descent on standardized continuous features and
 *  one-hot categories. The growth feature uses the clipped PER CENT value
 *  (an earlier version clipped as if it were a fraction, which killed the
 *  feature for ~90% of protocols). */
export function fitLogistic(feats: OddsFeatures[], y: number[], trainIdx: number[]): LogisticModel {
  const categories = [...new Set(feats.map((f) => f.category))].sort();
  const tr = trainIdx;
  const logTvl = tr.map((i) => feats[i]!.logTvl);
  const logAge = tr.map((i) => feats[i]!.logAge);
  const growth = tr.map((i) => feats[i]!.growth);
  const means = { logTvl: mean(logTvl), logAge: mean(logAge), growth: mean(growth) };
  const sds = { logTvl: std(logTvl), logAge: std(logAge), growth: std(growth) };
  const p = 4 + categories.length;
  const X: number[][] = tr.map((i) => {
    const f = feats[i]!;
    const row = [1, (f.logTvl - means.logTvl) / sds.logTvl, (f.logAge - means.logAge) / sds.logAge, (f.growth - means.growth) / sds.growth];
    for (const c of categories) row.push(f.category === c ? 1 : 0);
    return row;
  });
  const beta = new Array<number>(p).fill(0);
  for (let it = 0; it < LOGISTIC_ITERS; it++) {
    const grad = new Array<number>(p).fill(0);
    for (let r = 0; r < tr.length; r++) {
      const z = X[r]!.reduce((s, x, j) => s + x * beta[j]!, 0);
      const err = sigmoid(z) - y[tr[r]!]!;
      for (let j = 0; j < p; j++) grad[j]! += X[r]![j]! * err;
    }
    for (let j = 0; j < p; j++) {
      const pen = j === 0 ? 0 : LOGISTIC_LAMBDA * beta[j]!;
      beta[j]! -= (LOGISTIC_LR * (grad[j]! + pen)) / tr.length;
    }
  }
  const catBeta = new Map<string, number>();
  categories.forEach((c, k) => catBeta.set(c, beta[4 + k]!));
  return {
    intercept: beta[0]!, bLogTvl: beta[1]!, bLogAge: beta[2]!, bGrowth: beta[3]!,
    catBeta, means, sds, categories,
  };
}

export function logisticPredict(m: LogisticModel, f: OddsFeatures): number {
  const z = m.intercept
    + m.bLogTvl * ((f.logTvl - m.means.logTvl) / m.sds.logTvl)
    + m.bLogAge * ((f.logAge - m.means.logAge) / m.sds.logAge)
    + m.bGrowth * ((f.growth - m.means.growth) / m.sds.growth)
    + (m.catBeta.get(f.category) ?? 0);
  return sigmoid(z);
}

/** Age-only Weibull for the token event, fitted by maximum likelihood on
 *  current-status data (a protocol with a token contributes its density at
 *  its age; one without contributes survival to its age). Grid search over
 *  shape k and scale in years. */
export function fitWeibull(ageYears: number[], y: number[], trainIdx: number[]): { k: number; lambda: number } {
  let best = { nll: Infinity, k: 0.75, lambda: 22 };
  for (let k = 0.3; k <= 3.001; k += 0.02) {
    for (let lam = 1; lam <= 100; lam += 1) {
      let nll = 0;
      for (const i of trainIdx) {
        const t = Math.max(ageYears[i]!, 0.01);
        const lt = Math.log(t);
        const pow = (t / lam) ** k;
        if (y[i] === 1) nll -= Math.log(k) - k * Math.log(lam) + (k - 1) * lt - pow;
        else nll += pow;
      }
      if (nll < best.nll) best = { nll, k, lambda: lam };
    }
  }
  return { k: best.k, lambda: best.lambda };
}

export function weibullHasToken(k: number, lambda: number, ageYears: number): number {
  const t = Math.max(ageYears, 0.01);
  return 1 - Math.exp(-((t / lambda) ** k));
}

/** 12-month forward launch odds from the Weibull hazard: P(launch in the
 *  next 12 months | no token yet at this age). Falls with age when k < 1. */
export function weibullForwardOdds(k: number, lambda: number, ageYears: number): number {
  const a = Math.max(ageYears, 0);
  return 1 - Math.exp(-(((a + 1) / lambda) ** k) + ((a / lambda) ** k));
}

export function brier(pred: number[], y: number[]): number {
  return mean(pred.map((p, i) => (p - y[i]!) ** 2));
}

export interface OddsComparison {
  logisticCv: number;
  weibullCv: number;
  categoryShareCv: number;
  baseRate: number;
  baseBrier: number;
  winner: 'logistic' | 'weibull' | 'category-share';
  logistic: LogisticModel;
  weibull: { k: number; lambda: number };
  categoryShare: Map<string, number>;
}

export function compareOdds(snap: Snapshot, feats: OddsFeatures[]): OddsComparison {
  // The odds target is a token WITH A RECORDED MARKET CAP (mcap > 0, 128 of
  // 758, base rate 0.169) — not merely a token record (416 of 758). A token
  // with no measurable market cap is not a launch the board can value.
  const y = snap.protocols.map((p) => (p.mcap_usd !== null && p.mcap_usd > 0 ? 1 : 0));
  const baseRate = mean(y);
  const baseBrier = mean(y.map((v) => (v - baseRate) ** 2));
  const rng = new PythonRandom(FOLD_SEED);
  const perm = rng.shuffle(Array.from({ length: y.length }, (_, i) => i));
  const folds: number[][] = [];
  for (let k = 0; k < 10; k++) folds.push(perm.filter((_, j) => j % 10 === k));
  const predLog = new Array<number>(y.length).fill(0);
  const predWei = new Array<number>(y.length).fill(0);
  const predShare = new Array<number>(y.length).fill(0);
  const ages = snap.protocols.map((p) => {
    const a = ageDays(p, snap.as_of);
    return a === null ? 0 : a / 365;
  });
  const allAges = ages.filter((a) => a > 0);
  const medAgeY = median(allAges);
  const ageY = ages.map((a) => (a === 0 ? medAgeY : a));
  for (const test of folds) {
    const testSet = new Set(test);
    const train = perm.filter((i) => !testSet.has(i));
    const lm = fitLogistic(feats, y, train);
    for (const i of test) predLog[i] = logisticPredict(lm, feats[i]!);
    const w = fitWeibull(ageY, y, train);
    for (const i of test) predWei[i] = weibullHasToken(w.k, w.lambda, ageY[i]!);
    const byCat = new Map<string, number[]>();
    for (const i of train) {
      const c = feats[i]!.category;
      const arr = byCat.get(c) ?? [];
      arr.push(y[i]!);
      byCat.set(c, arr);
    }
    for (const i of test) {
      const arr = byCat.get(feats[i]!.category);
      predShare[i] = arr && arr.length > 0 ? mean(arr) : baseRate;
    }
  }
  const logisticCv = brier(predLog, y);
  const weibullCv = brier(predWei, y);
  const categoryShareCv = brier(predShare, y);
  const allIdx = Array.from({ length: y.length }, (_, i) => i);
  const logistic = fitLogistic(feats, y, allIdx);
  const weibull = fitWeibull(ageY, y, allIdx);
  const shareMap = new Map<string, number>();
  const byCatAll = new Map<string, number[]>();
  for (let i = 0; i < y.length; i++) {
    const c = feats[i]!.category;
    const arr = byCatAll.get(c) ?? [];
    arr.push(y[i]!);
    byCatAll.set(c, arr);
  }
  for (const [c, arr] of byCatAll) shareMap.set(c, mean(arr));
  let winner: OddsComparison['winner'] = 'logistic';
  if (weibullCv < logisticCv && weibullCv < categoryShareCv) winner = 'weibull';
  else if (categoryShareCv < logisticCv && categoryShareCv < weibullCv) winner = 'category-share';
  return { logisticCv, weibullCv, categoryShareCv, baseRate, baseBrier, winner, logistic, weibull, categoryShare: shareMap };
}

/** The board's odds: the CV winner's prediction for this protocol. */
export function oddsFor(cmp: OddsComparison, snap: Snapshot, feats: OddsFeatures[], idx: number): number {
  if (cmp.winner === 'logistic') return logisticPredict(cmp.logistic, feats[idx]!);
  if (cmp.winner === 'weibull') {
    const a = ageDays(snap.protocols[idx]!, snap.as_of);
    const ageY = a === null ? 0 : a / 365;
    return weibullHasToken(cmp.weibull.k, cmp.weibull.lambda, ageY);
  }
  return cmp.categoryShare.get(feats[idx]!.category) ?? cmp.baseRate;
}

// ---- candidate / exclusion rules ----

export const EXCLUDED_CATEGORIES = new Set(['CEX', 'Canonical Bridge', 'Bridge', 'Liquid Staking', 'Restaked BTC', 'Anchor BTC']);
export const EXCLUDE_PATTERN = /wrapped|staked|bridge|version|exchange|v2|v3|btc|bitcoin/i;

export function exclusionReason(p: Protocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
    return `category ${p.category} is a wrapped, staked or bridged product or an exchange, not a protocol waiting on its own launch`;
  }
  if (EXCLUDE_PATTERN.test(p.name) || EXCLUDE_PATTERN.test(p.slug)) {
    return 'name or slug marks it as a wrapped, staked or bridged product, a versioned release, an exchange or a bitcoin wrapper';
  }
  return null;
}

export function isCandidate(p: Protocol): boolean {
  return isPreToken(p) && exclusionReason(p) === null;
}

// ---- farm plans: costed by chain gas, sized to minimum viable capital ----

export const GAS_USD: Record<string, number> = {
  Ethereum: 8,
  Arbitrum: 0.3,
  Optimism: 0.1,
  Base: 0.05,
  Polygon: 0.05,
  BSC: 0.2,
  Binance: 0.2, // DefiLlama's label for the same chain as BSC
  Avalanche: 0.3,
  Solana: 0.002,
};
export const GAS_DEFAULT = 1;
export const BRIDGE_USD = 5;

export function gasFor(chain: string): number {
  return GAS_USD[chain] ?? GAS_DEFAULT;
}

export function primaryChain(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
}

export function farmCost(p: Protocol, steps = 6): { cost: number; gasPerStep: number; bridge: number } {
  const gasPerStep = gasFor(primaryChain(p));
  const bridge = p.chains.length > 1 ? BRIDGE_USD : 0;
  return { cost: steps * gasPerStep + bridge, gasPerStep, bridge };
}

export function minCapital(cost: number): number {
  return Math.max(50, 10 * cost);
}

export type Verdict = 'farm' | 'watch' | 'thin';

export function verdictFor(ev: number, odds: number, cost: number): Verdict {
  if (ev >= 3 * cost && odds >= 0.05) return 'farm';
  if (ev >= cost) return 'watch';
  return 'thin';
}

function money(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function categoryAction(category: string | null): { first: string; second: string } {
  switch (category) {
    case 'Lending':
      return {
        first: 'supply stablecoins to its lending market and hold the supply position',
        second: 'borrow a small amount against the supply, then repay it in full',
      };
    case 'Dexs':
      return {
        first: 'swap into the pool and add liquidity to its largest pair',
        second: 'remove half the liquidity, then add it back to show a second interaction',
      };
    case 'Yield':
    case 'Yield Aggregator':
      return {
        first: 'deposit into its highest-TVL vault and hold the vault shares',
        second: 'deposit a second, smaller amount into a different vault of the same protocol',
      };
    case 'Derivatives':
      return {
        first: 'open a small long position on its main market and hold it for a week',
        second: 'close the position and open a second one in the opposite direction',
      };
    case 'RWA':
      return {
        first: 'buy a small position in its tokenized real-world asset offering',
        second: 'hold the position and claim any yield it distributes',
      };
    case 'Basis Trading':
      return {
        first: 'enter its basis trade with a small notional and hold it for a week',
        second: 'close the basis trade and re-enter once to show repeated use',
      };
    case 'Restaking':
      return {
        first: 'restake a small amount through its restaking flow and hold the receipt token',
        second: 'delegate the receipt token to a second operator',
      };
    case 'CDP':
      return {
        first: 'mint a small amount of its stablecoin against collateral and hold it',
        second: 'repay the mint in full, then mint once more',
      };
    default:
      return {
        first: 'use its main feature with a small amount and hold the resulting position',
        second: 'use a second feature of the same protocol so the wallet shows more than one interaction type',
      };
  }
}

/** Six concrete steps for one candidate, each 20-600 characters, naming the
 *  protocol, its real primary chain and category, with a dollar cost and a
 *  time estimate per step. */
export function farmSteps(p: Protocol, minCap: number, costInfo: { cost: number; gasPerStep: number; bridge: number }): string[] {
  const chain = primaryChain(p);
  const second = p.chains.length > 1 ? p.chains[1]! : null;
  const gas = money(costInfo.gasPerStep);
  const act = categoryAction(p.category);
  const amt = money(Math.max(25, Math.round(minCap / 4)));
  const steps: string[] = [
    `Fund a fresh wallet on ${chain} with at least ${money(minCap)} in USDC plus ${gas} for fees, and keep this wallet dedicated to ${p.name} so every action is attributable to one address. Cost ${gas}, about 10 minutes.`,
    `On ${chain}, ${act.first} with about ${amt} of capital; this is the protocol's core action and the one a future allocation would weight most. Cost ${gas}, about 15 minutes.`,
    `Still on ${chain}, ${act.second}; a second interaction type matters because a single one-off deposit reads as airdrop farming rather than use. Cost ${gas}, about 15 minutes.`,
  ];
  if (second !== null) {
    steps.push(`Bridge about ${amt} from ${chain} to ${second} (bridge about $${BRIDGE_USD}) and repeat the ${p.category ?? 'main'} action there; the bridge doubles the on-chain footprint for one extra fee. Cost ${money(costInfo.gasPerStep + BRIDGE_USD)}, about 20 minutes.`);
  } else {
    steps.push(`Use ${p.name} on ${chain} a second time through a different entry point — a different pool or vault — so the wallet shows depth on one chain rather than a single transaction. Cost ${gas}, about 15 minutes.`);
  }
  steps.push(
    `Return weekly for at least 8 weeks and repeat a small ${p.category ?? 'core'} action each visit, about 10 minutes per visit, so the activity reads as sustained use rather than a one-day grab before a snapshot. Cost ${gas} per visit.`,
    `Save every transaction hash and a screenshot of the ${p.name} position page; if ${p.name} announces a token, verify the claim link from its official documentation before signing anything, then claim and decide whether to hold or sell. Cost ${gas}, about 10 minutes.`,
  );
  return steps;
}

// ---- peer anchor: nearest traded protocol, same category, closest log TVL ----

export interface PeerAnchor {
  name: string;
  slug: string;
  mcap_usd: number;
  tvl_usd: number;
  category: string | null;
}

export function peerAnchor(p: Protocol, traded: Protocol[]): PeerAnchor | null {
  // An anchor needs an observed market cap: 272 of the 416 traded protocols
  // record a token but no market cap, and they cannot anchor anything.
  const withMcap = traded.filter((t) => t.mcap_usd !== null && t.mcap_usd > 0);
  if (withMcap.length === 0) return null;
  const logTvl = Math.log(p.tvl_usd);
  let best: Protocol | null = null;
  let bestDist = Infinity;
  for (const t of withMcap) {
    if (t.category !== p.category) continue;
    const d = Math.abs(Math.log(t.tvl_usd) - logTvl);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  if (best === null) {
    for (const t of withMcap) {
      const d = Math.abs(Math.log(t.tvl_usd) - logTvl);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
  }
  if (best === null || best.mcap_usd === null) return null;
  return { name: best.name, slug: best.slug, mcap_usd: best.mcap_usd, tvl_usd: best.tvl_usd, category: best.category };
}

// ---- the radar: board, anchors, exclusions, and everything the page shows ----

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  status: 'candidate';
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  odds: number;
  ev_usd: number;
  lo_usd: number;
  hi_usd: number;
  interval_log: number;
  min_capital_usd: number;
  farm_cost_usd: number;
  verdict: Verdict;
  break_even_x: number;
  watchlist: boolean;
  peer_anchor: PeerAnchor | null;
}

export interface TradedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  in_fit: boolean;
}

export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
  implied_value_usd: number;
}

export interface Radar {
  asOf: string;
  source: string;
  counts: { protocols: number; traded: number; preToken: number; candidates: number; excluded: number; fit: number; watchlist: number };
  model: { winner: ModelName; beta: number[]; r2: number; medianErr: number; formula: string };
  ablation: { model: ModelName; loo: number; tenFold: number; walkForward: number; olderToNewer: number; sum: number }[];
  conformal: { global: number; byCategory: Record<string, number> };
  odds: { logisticCv: number; weibullCv: number; categoryShareCv: number; baseRate: number; baseBrier: number; winner: string; weibullK: number; weibullLambda: number; logisticAgeBeta: number };
  board: BoardRow[];
  traded: TradedRow[];
  excluded: ExcludedRow[];
  earlySize: number;
  liveSize: number;
}

export function buildRadar(snap: Snapshot): { board: BoardRow[]; radar: Radar } {
  const rows = buildFitRows(snap);
  const cats = topCategories(rows, 8);
  const { fits, held, winner } = selectModel(rows, cats, snap.as_of);
  const winFit = fits.find((f) => f.name === winner)!;
  const conf = conformal(rows, winFit, cats);
  const feats = oddsFeatures(snap);
  const oddsCmp = compareOdds(snap, feats);
  const snapIdx = new Map(snap.protocols.map((p, i) => [p.slug, i]));

  const traded = snap.protocols.filter((p) => hasToken(p));
  const preToken = snap.protocols.filter((p) => isPreToken(p));
  const candidates = preToken.filter((p) => isCandidate(p));
  const excluded = preToken.filter((p) => !isCandidate(p));
  const fitSlugs = new Set(rows.map((r) => r.p.slug));

  // The winner's prediction for every protocol, from its own feature row.
  const predictFor = (p: Protocol): number => {
    const r: FitRow = {
      p,
      y: 0,
      logTvl: Math.log(p.tvl_usd),
      growth: growthClipped(p),
      age: ageDays(p, snap.as_of) ?? median(rows.map((x) => x.age)),
    };
    const X = designMatrix([r], winner, cats)[0]!;
    return X.reduce((s, x, j) => s + x * winFit.beta[j]!, 0);
  };

  const watchSet = new Set(snap.watchlist);
  const scored = candidates
    .map((p) => {
      const logPred = predictFor(p);
      const implied = Math.exp(logPred);
      const idx = snapIdx.get(p.slug)!;
      const odds = oddsFor(oddsCmp, snap, feats, idx);
      const ev = implied * odds;
      const q = intervalFor(p, conf);
      const lo = Math.exp(logPred - q);
      const hi = Math.exp(logPred + q);
      const costInfo = farmCost(p, 6);
      const minCap = minCapital(costInfo.cost);
      return { p, implied, odds, ev, lo, hi, q, costInfo, minCap };
    })
    .sort((a, b) => b.implied - a.implied);

  const board: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: Math.max(1, Math.round(s.implied)),
    farm_steps: farmSteps(s.p, s.minCap, s.costInfo),
    status: 'candidate',
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: ageDays(s.p, snap.as_of),
    odds: s.odds,
    ev_usd: Math.round(s.ev),
    lo_usd: Math.max(1, Math.round(s.lo)),
    hi_usd: Math.round(s.hi),
    interval_log: s.q,
    min_capital_usd: Math.round(s.minCap * 100) / 100,
    farm_cost_usd: Math.round(s.costInfo.cost * 100) / 100,
    verdict: verdictFor(s.ev, s.odds, s.costInfo.cost),
    break_even_x: s.ev > 0 ? s.costInfo.cost / s.ev : Infinity,
    watchlist: watchSet.has(s.p.slug),
    peer_anchor: peerAnchor(s.p, traded),
  }));

  const tradedRows: TradedRow[] = traded
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      multiple: p.mcap_usd !== null && p.mcap_usd > 0 ? p.mcap_usd / p.tvl_usd : 0,
      in_fit: fitSlugs.has(p.slug),
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);

  const excludedRows: ExcludedRow[] = excluded
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      reason: exclusionReason(p) ?? 'excluded',
      implied_value_usd: Math.max(1, Math.round(Math.exp(predictFor(p)))),
    }))
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd);

  const formula = winner === 'M0'
    ? `log(mcap) = ${winFit.beta[0]!.toFixed(4)} + ${winFit.beta[1]!.toFixed(4)} x log(TVL)`
    : winner === 'M1'
      ? `log(mcap) = ${winFit.beta[0]!.toFixed(4)} + ${winFit.beta[1]!.toFixed(4)} x log(TVL) + ${winFit.beta[2]!.toFixed(4)} x growth`
      : winner === 'M2'
        ? `log(mcap) = ${winFit.beta[0]!.toFixed(4)} + ${winFit.beta[1]!.toFixed(4)} x log(TVL) + ${winFit.beta[2]!.toFixed(4)} x growth + ${winFit.beta[3]!.toFixed(6)} x age`
        : `log(mcap) = ${winFit.beta[0]!.toFixed(4)} + ${winFit.beta[1]!.toFixed(4)} x log(TVL) + ${winFit.beta[2]!.toFixed(4)} x growth + ${winFit.beta[3]!.toFixed(6)} x age + 8 category terms`;

  const radar: Radar = {
    asOf: snap.as_of,
    source: snap.source,
    counts: {
      protocols: snap.protocols.length,
      traded: traded.length,
      preToken: preToken.length,
      candidates: candidates.length,
      excluded: excluded.length,
      fit: rows.length,
      watchlist: snap.watchlist.length,
    },
    model: { winner, beta: winFit.beta, r2: winFit.r2, medianErr: winFit.medianErr, formula },
    ablation: MODELS.map((m) => ({
      model: m,
      loo: held[m].loo,
      tenFold: held[m].tenFold,
      walkForward: held[m].walkForward,
      olderToNewer: held[m].olderToNewer,
      sum: held[m].sum,
    })),
    conformal: {
      global: conf.global,
      byCategory: Object.fromEntries([...conf.byCategory.entries()].sort((a, b) => a[1] - b[1])),
    },
    odds: {
      logisticCv: oddsCmp.logisticCv,
      weibullCv: oddsCmp.weibullCv,
      categoryShareCv: oddsCmp.categoryShareCv,
      baseRate: oddsCmp.baseRate,
      baseBrier: oddsCmp.baseBrier,
      winner: oddsCmp.winner,
      weibullK: oddsCmp.weibull.k,
      weibullLambda: oddsCmp.weibull.lambda,
      logisticAgeBeta: oddsCmp.logistic.bLogAge,
    },
    board,
    traded: tradedRows,
    excluded: excludedRows,
    earlySize: excluded.length,
    liveSize: traded.length,
  };
  return { board, radar };
}

/** The dashboard reads this file: window.RADAR holds the whole radar. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** The gate's shape, checked before anything is written: ranks 1..N, implied
 *  value non-increasing with rank, every watchlist slug covered, farm steps
 *  3-12 strings of 20-600 characters each. Returns the first problem, if any. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, the gate wants 100 to 4000`;
  const seen = new Set<string>();
  let prev = Infinity;
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (row.rank !== i + 1) return `row ${i} has rank ${row.rank}, expected ${i + 1}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `row ${row.slug} has a non-positive implied value`;
    if (row.implied_value_usd > prev) return `implied value rises at rank ${row.rank}`;
    prev = row.implied_value_usd;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const s of row.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${row.slug} has a farm step of ${t.length} characters`;
    }
  }
  for (const w of snap.watchlist) {
    if (!seen.has(w)) return `watchlist slug ${w} is missing from the board`;
  }
  return null;
}
