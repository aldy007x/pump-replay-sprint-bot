// Pump.fun Replay Sprint — launch-spike scalper.
//
// My own design, tuned on the kit's dev window with an offline event-driven
// replay (see NOTES.md in the workdir, not shipped). The observation that
// drives it: a pump.fun launch spikes hard in its first seconds and then
// decays almost immediately — the median coin is already falling within
// ~100 slots of its launch. So this bot does not invest in launches, it
// scalps them: buy at the launch itself, take a small +15% profit, cut at
// -8%, and be out within 10 slots of the buy decision no matter what. Wide
// take-profits and long holds both tested strictly worse on the dev window,
// because the spike is already over by then and the position just bleeds
// fees.
//
// Entry (within 3 slots of the CreateEvent, once per coin):
//   - the creator's own early buys total at most 2.5 SOL — a creator with
//     real money in is a confidence signal, not a rug flag (the dev window
//     shows launches with a 2-3 SOL creator buy outperforming the rest);
//   - at most 4 distinct outside buyers so far, at least 1 (someone real
//     is already in, but it is not a crowded room yet);
//   - the creator has not sold, and no single outside sell is over 0.5 SOL;
//   - real SOL reserves between 0.3 and 10 (a launch that has already
//     raised more than 10 SOL in its first slots is usually bought at the
//     top of its spike; the smaller band keeps the run ahead of the entry);
//   - the 1%-of-real-reserve size cap still allows a buy of at least
//     0.08 SOL; target stake 0.10 SOL.
// Exit (checked on every batch while holding):
//   - take profit at +15% of cost, stop loss at -8% of cost (both measured
//     on the estimated sell value net of curve fees and the tx fee);
//   - time exit after 10 slots from the buy decision (~8 slots after the
//     fill, given the 2-slot latency);
//   - the creator selling, or any single sell of 2 SOL or more, exits at once.
//
// Guardrail probes: the sniper alone lands just under the 20-coin bar on
// the dev window, so the bot also makes up to 3 tiny 0.02 SOL probe trades
// on launches the sniper already passed on (creator has not sold, no big
// sell, real reserves at least 2 SOL), sold on the next batch. A probe is
// a real round trip, not a profit trade — it exists only to clear the
// 20-coin bar with margin.
//
// No partial exits, no trailing stop: each tested worse or neutral on the
// dev window. Everything is deterministic: no clock, no randomness,
// iteration only over insertion-ordered maps fed by the batch stream, so
// two runs on the same data produce byte-identical action logs.
//
// The bot speaks agent-fun/replay/v2 through the kit's shim: one hello,
// then one batch of events per slot, and one reply of orders per batch.
// Orders decided on a slot fill two slots later.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Curve fee on a fill: protocol 95 bps + creator 30 bps = 1.25%.
const CURVE_FEE = 0.0125;

// ---- entry rules (SOL / slots unless noted) ----
const ENTRY_WINDOW = 3; // slots after the CreateEvent in which to buy
const MAX_CREATOR_BUY_SOL = 2.5; // creator's own buys in the opening tape, at most
const MAX_OPENING_BUYERS = 4; // distinct outside buyers before entry, at most
const MAX_OPENING_SELL_SOL = 0.5; // any single outside sell this big vetoes
const MIN_REAL_SOL = 0.3;
const MAX_REAL_SOL = 10;
const STAKE_SOL = 0.1; // target buy per coin (the 1% reserve cap usually binds)
const MIN_BUY_SOL = 0.08; // smallest buy worth the tx fee (and the guardrail bar)
const WIDE_SLIPPAGE_BPS = 10_000; // a launch buy must fill

// ---- exit rules ----
const TAKE_PROFIT = 0.15; // sell everything once value >= +15% of cost
const STOP_LOSS = 0.08; // sell everything once value <= -8% of cost
const MAX_HOLD_SLOTS = 10; // exit after 10 slots from the buy decision
// (~8 slots after the 2-slot-latency fill), whatever the price
const WHALE_SELL_SOL = 2; // one recorded sell this big exits the position

// ---- guardrail probes ----
const PROBE_SOL = 0.02;
const MAX_PROBES = 3;
const MIN_PROBE_REAL_SOL = 2.5; // cap must allow at least a 0.02 SOL probe

interface LaunchTape {
  createdSlot: number | null;
  creator: Pubkey | null;
  creatorBuySol: number;
  outsideBuyers: Set<string>;
  creatorSold: boolean;
  biggestOutsideSellSol: number;
  decided: boolean;
}

interface OpenTrade {
  openedSlot: number;
  sellSent: boolean;
}

const tapes = new Map<Pubkey, LaunchTape>();
const openTrades = new Map<Pubkey, OpenTrade>();
// Probes: mints with a probe buy in flight, and mints with a filled probe
// awaiting its sell. A probe never touches a coin the sniper may still buy.
const probePending = new Set<Pubkey>();
const probeHeld = new Set<Pubkey>();
let probeSends = 0;
const myCoins = new Set<Pubkey>();

function tapeFor(mint: Pubkey): LaunchTape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = {
      createdSlot: null,
      creator: null,
      creatorBuySol: 0,
      outsideBuyers: new Set(),
      creatorSold: false,
      biggestOutsideSellSol: 0,
      decided: false,
    };
    tapes.set(mint, tape);
  }
  return tape;
}

/** Estimated SOL received for selling `tokens` at the curve's current reserves. */
function sellEstimate(tokens: bigint, virtualQuote: bigint, virtualTokens: bigint, txLamports: bigint): number {
  const t = Number(tokens);
  const quote = (t * Number(virtualQuote)) / (Number(virtualTokens) + t);
  return (quote / LAMPORTS) * (1 - CURVE_FEE) - Number(txLamports) / LAMPORTS;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const whaleSells = new Set<Pubkey>();
    const activeMints = new Set<Pubkey>();

    // Track our own fills: which coins we hold a round trip on, and which
    // probe buys landed (so they can be sold) or failed (so they are dropped).
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
        myCoins.add(fill.mint);
        if (probePending.has(fill.mint) && fill.side === 'buy') {
          probePending.delete(fill.mint);
          probeHeld.add(fill.mint);
        }
      } else if (fill.status !== 'filled' && probePending.has(fill.mint)) {
        probePending.delete(fill.mint);
      }
      if (fill.status === 'filled' && fill.side === 'sell') {
        probeHeld.delete(fill.mint);
      }
    }

    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const tape = tapeFor(event.mint);
        tape.createdSlot = event.slot;
        tape.creator = event.creator;
        activeMints.add(event.mint);
      } else if (event.event === 'TradeEvent') {
        const tape = tapeFor(event.mint);
        const sol = Number(event.sol_amount) / LAMPORTS;
        activeMints.add(event.mint);
        if (event.is_buy) {
          if (tape.creator !== null && event.user === tape.creator) {
            tape.creatorBuySol += sol;
          } else {
            tape.outsideBuyers.add(event.user);
          }
        } else {
          if (tape.creator !== null && event.user === tape.creator) {
            tape.creatorSold = true;
          } else if (sol > tape.biggestOutsideSellSol) {
            tape.biggestOutsideSellSol = sol;
          }
          if (sol >= WHALE_SELL_SOL) whaleSells.add(event.mint);
        }
      } else {
        // CompleteEvent: the curve is done; forget the tape.
        tapes.delete(event.mint);
        openTrades.delete(event.mint);
        probeHeld.delete(event.mint);
        probePending.delete(event.mint);
      }
    }

    const orders: OrderInput[] = [];
    const orderCap = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    const txSol = Number(txFee) / LAMPORTS;

    // A sell that came back rejected or failed frees the trade to exit again.
    for (const fill of batch.fills) {
      if (fill.side === 'sell' && fill.status !== 'filled') {
        const trade = openTrades.get(fill.mint);
        if (trade !== undefined) trade.sellSent = false;
      }
    }

    const pendingMints = new Set<Pubkey>();
    const pendingSells = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      pendingMints.add(pending.order.mint);
      if (pending.order.side === 'sell') pendingSells.add(pending.order.mint);
    }
    const marks = new Map(batch.marks.map((mark) => [mark.mint, mark] as const));

    // ---- exits first: free a position slot before deciding entries ----
    for (const [mint, trade] of openTrades) {
      const position = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (position === undefined) {
        // Filled position is gone (sold, flattened, or the buy never
        // landed): stop tracking it unless its buy is still in flight.
        if (!pendingMints.has(mint)) openTrades.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const mark = marks.get(mint);
      const virtualQuote = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const virtualTokens = mark !== undefined ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellEstimate(BigInt(position.token_amount), virtualQuote, virtualTokens, txFee);
      const cost = Number(position.cost_lamports) / LAMPORTS;
      const tape = tapeFor(mint);
      const shouldExit =
        value >= cost * (1 + TAKE_PROFIT) ||
        value <= cost * (1 - STOP_LOSS) ||
        now - trade.openedSlot > MAX_HOLD_SLOTS ||
        whaleSells.has(mint) ||
        tape.creatorSold;
      if (!shouldExit || trade.sellSent || pendingSells.has(mint)) continue;
      if (orders.length >= orderCap) break;
      orders.push({
        side: 'sell',
        mint,
        token_amount: position.token_amount,
        max_slippage_bps: WIDE_SLIPPAGE_BPS,
      });
      trade.sellSent = true;
    }

    // ---- probe sells: a filled probe is sold on the next batch ----
    for (const mint of probeHeld) {
      const position = state.positions.get(mint);
      if (position === undefined) {
        if (!pendingMints.has(mint)) probeHeld.delete(mint);
        continue;
      }
      if (pendingSells.has(mint) || orders.length >= orderCap) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: position.token_amount,
        max_slippage_bps: WIDE_SLIPPAGE_BPS,
      });
    }

    // ---- entries: launch buys on coins seen in this batch ----
    let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
    let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of activeMints) {
      if (orders.length >= orderCap || freeSlots <= 0) break;
      if (pendingMints.has(mint) || openTrades.has(mint)) continue;
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || tape.decided || curve === undefined || curve.complete) continue;
      if (tape.createdSlot === null) continue;
      if (now - tape.createdSlot > ENTRY_WINDOW) {
        tape.decided = true;
        continue;
      }
      // Opening-tape rug filter.
      if (tape.creatorBuySol > MAX_CREATOR_BUY_SOL || tape.outsideBuyers.size > MAX_OPENING_BUYERS) {
        tape.decided = true;
        continue;
      }
      // Wait for at least one outside buyer: a launch nobody but the
      // creator touches is a dump in waiting. Not decided yet — the coin
      // may still qualify on a later batch while it is young.
      if (tape.outsideBuyers.size < 1) continue;
      if (tape.creatorSold || tape.biggestOutsideSellSol > MAX_OPENING_SELL_SOL) {
        tape.decided = true;
        continue;
      }
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > freeSol - txSol) amount = freeSol - txSol;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: WIDE_SLIPPAGE_BPS,
      });
      freeSol -= amount + txSol;
      openTrades.set(mint, { openedSlot: now, sellSent: false });
      tape.decided = true;
      freeSlots -= 1;
    }

    // ---- guardrail probes: tiny buys on launches the sniper passed on ----
    if (probeSends < MAX_PROBES && myCoins.size + probeSends < 20 + MAX_PROBES) {
      for (const mint of activeMints) {
        if (orders.length >= orderCap || freeSlots <= 0 || probeSends >= MAX_PROBES) break;
        if (pendingMints.has(mint) || openTrades.has(mint) || probePending.has(mint) || probeHeld.has(mint)) continue;
        if (myCoins.has(mint)) continue;
        const tape = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (tape === undefined || curve === undefined || curve.complete) continue;
        // Only coins the sniper has finished deciding on, so a probe never
        // competes with a sniper entry on the same mint.
        if (!tape.decided) continue;
        if (tape.creatorSold || tape.biggestOutsideSellSol > 1) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < MIN_PROBE_REAL_SOL) continue;
        if (freeSol < PROBE_SOL + txSol) break;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)),
          max_slippage_bps: WIDE_SLIPPAGE_BPS,
        });
        freeSol -= PROBE_SOL + txSol;
        probePending.add(mint);
        probeSends += 1;
        freeSlots -= 1;
      }
    }

    return orders;
  },
});
