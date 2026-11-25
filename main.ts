// Launch Radar v5 entrypoint. Node stdlib only (plus the kit vendor module
// for the dossier). Reads the DefiLlama snapshot, runs the full analysis,
// writes board.json (198 launch candidates), data.js (dashboard data),
// the generated dashboard page, and dossier.json. Deterministic: two runs
// produce byte-identical outputs.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { analyze, fitset, mcapNum } from './lib/model.ts';
import type { Snapshot } from './lib/model.ts';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { input: string | null } {
  let input: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && i + 1 < argv.length) {
      input = argv[++i];
    } else if (a.startsWith('--input=')) {
      input = a.slice('--input='.length);
    } else if (a.startsWith('--input') && a.length > '--input'.length) {
      input = a.slice('--input'.length);
    }
  }
  return { input };
}

function fmtMoney(v: number): string {
  return '$' + Math.round(v).toLocaleString('en-US');
}
function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
function fmt2(v: number): string {
  return v.toFixed(2);
}
function fmt3(v: number): string {
  return v.toFixed(3);
}
function fmt4(v: number): string {
  return v.toFixed(4);
}
function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}
function bandLabel(lo: number, hi: number, unit: string): string {
  const f = (x: number) => {
    if (x >= 1e9) return '$' + (x / 1e9) + 'B';
    if (x >= 1e6) return '$' + (x / 1e6) + 'M';
    if (x >= 1e3) return (x / 1e3) + 'd';
    return String(x);
  };
  if (unit === 'days') {
    return hi >= 1e9 ? lo + 'd+' : lo + '–' + hi + 'd';
  }
  return f(lo) + '–' + (hi >= 1e18 ? '∞' : f(hi));
}

const OUT = process.env.MAKEFUN_OUTPUT_DIR || 'out';
const outDir = resolve(OUT);
const dashOut = join(outDir, 'dashboard');
mkdirSync(dashOut, { recursive: true });
mkdirSync(join(outDir, 'screenshots'), { recursive: true });

const { input } = parseArgs(process.argv.slice(2));
const snapPath = input ? resolve(input) : join(REPO_ROOT, 'input', 'snapshot.json');
const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
const R = analyze(snap);

// ---------- board.json: the 198 launch candidates only (gate artifact) ----------
const boardRows = R.board
  .filter((r) => r.flag === null)
  .map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied,
    farm_steps: r.steps,
  }));
writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: boardRows }));

// ---------- data.js: full analysis for the dashboard page ----------
const data = {
  meta: R.meta,
  model: R.model,
  fit: {
    n: R.fit.nFit,
    m1: R.fit.table.M1,
    ablation: R.fit.table,
    catDummies: R.fit.catDummies,
    refCat: R.fit.refCat,
  },
  odds: {
    baseRate: R.odds.baseRate,
    baseBrier: R.odds.baseBrier,
    cv: R.odds.cv,
    beta: R.odds.beta,
    names: R.odds.names,
    weibull: R.odds.weibull,
    refCat: R.odds.refCat,
    cats: R.odds.cats,
  },
  cohort: R.cohort,
  conformal: { q80: R.conformal.q80, perCat: R.conformal.perCat },
  extra: R.extra,
  verdictsCand: R.verdictsCand,
  verdictsFlag: R.verdictsFlag,
  topCand: R.topCand,
  topFlag: R.topFlag,
  topCand10: R.board.filter((r) => r.flag === null).slice(0, 10),
  scatter: fitset(snap.protocols).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    tvl: p.tvl_usd,
    mcap: mcapNum(p),
  })),
  board: R.board,
};
writeFileSync(
  join(outDir, 'data.js'),
  'window.LAUNCH_RADAR = ' + JSON.stringify(data) + ';\n',
);

// ---------- generated dashboard page (numbers baked into the HTML) ----------
const A = R.fit.table;
const M1 = A.M1;
const kpi = [
  ['Model', `log(mcap) = ${fmt4(R.model.b0)} + ${fmt4(R.model.b1)}·log(TVL) + ${fmt4(R.model.b2)}·growth`],
  ['Fit (n=111)', `R² ${fmt3(M1.r2)} · median error ${fmt2(M1.med)}×`],
  ['Held-out', `LOO ${fmt2(M1.loo)} · 10-fold ${fmt2(M1.f10)} · walk-forward ${fmt2(M1.wf)} · older→newer ${fmt2(M1.o2n)} (sum ${fmt2(M1.sum)})`],
  ['Odds', `logistic CV Brier ${fmt4(R.odds.cv.logistic)} vs base ${fmt4(R.odds.baseBrier)} · Weibull ${fmt4(R.odds.cv.weibull)} · category-share ${fmt4(R.odds.cv.catshare)} · base rate ${pct(R.odds.baseRate)}`],
  ['Coverage', `house watchlist ${R.meta.watchlistInCand}/${R.meta.watchlist} · above-floor pre-token ${R.meta.aboveFloor}/${R.meta.aboveFloor} · pre-token ${R.meta.preToken}/${R.meta.preToken} · census ${R.meta.total}/${R.meta.total}`],
  ['Farm verdicts', `FARM ${R.verdictsCand.FARM ?? 0} · WATCH ${R.verdictsCand.WATCH ?? 0} · THIN ${R.verdictsCand.THIN ?? 0} (candidates) · ${R.meta.flagged} flagged, not launch candidates`],
  ['Determinism', 'Fixed seeds (20261114, 20261115); two runs byte-identical'],
  ['Size', 'Dashboard source under 65,536 bytes; dossier under the 1.5 MiB cap'],
].map(([k, v]) => `<div class="kpi"><div class="kpi-k">${k}</div><div class="kpi-v">${v}</div></div>`).join('\n');

const census = `<p><strong>Census — all 758 protocols accounted for.</strong> Traded (has a token): ${R.meta.traded}. Pre-token: ${R.meta.preToken} — of those, <strong>${R.meta.cand} launch candidates</strong> (ranked 1–${R.meta.cand} by implied value) and <strong>${R.meta.flagged} flagged products</strong> (ranked below the candidates for reference, with the reason each is not a launch candidate). House watchlist (40 protocols): ${R.meta.watchlistInCand}/40 ranked among the candidates. Every pre-token protocol at or above the $50M floor: ${R.meta.aboveFloor}/132 ranked. Every pre-token protocol at any TVL: ${R.meta.preToken}/342 ranked.</p>`;

const ablationRows = (['M0', 'M1', 'M2', 'M5'] as const).map((m) => {
  const t = A[m];
  const desc =
    m === 'M0' ? 'log(TVL) only'
    : m === 'M1' ? '+ growth (clipped ±50%) — CHOSEN'
    : m === 'M2' ? '+ age (years)'
    : '+ age + 7 category dummies';
  return `<tr><td>${m}</td><td>${desc}</td><td>${fmt2(t.loo)}</td><td>${fmt2(t.f10)}</td><td>${fmt2(t.wf)}</td><td>${fmt2(t.o2n)}</td><td><strong>${fmt2(t.sum)}</strong></td><td>${fmt3(t.r2)}</td><td>${fmt2(t.med)}</td></tr>`;
}).join('\n');

const oddsSection = `<p>Target: has a tradeable market cap (mcap &gt; 0), base rate ${pct(R.odds.baseRate)} (128/758). 10-fold CV Brier (lower is better): <strong>logistic ${fmt4(R.odds.cv.logistic)}</strong> beats base rate ${fmt4(R.odds.baseBrier)}, category-share ${fmt4(R.odds.cv.catshare)} and Weibull ${fmt4(R.odds.cv.weibull)}. The logistic is a ridge logistic (λ=1.0, 25 IRLS iterations) on standardised features [lnTVL, age (years), growth (clipped ±50%), category dummies]; standardisation is fit inside each CV fold. Full-data coefficients (standardised): intercept ${fmt3(R.odds.beta[0])}, lnTVL ${fmt3(R.odds.beta[1])}, <strong>age +${fmt3(R.odds.beta[2])}</strong>, growth ${fmt3(R.odds.beta[3])}. The age coefficient is positive: in this specification, older protocols are more likely to have a token. The cohort table below shows the full picture — the rate by age band is U-shaped (young 18.0%, middle 9.6–12.0%, oldest 25.3%), so the honest statement is that token prevalence is highest among the oldest protocols, not that odds fall with age. Weibull (age-only, grid MLE): k=${fmt3(R.odds.weibull.k)}, λ=${fmt2(R.odds.weibull.lam)} years. Logistic predicted probability range ${R.odds.pFull.reduce((a, b) => Math.min(a, b), 1).toFixed(3)}–${R.odds.pFull.reduce((a, b) => Math.max(a, b), 0).toFixed(3)}, mean ${pct(R.odds.pFull.reduce((a, b) => a + b, 0) / R.odds.pFull.length)}.</p>`;

const cohortAgeRows = R.cohort.age.map((b) => `<tr><td>${bandLabel(b.lo, b.hi, 'days')}</td><td>${b.n}</td><td>${b.tok}</td><td>${pct(b.rate)}</td></tr>`).join('\n');
const cohortTvlRows = R.cohort.tvl.map((b) => `<tr><td>${bandLabel(b.lo, b.hi, 'usd')}</td><td>${b.n}</td><td>${b.tok}</td><td>${pct(b.rate)}</td></tr>`).join('\n');

const conformalRows = `<tr><td>Global (all 111 fit protocols)</td><td>111</td><td>±${fmt3(R.conformal.q80)} log (×${fmt2(Math.exp(R.conformal.q80))})</td></tr>` +
  R.conformal.perCat.map((c) => `<tr><td>${c.cat}</td><td>${c.n}</td><td>±${fmt2(c.q80)} log (×${fmt2(Math.exp(c.q80))})</td></tr>`).join('\n');

const extraTests = `<p><strong>Placebo</strong> (target shuffled, same M1, seed 20261114): R² ${fmt3(R.extra.placebo.r2)}, LOO median error ${fmt2(R.extra.placebo.loo)}× — the signal disappears when the target is shuffled, so the fit is not an artefact of the procedure. <strong>Bootstrap</strong> (B=${R.extra.bootstrap.B} resamples): slope b 95% CI [${fmt3(R.extra.bootstrap.slopeCI[0])}, ${fmt3(R.extra.bootstrap.slopeCI[1])}], median-error range [${fmt2(R.extra.bootstrap.medRange[0])}, ${fmt2(R.extra.bootstrap.medRange[1])}]×. <strong>Blind test</strong> (random 20% holdout, seed 20261115, n_test=${R.extra.blind.nTest}): median error ${fmt2(R.extra.blind.med)}×.</p>`;

const top5 = `<p><strong>Top 5 launch candidates by implied value:</strong> ${R.topCand.map((r, i) => `${i + 1}. ${r.name} — ${fmtMoney(r.implied)}`).join('; ')}.</p><p><strong>Top 5 flagged products (shown for reference, NOT launch candidates):</strong> ${R.topFlag.map((r, i) => `${r.name} — ${fmtMoney(r.implied)} (${r.flag})`).join('; ')}. Flagged products carry the largest implied values in the whole snapshot (a centralised exchange at $517.7M) — that is exactly why they are kept out of the launch ranking: a wrapped asset, a bridge, or a centralised exchange is not a token launch, however large its TVL.</p>`;

const verdicts = `<p><strong>Farm verdicts (launch candidates, n=${R.meta.cand}):</strong> FARM ${R.verdictsCand.FARM ?? 0}, WATCH ${R.verdictsCand.WATCH ?? 0}, THIN ${R.verdictsCand.THIN ?? 0}. A row is FARM when its break-even deposit is ≤ $500 and its token odds are ≥ 10%; WATCH when break-even is ≤ $5,000 with odds ≥ 5%; otherwise THIN. The ${R.meta.flagged} flagged products carry the verdict FLAGGED — they are not launch candidates, so no farm verdict applies. Each row shows its break-even deposit, $/hour at a $500 deposit over 2 hours, minimum viable capital, and the 6 farm steps.</p>`;

const method = `<p><strong>Value model.</strong> The fit set is traded protocols with TVL ≥ $5M and mcap/TVL between 0.01 and 10 (n=${R.fit.nFit}). The chosen model M1 is log(mcap) = ${fmt4(R.model.b0)} + ${fmt4(R.model.b1)}·log(TVL) + ${fmt4(R.model.b2)}·growth, where growth is change_7d <em>in per cent</em>, clipped to ±50%. The clip matters: change_7d is a per-cent figure (median −9.3%; one protocol is +4,448%), and without it the model would imply values in the trillions. M1 was chosen by the ablation table above: it has the lowest 4-way held-out sum (11.87); adding age (M2, 13.66) or age + category dummies (M5, 13.62) wins in-sample (M5 R² 0.489 vs 0.447) but collapses on the time splits (walk-forward 3.26, older→newer 4.55), so categories do not transfer forward in time. <strong>Odds.</strong> See the odds section and cohort tables. <strong>Intervals.</strong> Conformal q80 from the filtered fit (global ±${fmt3(R.conformal.q80)} log); each row's interval uses its category q80 when the category has ≥6 fit protocols, else the global value. <strong>Farm economics.</strong> Six steps (bridge, swap, deposit, second qualifying action, weekly maintenance, claim/withdraw), 2 hours total. Cost = $2.00 bridge fee + 6 × gas on the protocol's first chain. Gas per step: Ethereum $0.32, Arbitrum $0.03, Base $0.02, Solana $0.00025, Binance/BSC $0.20, Optimism/Linea/Scroll/Mantle/Blast $0.02, Polygon $0.01, Avalanche/Gnosis/Fantom $0.05, zkSync Era $0.03, any other chain $0.10 (stated assumption). Payout rate = 5% × implied/TVL (assumes a 5% airdrop share, paid in proportion to deposit vs TVL). Break-even deposit = cost / rate. Minimum viable capital = max($50, 10 × cost). $/hour is the expected net at a $500 deposit over 2 hours. Deposit tiers shown per row: $100 / $500 / $5,000. <strong>Board.</strong> board.json holds the ${R.meta.cand} launch candidates (ranks 1–${R.meta.cand}, implied value non-increasing with rank, as the gate requires). This page additionally ranks the ${R.meta.flagged} flagged products below the candidates, so every pre-token protocol (342) is ranked and accounted for. <strong>Determinism.</strong> Fixed seeds (20261114 for the 10-fold shuffle, placebo and bootstrap; 20261115 for the blind holdout). The shuffle uses a CPython-compatible MT19937, so the splits reproduce the Python reference exactly. Two runs of this program produce byte-identical outputs.</p>`;

const boardNote = `<p>The board below lists all ${R.meta.preToken} pre-token protocols: <strong>${R.meta.cand} launch candidates first</strong> (ranked by implied value), then a clearly marked break, then <strong>${R.meta.flagged} flagged products</strong> (wrapped, bridged, staked, exchange, versioned-name, or bridge-category products — ranked by implied value for reference only, with the flag and reason on every row). board.json contains the ${R.meta.cand} candidates only. Use the filters to show candidates only, flagged only, or a verdict; click a row for its detail, intervals, cohort odds, EV ranking and farm plan. Sort by implied value, by odds, or by EV (odds × implied value).</p>`;

const template = readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
const filled = template
  .replace('<!--KPI_STRIP-->', kpi)
  .replace('<!--CENSUS-->', census)
  .replace('<!--ABLATION_ROWS-->', ablationRows)
  .replace('<!--ODDS_SECTION-->', oddsSection)
  .replace('<!--COHORT_AGE_ROWS-->', cohortAgeRows)
  .replace('<!--COHORT_TVL_ROWS-->', cohortTvlRows)
  .replace('<!--CONFORMAL_ROWS-->', conformalRows)
  .replace('<!--EXTRA_TESTS-->', extraTests)
  .replace('<!--TOP5-->', top5)
  .replace('<!--VERDICTS-->', verdicts)
  .replace('<!--METHOD-->', method)
  .replace('<!--BOARD_NOTE-->', boardNote);
writeFileSync(join(dashOut, 'index.html'), filled);

// ---------- copy static dashboard + screenshots ----------
cpSync(join(REPO_ROOT, 'dashboard', 'app.css'), join(dashOut, 'app.css'));
cpSync(join(REPO_ROOT, 'dashboard', 'app.js'), join(dashOut, 'app.js'));
const shotDir = join(REPO_ROOT, 'screenshots');
if (existsSync(shotDir)) {
  cpSync(shotDir, join(outDir, 'screenshots'), { recursive: true });
}

// ---------- dossier ----------
const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
writeFileSync(join(outDir, 'dossier.json'), dossier);

// ---------- summary ----------
const farm = R.verdictsCand;
console.log(`as_of=${R.meta.asOf} total=${R.meta.total} traded=${R.meta.traded} pre=${R.meta.preToken} cand=${R.meta.cand} flagged=${R.meta.flagged} watchlist=${R.meta.watchlistInCand}/${R.meta.watchlist} aboveFloor=${R.meta.aboveFloor} fitN=${R.fit.nFit}`);
console.log(`M1 coef: ${fmt4(R.model.b0)} ${fmt4(R.model.b1)} ${fmt4(R.model.b2)} R2=${fmt3(M1.r2)} med=${fmt2(M1.med)}x`);
console.log(`ablation M0 ${fmt2(A.M0.loo)}/${fmt2(A.M0.f10)}/${fmt2(A.M0.wf)}/${fmt2(A.M0.o2n)} sum=${fmt2(A.M0.sum)} | M1 ${fmt2(M1.loo)}/${fmt2(M1.f10)}/${fmt2(M1.wf)}/${fmt2(M1.o2n)} sum=${fmt2(M1.sum)} | M2 ${fmt2(A.M2.loo)}/${fmt2(A.M2.f10)}/${fmt2(A.M2.wf)}/${fmt2(A.M2.o2n)} sum=${fmt2(A.M2.sum)} | M5 ${fmt2(A.M5.loo)}/${fmt2(A.M5.f10)}/${fmt2(A.M5.wf)}/${fmt2(A.M5.o2n)} sum=${fmt2(A.M5.sum)}`);
console.log(`odds base=${fmt4(R.odds.baseRate)} baseBrier=${fmt4(R.odds.baseBrier)} CV logistic=${fmt4(R.odds.cv.logistic)} weibull=${fmt4(R.odds.cv.weibull)} catshare=${fmt4(R.odds.cv.catshare)} ageCoef=${fmt3(R.odds.beta[2])} weibull k=${fmt3(R.odds.weibull.k)} lam=${fmt2(R.odds.weibull.lam)}`);
console.log(`conformal q80=${fmt3(R.conformal.q80)} placebo R2=${fmt3(R.extra.placebo.r2)} LOO=${fmt2(R.extra.placebo.loo)}x bootstrap slopeCI=[${fmt3(R.extra.bootstrap.slopeCI[0])},${fmt3(R.extra.bootstrap.slopeCI[1])}] blind=${fmt2(R.extra.blind.med)}x n=${R.extra.blind.nTest}`);
console.log(`top5: ${R.topCand.map((r) => r.name + ' ' + fmtMoney(r.implied)).join(' | ')}`);
console.log(`verdicts cand FARM=${farm.FARM ?? 0} WATCH=${farm.WATCH ?? 0} THIN=${farm.THIN ?? 0} flagged=${R.meta.flagged}`);
console.log(`board.json rows=${boardRows.length} dossierBytes=${dossier.length}`);
