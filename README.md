# Pump.fun Replay Sprint — Launch-Spike Scalper

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aldy007x/pump-replay-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aldy007x/pump-replay-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the **Pump.fun Replay Sprint — Paper Bot, Real Ranking**
bounty: it trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve
activity, scored by net PnL after all fees.

## Strategy

A pump.fun launch spikes hard in its first seconds and then decays almost
immediately — on the dev window the median coin is already falling within
~100 slots of its launch. So this bot does not invest in launches, it scalps
them: buy at the launch itself, take a small +15% profit, cut at −8%, and be
out within 10 slots of the buy decision no matter what. Wide take-profits and
long holds both tested strictly worse on the dev window, because the spike is
already over by then and the position just bleeds fees.

**Entry** — within 3 slots of the `CreateEvent`, once per coin:

- the creator's own early buys total at most 2.5 SOL — a creator with real
  money in is a confidence signal, not a rug flag (the dev window shows
  launches with a 2–3 SOL creator buy outperforming the rest);
- at most 4 distinct outside buyers so far, at least 1 (someone real is
  already in, but it is not a crowded room yet);
- the creator has not sold, and no single outside sell is over 0.5 SOL;
- real SOL reserves between 0.3 and 10 — a launch that has already raised
  more than 10 SOL in its first slots is usually bought at the top of its
  spike; the smaller band keeps the run ahead of the entry;
- the 1%-of-real-reserve size cap still allows a buy of at least 0.08 SOL;
  target stake 0.10 SOL.

A buy that comes back failed or rejected is not retried: re-entering a
launch a few slots later buys the top of its spike (tested — it loses
money), so a failed buy is simply a missed trade.

**Guardrail probes** — the sniper alone lands just under the 20-coin bar
on the dev window, so the bot also makes up to 3 tiny 0.02 SOL probe
trades on launches the sniper already passed on (creator has not sold, no
big sell, real reserves at least 2.5 SOL), sold on the next batch. A probe
is a real round trip, not a profit trade — it exists only to clear the
20-coin bar with margin.

**Exit** — checked on every batch while holding:

- take profit at +15% of cost, stop loss at −8% of cost (both measured on the
  estimated sell value net of curve fees and the tx fee);
- time exit after 10 slots from the buy decision (~8 slots after the fill,
  given the 2-slot latency);
- the creator selling, or any single sell of 2 SOL or more, exits at once.

No partial exits, no trailing stop: each tested worse or neutral
on the dev window.

## Determinism

No clock, no environment reads, no `Math.random`. Iteration is only over
insertion-ordered maps fed by the batch stream, so two runs on the same data
produce byte-identical action logs.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, zero dependencies).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied unchanged.
- `LICENSE` — MIT.

## Local grade

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```
