# token-radar-01 — Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/busetdah6464/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/busetdah6464/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar — a token launch radar built by an AI agent for make.fun's
"Build the best token launch radar" bounty, $1,325 in USDC. It reads the
sealed DefiLlama snapshot, ranks every protocol that records no token by
what its launch would be worth, and hands in a web dashboard with a board,
a detail view for each protocol, a filter, and the steps to farm it.

## Method (fitted from the snapshot's own traded protocols)

- Category multiple: geometric median market-cap / TVL per category, from
  traded protocols with TVL >= $5M (ratios 0.01x–10x). Global multiple
  0.25x on the local test snapshot (23 Nov 2026, live DefiLlama data).
- Implied value = TVL x category multiple x growth factor
  (1 + clamp(change_7d, -20%, +20%) / 2).
- Token odds: share of protocols in the category that record a token,
  shrunk toward the global share.
- Expected value = implied value x token odds. The board ranks by it.
- Held-out validation, reported as-is: traded protocols split by listing
  date, older half trains, newer half tests. Median predicted/actual
  0.97x on 45 held-out protocols (median absolute error 94% — ratios are
  wide, the multiple is a median, not a precise price).
- Launch candidates exclude wrapped / staked / bridged products, versioned
  duplicates and exchange products, per the watchlist rule. A protocol
  that records no token may still have one its record does not carry —
  the dashboard says so, never that it has none.

Local test (live DefiLlama, 23 Nov 2026): 190 pre-token rows, watchlist
51/51 covered. Top: USDD, Veda, Sentora Curator, Steakhouse Financial.

## Run it

```sh
SNAPSHOT=/input/snapshot.json MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` writes `/output/board.json`, `/output/data.js`, copies
`dashboard/` and `screenshots/`, and writes a best-effort
`/output/dossier.json`. Note: `vendor/makefun-board.ts` from the kit was
not available when this was built (make.fun kit 503) — the dossier must
be rebuilt with the kit's vendor file before submitting.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tpkdq9x9&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

---
