// Launch Radar v5 model: fitted value model (log-log OLS on the filtered
// traded set), multivariate ridge-logistic token odds, cohort odds,
// conformal intervals, held-out tests (4 directions + placebo + bootstrap
// + blind), full 342-row board with farm verdicts. Node stdlib only.
// Every number is computed at runtime from the snapshot; nothing is
// hardcoded from earlier versions. Mirrors the Python reference exactly
// (same seeds, splits, grids, and definitions).

import { MT19937 } from './mt19937.ts';

export const SEED = 20261114;
export const BLIND_SEED = 20261115;
export const FLOOR_USD = 50_000_000;
export const AS_OF = '2026-11-14';
export const RIDGE_LAM = 1.0;
export const IRLS_ITERS = 25;

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | string | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export function mcapNum(p: Proto): number | null {
  if (p.mcap_usd === null || p.mcap_usd === undefined) return null;
  const v = typeof p.mcap_usd === 'string' ? Number(p.mcap_usd) : p.mcap_usd;
  return Number.isFinite(v) ? v : null;
}

export function hasToken(p: Proto): boolean {
  const m = mcapNum(p);
  return p.gecko_id !== null || p.symbol !== null || (m !== null && m > 0);
}

export function ageDays(p: Proto): number {
  if (!p.listed_at) return 0;
  const a = Date.parse(AS_OF + 'T00:00:00Z');
  const b = Date.parse(p.listed_at + 'T00:00:00Z');
  return Math.max(0, Math.round((a - b) / 86400000));
}

export function growth(p: Proto): number {
  const g = p.change_7d === null || p.change_7d === undefined ? 0 : p.change_7d;
  return Math.max(-50, Math.min(50, g));
}

const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGE_PREFIX =
  /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const FLAGGED_CATS = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

// Why a pre-token protocol is NOT a launch candidate (null = candidate).
export function flagReason(p: Proto): string | null {
  if (FLAGGED_CATS.has(p.category ?? '')) return 'category ' + p.category;
  if (VERSION_RE.test(p.name)) return 'versioned name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped/staked product';
  if (EXCHANGE_PREFIX.test(p.name)) return 'exchange product';
  return null;
}

export function fitset(ps: Proto[]): Proto[] {
  return ps.filter((p) => {
    const m = mcapNum(p);
    if (m === null || m <= 0) return false;
    if (p.tvl_usd < 5_000_000) return false;
    const r = m / p.tvl_usd;
    return r >= 0.01 && r <= 10;
  });
}

// ---------- small numeric helpers ----------

export function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Linear-interpolation percentile (numpy percentile, method='linear').
export function percentile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const rank = (q / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

export function mean(a: number[]): number {
  return a.reduce((s, v) => s + v, 0) / a.length;
}

export function popStd(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) * (v - m))));
}

// Solve A x = b by Gaussian elimination with partial pivoting.
export function solveLinear(Ain: number[][], bin: number[]): number[] {
  const n = bin.length;
  const A = Ain.map((row) => row.slice());
  const b = bin.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (piv !== col) {
      const t = A[col];
      A[col] = A[piv];
      A[piv] = t;
      const tb = b[col];
      b[col] = b[piv];
      b[piv] = tb;
    }
    const d = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

// Ordinary least squares via normal equations. A column that is all zero
// (a category dummy absent from a training split) is dropped from the
// solve and its coefficient set to 0 — the same minimum-norm answer
// numpy lstsq gives for a zero column. Returns coefficients, R^2, median
// exp(|residual|), residuals and predictions.
export function ols(X: number[][], y: number[]) {
  const n = X.length;
  const k = X[0].length;
  const active: number[] = [];
  for (let j = 0; j < k; j++) {
    let nz = false;
    for (let i = 0; i < n; i++) {
      if (X[i][j] !== 0) {
        nz = true;
        break;
      }
    }
    if (nz) active.push(j);
  }
  const ka = active.length;
  const XtX: number[][] = Array.from({ length: ka }, () => new Array(ka).fill(0));
  const Xty: number[] = new Array(ka).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < ka; a++) {
      Xty[a] += X[i][active[a]] * y[i];
      for (let b = 0; b < ka; b++) XtX[a][b] += X[i][active[a]] * X[i][active[b]];
    }
  }
  const betaA = solveLinear(XtX, Xty);
  const beta = new Array(k).fill(0);
  active.forEach((j, a) => (beta[j] = betaA[a]));
  const pred = X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const resid = y.map((v, i) => v - pred[i]);
  const ym = mean(y);
  const ssTot = y.reduce((s, v) => s + (v - ym) * (v - ym), 0);
  const ssRes = resid.reduce((s, v) => s + v * v, 0);
  const r2 = 1 - ssRes / ssTot;
  const med = median(resid.map((r) => Math.exp(Math.abs(r))));
  return { beta, r2, med, resid, pred };
}

export function medErr(X: number[][], y: number[]): number {
  return ols(X, y).med;
}

// ---------- value model (M0/M1/M2/M5) ----------

export type ModelName = 'M0' | 'M1' | 'M2' | 'M5';

export function design(
  ps: Proto[],
  model: ModelName,
  catDummies: string[],
): { X: number[][]; y: number[]; names: string[] } {
  const X: number[][] = [];
  const y: number[] = [];
  const names = ['const', 'lnTVL'];
  if (model !== 'M0') names.push('growth');
  if (model === 'M2' || model === 'M5') names.push('age_yrs');
  if (model === 'M5') for (const c of catDummies) names.push('cat_' + c);
  for (const p of ps) {
    const m = mcapNum(p);
    if (m === null || m <= 0) continue;
    const row = [1, Math.log(p.tvl_usd)];
    if (model !== 'M0') row.push(growth(p));
    if (model === 'M2' || model === 'M5') {
      row.push(ageDays(p) / 365.25);
    }
    if (model === 'M5') {
      for (const c of catDummies) {
        row.push(p.category === c ? 1 : 0);
      }
    }
    X.push(row);
    y.push(Math.log(m));
  }
  return { X, y, names };
}

export function topCategories(
  ps: Proto[],
  limit: number,
  minCount: number,
): string[] {
  const counts = new Map<string, number>();
  for (const p of ps) {
    if (!p.category) continue;
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  const entries = [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1]); // stable: ties keep first-encounter order
  return entries.slice(0, limit).map(([c]) => c);
}

// Held-out ablation. WF = dated-only split (train listed_at < 2025-01-01,
// test >= 2025-01-01); O2N = oldest 70% train, newest 30% test.
export function ablation(fit: Proto[]) {
  const top = topCategories(fit, 8, 0);
  const catDummies = top.slice(1);
  const n = fit.length;
  const perm = new MT19937(SEED).shuffle(
    Array.from({ length: n }, (_, i) => i),
  );
  const folds: number[][] = [];
  for (let k = 0; k < 10; k++) {
    const f: number[] = [];
    for (let i = k; i < n; i += 10) f.push(perm[i]);
    folds.push(f);
  }
  const dated = fit.filter((p) => p.listed_at !== null);
  const wfTrain = dated.filter((p) => (p.listed_at as string) < '2025-01-01');
  const wfTest = dated.filter((p) => (p.listed_at as string) >= '2025-01-01');
  const byAge = fit
    .map((p, i) => ({ i, a: ageDays(p) }))
    .sort((x, y) => y.a - x.a); // stable: ties keep snapshot order
  const o2nCut = Math.floor(0.7 * n);
  const o2nTrain = byAge.slice(0, o2nCut).map((o) => fit[o.i]);
  const o2nTest = byAge.slice(o2nCut).map((o) => fit[o.i]);

  const out: Record<string, Record<string, number>> = {};
  const models: ModelName[] = ['M0', 'M1', 'M2', 'M5'];
  let m1Beta: number[] = [];
  for (const m of models) {
    const { X, y, names } = design(fit, m, catDummies);
    // LOO
    const looErrs: number[] = [];
    for (let i = 0; i < n; i++) {
      const Xk = X.filter((_, j) => j !== i);
      const yk = y.filter((_, j) => j !== i);
      const b = ols(Xk, yk).beta;
      const pred = X[i].reduce((s, v, j) => s + v * b[j], 0);
      looErrs.push(Math.abs(y[i] - pred));
    }
    const loo = median(looErrs.map((e) => Math.exp(e)));
    // 10-fold
    const f10Errs: number[] = [];
    for (let k = 0; k < 10; k++) {
      const te = new Set(folds[k]);
      const Xtr = X.filter((_, j) => !te.has(j));
      const ytr = y.filter((_, j) => !te.has(j));
      const b = ols(Xtr, ytr).beta;
      for (const j of folds[k]) {
        const pred = X[j].reduce((s, v, jj) => s + v * b[jj], 0);
        f10Errs.push(Math.abs(y[j] - pred));
      }
    }
    const f10 = median(f10Errs.map((e) => Math.exp(e)));
    // walk-forward (dated only)
    const wf = (() => {
      const d = design(wfTrain, m, catDummies);
      const b = ols(d.X, d.y).beta;
      const dt = design(wfTest, m, catDummies);
      const errs = dt.y.map((v, i) =>
        Math.abs(v - dt.X[i].reduce((s, x, j) => s + x * b[j], 0)),
      );
      return median(errs.map((e) => Math.exp(e)));
    })();
    // older-to-newer
    const o2n = (() => {
      const d = design(o2nTrain, m, catDummies);
      const b = ols(d.X, d.y).beta;
      const dt = design(o2nTest, m, catDummies);
      const errs = dt.y.map((v, i) =>
        Math.abs(v - dt.X[i].reduce((s, x, j) => s + x * b[j], 0)),
      );
      return median(errs.map((e) => Math.exp(e)));
    })();
    const full = ols(X, y);
    out[m] = {
      loo,
      f10,
      wf,
      o2n,
      sum: loo + f10 + wf + o2n,
      r2: full.r2,
      med: full.med,
      nTestWf: wfTest.length,
      nTestO2n: o2nTest.length,
    };
    if (m === 'M1') m1Beta = full.beta;
  }
  return { table: out, catDummies, refCat: top[0], nFit: n, m1Beta };
}

// ---------- token odds ----------

export function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

// Ridge logistic by IRLS: fixed 25 iterations from beta=0, intercept
// (column 0) unpenalised, lambda=1.0.
export function ridgeLogitFit(
  X: number[][],
  y: number[],
  lam: number = RIDGE_LAM,
  iters: number = IRLS_ITERS,
): number[] {
  const n = X.length;
  const k = X[0].length;
  let beta = new Array(k).fill(0);
  const P: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j && i !== 0 ? lam : 0)),
  );
  for (let it = 0; it < iters; it++) {
    const p: number[] = [];
    const W: number[] = [];
    const z: number[] = [];
    for (let i = 0; i < n; i++) {
      const lin = X[i].reduce((s, v, j) => s + v * beta[j], 0);
      const pi = sigmoid(lin);
      const w = pi * (1 - pi) + 1e-9;
      p.push(pi);
      W.push(w);
      z.push(lin + (y[i] - pi) / w);
    }
    const A: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
    const b: number[] = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < k; a++) {
        b[a] += X[i][a] * W[i] * z[i];
        for (let c = 0; c < k; c++) A[a][c] += X[i][a] * W[i] * X[i][c];
      }
    }
    for (let a = 0; a < k; a++) {
      for (let c = 0; c < k; c++) A[a][c] += P[a][c];
    }
    beta = solveLinear(A, b);
  }
  return beta;
}

export function brier(p: number[], y: number[]): number {
  return mean(p.map((v, i) => (v - y[i]) * (v - y[i])));
}

// Raw (unstandardised) logistic features: [1, lnTVL, age_yrs, growth, dummies].
export function rawLogitFeatures(
  ps: Proto[],
  cats: string[],
): { X: number[][]; names: string[] } {
  const X: number[][] = [];
  const names = ['const', 'lnTVL', 'age_yrs', 'growth'];
  for (const c of cats) names.push('cat_' + c);
  for (const p of ps) {
    const row = [1, Math.log(p.tvl_usd), ageDays(p) / 365.25, growth(p)];
    for (const c of cats) row.push(p.category === c ? 1 : 0);
    X.push(row);
  }
  return { X, names };
}

// Standardise non-intercept columns by train mean/std (population std).
// Returns standardised train, standardised test (or null), mu, sd.
export function standardize(
  Xtr: number[][],
  Xte: number[][] | null,
): { Ztr: number[][]; Zte: number[][] | null; mu: number[]; sd: number[] } {
  const k = Xtr[0].length;
  const mu: number[] = [0];
  const sd: number[] = [1];
  for (let j = 1; j < k; j++) {
    const col = Xtr.map((r) => r[j]);
    mu.push(mean(col));
    const s = popStd(col);
    sd.push(s === 0 ? 1 : s);
  }
  const std = (row: number[]) =>
    row.map((v, j) => (j === 0 ? v : (v - mu[j]) / sd[j]));
  return {
    Ztr: Xtr.map(std),
    Zte: Xte ? Xte.map(std) : null,
    mu,
    sd,
  };
}

// Right-censored Weibull log-likelihood. ages in years, floored at 1 day.
export function weibullLoglik(
  ages: number[],
  events: number[],
  k: number,
  lam: number,
): number {
  let ll = 0;
  for (let i = 0; i < ages.length; i++) {
    const t = Math.max(ages[i], 1 / 365.25);
    const r = t / lam;
    if (events[i] === 1) {
      ll += Math.log(k / lam) + (k - 1) * Math.log(r) - Math.pow(r, k);
    } else {
      ll += -Math.pow(r, k);
    }
  }
  return ll;
}

// Grid MLE for (k, lambda). Coarse grid for CV folds, fine grid + local
// refine for the full-data fit. Grids are integer-indexed so both languages
// visit identical points.
export function weibullFit(
  ages: number[],
  events: number[],
  coarse: boolean,
): { k: number; lam: number } {
  let best = { ll: -Infinity, k: 0, lam: 0 };
  const consider = (k: number, lam: number) => {
    const ll = weibullLoglik(ages, events, k, lam);
    if (ll > best.ll) best = { ll, k, lam };
  };
  if (coarse) {
    for (let i = 0; i <= 54; i++) {
      const k = (30 + 5 * i) / 100;
      for (let j = 0; j <= 59; j++) {
        consider(k, 1 + j);
      }
    }
  } else {
    for (let i = 0; i <= 270; i++) {
      const k = (30 + i) / 100;
      for (let j = 0; j <= 118; j++) {
        consider(k, (2 + j) / 2);
      }
    }
    const bk = best.k;
    const bl = best.lam;
    for (let i = 0; i <= 40; i++) {
      const k = bk - 0.02 + (i * 0.001);
      if (k <= 0.05) continue;
      for (let j = 0; j <= 20; j++) {
        const lam = bl - 0.5 + j * 0.05;
        if (lam < 0.5) continue;
        consider(k, lam);
      }
    }
  }
  return { k: best.k, lam: best.lam };
}

export function oddsPart(ps: Proto[]) {
  const n = ps.length;
  const y = ps.map((p) => {
    const m = mcapNum(p);
    return m !== null && m > 0 ? 1 : 0;
  });
  const ages = ps.map((p) => ageDays(p) / 365.25);
  const baseRate = mean(y);
  const top = topCategories(ps, 99, 20);
  const cats = top.slice(1);
  const refCat = top[0];
  const { X: Xraw, names } = rawLogitFeatures(ps, cats);
  const perm = new MT19937(SEED).shuffle(
    Array.from({ length: n }, (_, i) => i),
  );
  const folds: number[][] = [];
  for (let k = 0; k < 10; k++) {
    const f: number[] = [];
    for (let i = k; i < n; i += 10) f.push(perm[i]);
    folds.push(f);
  }
  const pLog: number[] = new Array(n).fill(0);
  const pWei: number[] = new Array(n).fill(0);
  const pCat: number[] = new Array(n).fill(0);
  for (let k = 0; k < 10; k++) {
    const teSet = new Set(folds[k]);
    const tr = Array.from({ length: n }, (_, j) => j).filter((j) => !teSet.has(j));
    const te = folds[k];
    const { Ztr, Zte } = standardize(
      tr.map((j) => Xraw[j]),
      te.map((j) => Xraw[j]),
    );
    const b = ridgeLogitFit(Ztr, tr.map((j) => y[j]));
    for (let t = 0; t < te.length; t++) {
      const lin = (Zte as number[][])[t].reduce((s, v, j) => s + v * b[j], 0);
      pLog[te[t]] = sigmoid(lin);
    }
    const w = weibullFit(tr.map((j) => ages[j]), tr.map((j) => y[j]), true);
    for (const j of te) {
      const t = Math.max(ages[j], 1 / 365.25);
      pWei[j] = 1 - Math.exp(-Math.pow(t / w.lam, w.k));
    }
    const rates = new Map<string, number>();
    const byCat = new Map<string, number[]>();
    for (const j of tr) {
      const c = ps[j].category ?? '';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c)?.push(y[j]);
    }
    for (const [c, v] of byCat) rates.set(c, mean(v));
    for (const j of te) {
      pCat[j] = rates.get(ps[j].category ?? '') ?? baseRate;
    }
  }
  const cvLog = brier(pLog, y);
  const cvWei = brier(pWei, y);
  const cvCat = brier(pCat, y);
  const baseBrier = brier(new Array(n).fill(baseRate), y);
  // Full-data fits.
  const { Ztr: Z } = standardize(Xraw, null);
  const beta = ridgeLogitFit(Z, y);
  const wei = weibullFit(ages, y, false);
  const pFull = Z.map((row) =>
    sigmoid(row.reduce((s, v, j) => s + v * beta[j], 0)),
  );
  return {
    y,
    ages,
    cats,
    refCat,
    names,
    beta,
    weibull: wei,
    pFull,
    baseRate,
    baseBrier,
    cv: { logistic: cvLog, weibull: cvWei, catshare: cvCat },
  };
}

export const AGE_BANDS: [number, number][] = [
  [0, 180],
  [180, 365],
  [365, 730],
  [730, 1100],
  [1100, 1e9],
];
export const TVL_BANDS: [number, number][] = [
  [5_000_000, 10_000_000],
  [10_000_000, 25_000_000],
  [25_000_000, 50_000_000],
  [50_000_000, 100_000_000],
  [100_000_000, 500_000_000],
  [500_000_000, 1_000_000_000],
  [1_000_000_000, 1e18],
];

export function cohortTables(ps: Proto[]) {
  const tok = (p: Proto) => {
    const m = mcapNum(p);
    return m !== null && m > 0 ? 1 : 0;
  };
  const age = AGE_BANDS.map(([lo, hi]) => {
    const m = ps.filter((p) => lo <= ageDays(p) && ageDays(p) < hi);
    const t = m.reduce((s, p) => s + tok(p), 0);
    return { lo, hi, n: m.length, tok: t, rate: m.length ? t / m.length : 0 };
  });
  const tvl = TVL_BANDS.map(([lo, hi]) => {
    const m = ps.filter((p) => lo <= p.tvl_usd && p.tvl_usd < hi);
    const t = m.reduce((s, p) => s + tok(p), 0);
    return { lo, hi, n: m.length, tok: t, rate: m.length ? t / m.length : 0 };
  });
  return { age, tvl };
}

export function conformalPart(fit: Proto[]) {
  const { X, y } = design(fit, 'M1', []);
  const { resid } = ols(X, y);
  const absR = resid.map((r) => Math.abs(r)).sort((a, b) => a - b);
  const q80 = percentile(absR, 80);
  const byCat = new Map<string, number[]>();
  fit.forEach((p, i) => {
    const c = p.category ?? '';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)?.push(Math.abs(resid[i]));
  });
  const perCat: { cat: string; n: number; q80: number }[] = [];
  for (const [c, v] of byCat) {
    if (v.length >= 6) {
      perCat.push({
        cat: c,
        n: v.length,
        q80: percentile(v.slice().sort((a, b) => a - b), 80),
      });
    }
  }
  perCat.sort((a, b) => b.n - a.n);
  return { q80, perCat };
}

export function extraTests(fit: Proto[]) {
  const { X, y } = design(fit, 'M1', []);
  const n = fit.length;
  // Placebo: shuffle the target, refit, LOO + R^2.
  const ys = new MT19937(SEED).shuffle(y.slice());
  const pb = ols(X, ys).beta;
  const predP = X.map((row) => row.reduce((s, v, j) => s + v * pb[j], 0));
  const ym = mean(ys);
  const ssTot = ys.reduce((s, v) => s + (v - ym) * (v - ym), 0);
  const ssRes = ys.reduce((s, v, i) => s + (v - predP[i]) * (v - predP[i]), 0);
  const placeboR2 = 1 - ssRes / ssTot;
  const pErrs: number[] = [];
  for (let i = 0; i < n; i++) {
    const Xk = X.filter((_, j) => j !== i);
    const yk = ys.filter((_, j) => j !== i);
    const b = ols(Xk, yk).beta;
    const pred = X[i].reduce((s, v, j) => s + v * b[j], 0);
    pErrs.push(Math.abs(ys[i] - pred));
  }
  const placeboLoo = median(pErrs.map((e) => Math.exp(e)));
  // Bootstrap: 200 resamples, slope + median-error spread.
  const rng = new MT19937(SEED);
  const slopes: number[] = [];
  const meds: number[] = [];
  for (let b = 0; b < 200; b++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(rng.randrange(n));
    const Xb = idx.map((j) => X[j]);
    const yb = idx.map((j) => y[j]);
    const bb = ols(Xb, yb);
    slopes.push(bb.beta[1]);
    meds.push(bb.med);
  }
  const slopeSorted = slopes.slice().sort((a, b) => a - b);
  const slopeCI: [number, number] = [
    percentile(slopeSorted, 2.5),
    percentile(slopeSorted, 97.5),
  ];
  const medRange: [number, number] = [Math.min(...meds), Math.max(...meds)];
  // Blind: 20% holdout, separate seed.
  const perm = new MT19937(BLIND_SEED).shuffle(
    Array.from({ length: n }, (_, i) => i),
  );
  const te = perm.slice(0, 22);
  const tr = perm.slice(22);
  const bBlind = ols(tr.map((j) => X[j]), tr.map((j) => y[j])).beta;
  const blindErrs = te.map((j) => {
    const pred = X[j].reduce((s, v, jj) => s + v * bBlind[jj], 0);
    return Math.abs(y[j] - pred);
  });
  const blindMed = median(blindErrs.map((e) => Math.exp(e)));
  return {
    placebo: { r2: placeboR2, loo: placeboLoo },
    bootstrap: { slopeCI, medRange, B: 200 },
    blind: { med: blindMed, nTest: te.length },
  };
}

// ---------- farm economics ----------

export const GAS: Record<string, number> = {
  Ethereum: 0.32,
  Arbitrum: 0.03,
  Base: 0.02,
  Solana: 0.00025,
  Binance: 0.2,
  BSC: 0.2,
  Optimism: 0.02,
  Polygon: 0.01,
  Avalanche: 0.05,
  Gnosis: 0.05,
  Fantom: 0.05,
  'zkSync Era': 0.03,
  Linea: 0.02,
  Scroll: 0.02,
  Mantle: 0.02,
  Blast: 0.02,
};
export const DEFAULT_GAS = 0.1;
export const AIRDROP_SHARE = 0.05;
export const BRIDGE_FEE = 2.0;
export const FARM_HOURS = 2.0;

export const SECOND_ACTION: Record<string, string> = {
  Lending:
    'Borrow a small amount against the deposit to register as an active borrower',
  Dexs: 'Provide liquidity in the main pool to register as an active liquidity provider',
  Yield: 'Stake the deposit in the yield vault to register as an active staker',
  'Liquid Staking': 'Stake through the protocol to register as an active staker',
  Derivatives: 'Open a small hedged position to register as an active trader',
  RWA: 'Hold the tokenised position through one full accrual cycle',
  CDP: 'Mint a small amount of the stable asset against the deposit',
  Bridge: 'Bridge a small amount through the protocol to register as an active user',
};
export const DEFAULT_ACTION =
  'Complete a second qualifying on-chain interaction in the protocol';

export function primaryChain(p: Proto): string {
  return p.chains && p.chains.length > 0 ? p.chains[0] : 'Ethereum';
}

export function gasCost(p: Proto): number {
  return GAS[primaryChain(p)] ?? DEFAULT_GAS;
}

export function fmtGas(g: number): string {
  return g < 0.01 ? g.toFixed(5) : g.toFixed(2);
}

export function farmPlan(p: Proto): { steps: string[]; cost: number } {
  const g = gasCost(p);
  const cost = BRIDGE_FEE + 6 * g;
  const chain = primaryChain(p);
  const name = p.name;
  const second = SECOND_ACTION[p.category ?? ''] ?? DEFAULT_ACTION;
  const steps = [
    `Bridge funds to ${chain} for ${name} (bridge fee $${BRIDGE_FEE.toFixed(2)} plus gas $${fmtGas(g)}).`,
    `Swap a portion of the bridged funds into the asset ${name} accepts (gas $${fmtGas(g)}).`,
    `Deposit the swapped asset into ${name} as a supplier (gas $${fmtGas(g)}).`,
    `${second} (gas $${fmtGas(g)}).`,
    `Return once a week to repeat a small interaction so the position stays active (gas $${fmtGas(g)}).`,
    `Claim any rewards and withdraw the position when the token launches (gas $${fmtGas(g)}).`,
  ];
  return { steps, cost };
}

// ---------- board ----------

export interface BoardRow {
  slug: string;
  name: string;
  category: string | null;
  chain: string;
  tvl: number;
  growth: number;
  ageDays: number;
  implied: number;
  lo: number;
  hi: number;
  odds: number;
  cohortAge: number;
  cohortTvl: number;
  ev: number;
  flag: string | null;
  verdict: string;
  rank: number;
  rankLo: number;
  rankHi: number;
  dstar: number;
  mvc: number;
  perHour: number;
  cost: number;
  steps: string[];
  watchlist: boolean;
}

export function boardPart(
  ps: Proto[],
  fit: Proto[],
  odds: ReturnType<typeof oddsPart>,
  watchlist: string[],
  abl: ReturnType<typeof ablation>,
) {
  const wl = new Set(watchlist);
  const [b0, b1, b2] = abl.m1Beta;
  const conf = conformalPart(fit);
  const qcat = new Map(conf.perCat.map((c) => [c.cat, c.q80]));
  const qglob = conf.q80;
  const cohort = cohortTables(ps);
  const ageRate = (p: Proto) => {
    const a = ageDays(p);
    for (const b of cohort.age) {
      if (b.lo <= a && a < b.hi) return b.rate;
    }
    return 0;
  };
  const tvlRate = (p: Proto) => {
    for (const b of cohort.tvl) {
      if (b.lo <= p.tvl_usd && p.tvl_usd < b.hi) return b.rate;
    }
    return 0;
  };
  const pMap = new Map<string, number>();
  ps.forEach((p, i) => pMap.set(p.slug, odds.pFull[i]));
  const rows: BoardRow[] = [];
  for (const p of ps) {
    if (hasToken(p)) continue;
    const imp = Math.round(
      Math.exp(b0 + b1 * Math.log(p.tvl_usd) + b2 * growth(p)),
    );
    const q = qcat.get(p.category ?? '') ?? qglob;
    const lo = Math.round(imp / Math.exp(q));
    const hi = Math.round(imp * Math.exp(q));
    const o = pMap.get(p.slug) ?? 0;
    const ev = Math.round(o * imp);
    const reason = flagReason(p);
    const { steps, cost } = farmPlan(p);
    const rate = (AIRDROP_SHARE * imp) / p.tvl_usd;
    const dstar = rate > 0 ? cost / rate : Infinity;
    const mvc = Math.max(50, 10 * cost);
    const net500 = 500 * rate - cost;
    const perHour = net500 / FARM_HOURS;
    let verdict: string;
    if (reason !== null) verdict = 'FLAGGED';
    else if (dstar <= 500 && o >= 0.1) verdict = 'FARM';
    else if (dstar <= 5000 && o >= 0.05) verdict = 'WATCH';
    else verdict = 'THIN';
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chain: primaryChain(p),
      tvl: p.tvl_usd,
      growth: growth(p),
      ageDays: ageDays(p),
      implied: imp,
      lo,
      hi,
      odds: o,
      cohortAge: ageRate(p),
      cohortTvl: tvlRate(p),
      ev,
      flag: reason,
      verdict,
      rank: 0,
      rankLo: 0,
      rankHi: 0,
      dstar,
      mvc,
      perHour,
      cost,
      steps,
      watchlist: wl.has(p.slug),
    });
  }
  const cand = rows
    .filter((r) => r.flag === null)
    .sort((a, b) => b.implied - a.implied);
  const flag = rows
    .filter((r) => r.flag !== null)
    .sort((a, b) => b.implied - a.implied);
  const board = [...cand, ...flag];
  board.forEach((r, i) => (r.rank = i + 1));
  const rankRange = (sub: BoardRow[], r: BoardRow): [number, number] => {
    const up = 1 + sub.filter((s) => s.implied > r.hi).length;
    const dn = 1 + sub.filter((s) => s.implied > r.lo).length;
    return [up, dn];
  };
  for (const r of cand) {
    const [lo, hi] = rankRange(cand, r);
    r.rankLo = lo;
    r.rankHi = hi;
  }
  for (const r of flag) {
    const [lo, hi] = rankRange(flag, r);
    r.rankLo = lo;
    r.rankHi = hi;
  }
  const countVerdicts = (rs: BoardRow[]) => {
    const c: Record<string, number> = {};
    for (const r of rs) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    return c;
  };
  return {
    board,
    cand,
    flag,
    verdictsCand: countVerdicts(cand),
    verdictsFlag: countVerdicts(flag),
    qglob,
    qcat: Object.fromEntries(qcat),
    model: { b0, b1, b2 },
  };
}

// ---------- top-level ----------

export function analyze(snap: Snapshot) {
  const ps = snap.protocols;
  const traded = ps.filter(hasToken);
  const pre = ps.filter((p) => !hasToken(p));
  const fit = fitset(ps);
  const abl = ablation(fit);
  const odds = oddsPart(ps);
  const cohort = cohortTables(ps);
  const conf = conformalPart(fit);
  const extra = extraTests(fit);
  const board = boardPart(ps, fit, odds, snap.watchlist, abl);
  const aboveFloor = pre.filter((p) => p.tvl_usd >= FLOOR_USD).length;
  const wlInCand = board.cand.filter((r) => r.watchlist).length;
  return {
    meta: {
      asOf: snap.as_of,
      total: ps.length,
      traded: traded.length,
      preToken: pre.length,
      cand: board.cand.length,
      flagged: board.flag.length,
      watchlist: snap.watchlist.length,
      watchlistInCand: wlInCand,
      aboveFloor,
      nFit: fit.length,
    },
    fit: abl,
    odds,
    cohort,
    conformal: conf,
    extra,
    board: board.board,
    topCand: board.cand.slice(0, 5),
    topFlag: board.flag.slice(0, 5),
    verdictsCand: board.verdictsCand,
    verdictsFlag: board.verdictsFlag,
    model: board.model,
    qglob: board.qglob,
  };
}
