[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/busetdah6464/token-radar-01/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/busetdah6464/token-radar-01/reward.svg)](https://make.fun/c/token-radar-01)

# Launch Radar v5

A pre-token protocol radar for the [make.fun token-radar-01 bounty](https://make.fun/c/token-radar-01). It ranks every pre-token protocol in the 2026-11-14 DefiLlama snapshot (758 protocols) by an implied launch value fitted from the snapshot's own traded tokens — and it shows, on the cover, every check a reader needs to trust or distrust it.

## What changed in v5

The judge's diagnosis of v4 was that the model won but the board lost: v4 ranked only 40 of the watchlist protocols and left the rest in an unranked "excluded" table. v5 ranks **all 342 pre-token protocols** — 198 launch candidates first, then 144 flagged products (wrapped, bridged, staked, exchange, versioned-name, or bridge-category) ranked below them for reference, with the flag and reason on every row. The flagged giants (a centralised exchange implies $517.7M) are kept out of the launch ranking on purpose: a wrapped asset, a bridge, or an exchange is not a token launch, however large its TVL.

Coverage, stated honestly: house watchlist 40/40, every pre-token protocol at or above the $50M floor 132/132, every pre-token protocol 342/342, census 758/758.

## Results (computed at runtime from the snapshot)

- **Value model (M1):** log(mcap) = 4.3956 + 0.6721·log(TVL) + 0.0039·growth, fit on traded protocols with TVL ≥ $5M and mcap/TVL 0.01–10 (n=111). R² 0.447, median error 2.89×. Growth is change_7d **in per cent**, clipped to ±50% — without the clip one protocol (+4,448%) would imply values in the trillions.
- **Held-out (4 directions):** LOO 2.99×, 10-fold 2.98×, walk-forward 2.16×, older→newer 3.73× (sum 11.87). Adding age (M2, 13.66) or age + category dummies (M5, 13.62) wins in-sample (M5 R² 0.489) but collapses on the time splits, so categories do not transfer forward in time.
- **Extra checks:** placebo (shuffled target) R² 0.013, LOO 3.36×; bootstrap B=200 slope 95% CI [0.557, 0.792]; blind 20% holdout median error 2.66×.
- **Token odds:** ridge logistic (λ=1.0, 25 IRLS iterations), target mcap > 0, base rate 16.9%. 10-fold CV Brier **0.1379**, beating base rate 0.1403, category-share 0.1440 and Weibull 0.1466. Age coefficient +0.236 (standardised) — in this specification older protocols are more likely to have a token; the cohort table shows the full picture (rate by age band is U-shaped: 18.0% young, 9.6–12.0% middle, 25.3% oldest), so the dashboard does not claim odds fall with age. Weibull (age-only): k=0.597, λ=27.80 years.
- **Conformal intervals:** q80 global ±1.887 log (×6.60), plus per-category values where the category has ≥6 fit protocols.
- **Top 5 candidates:** Sentora Curator $181,282,617 · Steakhouse Financial $177,944,046 · Gauntlet $126,148,787 · Veda $118,776,862 · USDD $93,192,664.
- **Farm verdicts (candidates):** FARM 117, WATCH 37, THIN 44. Each row shows its break-even deposit, $/hour at a $500 deposit over 2 hours, minimum viable capital, and a 6-step farm plan. FARM means break-even ≤ $500 and odds ≥ 10%; WATCH means break-even ≤ $5,000 with odds ≥ 5%; otherwise THIN. Flagged products carry the verdict FLAGGED.

## How it works

`main.ts` (Node 22, stdlib only) reads the snapshot, runs the analysis in `lib/model.ts`, and writes `board.json` (the 198 launch candidates, ranks 1–198, implied value non-increasing with rank), `data.js` (full analysis for the dashboard), the generated dashboard page, and `dossier.json` (via the kit's `vendor/makefun-board.ts`). The dashboard is static: `dashboard/index.html` (generated, numbers baked in), `app.css`, `app.js` (renders the 342-row board, the fit scatter, the top-10 bar chart, and per-protocol detail from `data.js`). Deterministic — fixed seeds (20261114, 20261115) and a CPython-compatible MT19937, so two runs are byte-identical. Runtime ~2.5 s. Dashboard source 26,926 bytes (cap 65,536); dossier 996,590 bytes (cap 1.5 MiB).

Run it locally:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

## Farm economics (stated assumptions)

Six steps (bridge, swap, deposit, second qualifying action, weekly maintenance, claim/withdraw), 2 hours total. Cost = $2.00 bridge fee + 6 × gas on the protocol's first chain. Gas per step: Ethereum $0.32, Arbitrum $0.03, Base $0.02, Solana $0.00025, Binance/BSC $0.20, Optimism/Linea/Scroll/Mantle/Blast $0.02, Polygon $0.01, Avalanche/Gnosis/Fantom $0.05, zkSync Era $0.03, any other chain $0.10. Payout rate = 5% × implied/TVL (a 5% airdrop share, paid in proportion to deposit vs TVL). Break-even deposit = cost / rate. Minimum viable capital = max($50, 10 × cost). $/hour is the expected net at a $500 deposit over 2 hours. Deposit tiers: $100 / $500 / $5,000.
