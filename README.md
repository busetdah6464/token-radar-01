# Launch Radar v4: filtered fit, clipped growth, CV-winning logistic odds, candidate-only board, conformal intervals, farm plans sized to minimum viable capital

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/busetdah6464/token-radar-01/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/busetdah6464/token-radar-01/reward.svg)](https://make.fun/c/token-radar-01)

A token launch radar for the make.fun `token-radar-01` bounty. It reads the sealed DefiLlama snapshot (758 protocols, 2026-11-14), fits a value model, scores every pre-token protocol, and writes a ranked board, a static dashboard, and a dossier.

## What changed in v4

v3 dropped the filtered fit set, dropped growth, ranked all 758 protocols on one global board, and lost the charts — and its dev score fell to 80.91% from v2's 87.20%. v4 restores what worked in v2, keeps what v3 fixed, and changes one thing:

1. **Fit set restored (v2).** The value model is fitted only on traded protocols with TVL ≥ $5M and market-cap/TVL in [0.01, 10] — 111 protocols. The 17 dropped are extreme outliers (bridges and staked products with tiny market caps against huge TVL, and the reverse). R² 0.447 vs 0.194 unfiltered.
2. **Growth added, clipped (new).** The model is log(mcap) = 4.3956 + 0.6721·log(TVL) + 0.0039·growth, where growth is change_7d in *per cent*, clipped to ±50% before fitting and predicting. The clip is load-bearing: one protocol reports +4,448% and without it would imply a $372 trillion market cap; clipped it implies $14.2M.
3. **Model chosen by rule, not by hand.** M0/M1/M2/M5 are tested four held-out ways (leave-one-out, 10-fold, walk-forward, older-to-newer) and the lowest sum of four median ratio errors wins. M1 wins with 11.87 (M0 12.98, M5 12.50, M2 13.06). Age and category terms are dropped — they lose, and the board says so.
4. **Token odds from the CV-winning logistic (v2, fixed).** Ridge-logistic on log TVL, log age, clipped growth and category dummies, chosen by 10-fold cross-validated Brier score (0.1345) over an age-only Weibull (0.1479) and category share (0.1440); base rate 0.1403. The growth feature now uses the clipped per-cent value — an earlier version clipped as if it were a fraction, which killed the feature for ~90% of protocols. Honest note: the logistic's age coefficient is positive (+0.65), so the odds rise with age in the cumulative sense; this board makes no falling-with-age claim.
5. **Board is candidate-only again (v2).** 202 pre-token protocols that are not exchanges, bridges, wrapped or staked products, versioned releases or bitcoin wrappers, ranked by implied value descending. Rank 1: Sentora Curator, $181,282,617. Traded protocols (416) anchor a separate section with observed market cap and mcap/TVL; excluded pre-token protocols (140) are listed separately with their reason. All 758 are accounted for.
6. **Charts restored (v2).** SVG scatter of log TVL vs log market cap with the fitted line, plus a bar chart of implied value by band.
7. **Conformal intervals kept (v3), recomputed on the filtered fit.** Global q80 1.89 log units; per category 0.81 (RWA) to 2.43 (Lending).
8. **Farm plans kept (v3): six concrete steps per candidate**, costed by chain gas (Ethereum $8, Arbitrum $0.30, Optimism $0.10, Base $0.05, Polygon $0.05, BSC $0.20, Avalanche $0.30, Solana $0.002, other $1; bridge $5 when multi-chain). Minimum viable capital = max($50, 10 × farm cost). Verdict: farm when expected value ≥ 3 × cost and odds ≥ 5%; watch when expected value ≥ cost; thin otherwise.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Writes `board.json` (202 candidate rows), `data.js` (the dashboard's data), `dashboard/` and `screenshots/` (copied), and `dossier.json` (via the kit's vendored `vendor/makefun-board.ts`). Deterministic: two runs write the same bytes. Then check with the kit CLI:

```sh
node <kit>/cli/makefun.mjs check --help
```

## Layout

- `main.ts` — entrypoint: reads the snapshot, builds the radar, writes the outputs.
- `lib/model.ts` — fit, validation, odds, conformal intervals, board, farm plans.
- `lib/mt19937.ts` — Mersenne Twister seeded exactly like CPython's `random.Random`, so the 10-fold shuffle (seed 20261114) matches the reference computation.
- `dashboard/` — `index.html` (method and validation tables, static), `app.css`, `app.js` (board, detail view, charts, traded and excluded sections). No network.
- `screenshots/` — three real screenshots of the dashboard (board, detail, filtered).
- `vendor/makefun-board.ts` — the kit's dossier library, byte for byte.

## Honesty notes

- The implied value is the model's claim for a token *if the protocol's record stayed as it is*. It is not a prediction of whether or when a token is issued.
- A protocol is called pre-token because its record shows no token — the record is not proof it has none.
- The 10-fold numbers depend on the shuffle seed; the seed is fixed at 20261114 and reported.
- The Weibull age-only fit (k 2.50, scale 5.0 years) does not support a falling launch hazard with age, so no such claim is made.
