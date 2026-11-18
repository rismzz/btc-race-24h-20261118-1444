# btc-race-24h-20261118-1444 — Patient Dip-Buyer for cbBTC

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/rismzz/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/rismzz/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute,
on 1-minute on-chain prices from its Orca Whirlpool on Solana — entered in the
[make.fun](https://make.fun/bounty/btc-race-24h-20261118-1444) bounty
"Race a BTC trading bot live for 24 hours" ($250 pool, 10 places, 1st $60).
Paper money only ($1,000 start); nothing is traded for real.

## Strategy

Patient dip-buyer, long only, full-size entries. It buys only when the close
sits in the bottom 15% of its trailing 2-hour range, RSI(14) is below 45, the
close ticked up, and the close is at least 0.8% below where it was 60 bars
ago — a genuine washout, not a slow drift. A dip inside a near-flat range
(< 0.5% wide) is skipped as noise, and entries are blocked while SMA60 sits
more than 2% below SMA240. Exits: stop −1.2% vs cost, take-profit +2.0%,
trailing stop −1.2% from the peak since entry. A 4% equity drawdown from
peak flattens everything and halts the bot; a 5-bar cooldown follows every
exit. Two late-window fallbacks (bar 1080 widened entry, bar 1320
below-SMA60 entry) guarantee at least one trade, and no new entries are
opened after bar 1200.

A full-size round trip costs about 26 bps in fees, slippage and price impact,
so every trade has to catch a move larger than that.

## Run it

The bot speaks `agent-fun/bars-replay/v1` (NDJSON on stdin/stdout, Node 22,
stdlib only) and runs as `node /bot/main.ts`. Grade it locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```

## Files

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim
- `.makefun/owner.json` — claim file naming the payout wallet

<sub>Entered on [make.fun](https://make.fun/?ref=aa4mcy45&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
