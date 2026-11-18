// btc-race-24h-20261118-1444 — patient dip-buyer, long only, full-size.
// Speaks agent-fun/bars-replay/v1: the harness sends hello once, then one
// batch per bar (1-minute cbBTC/USDC bars), and this bot answers every batch
// with exactly one reply carrying its orders for that bar. Orders decided on
// a batch fill at the next bar's open, so every decision here is made on the
// latest closed bar and fills one minute later.
//
// Strategy: buy washout dips only — the close must sit in the bottom of its
// trailing 2h range, RSI(14) must be weak, the close must have ticked up, the
// close must be at least 0.8% below where it was 60 bars ago (a genuine
// selloff, not a slow drift), and the market must not be in a strong
// downtrend. Exits are a tight stop, a take-profit and a trailing stop off
// the peak since entry. A 4% equity drawdown from peak flattens everything
// and halts the bot. A 5-bar cooldown follows every exit. Two guardrail
// fallbacks widen the entry late in the window so the bot never finishes
// with zero trades.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 200;

// Entry
const RANGE_BARS = 120; // trailing 2h range: a 6h range adapts too slowly on
// a bleeding day, so its bottom-15% signals only appear in the last hours.
const RANGE_BOTTOM = 0.15; // close in the bottom 15% of that range
const RANGE_MIN_PCT = 0.005; // skip entries when the 2h range is under 0.5%:
// a "dip" inside a flat range is noise, and the ~26 bps round-trip cost
// would eat it before any rebound pays.
const RSI_PERIOD = 14;
const RSI_CAP = 45;
// Washout filter: the main entry only fires after a genuine selloff — the
// close at least 0.8% below where it was 60 bars ago. On a slow-bleed day the
// plain dip pattern buys every small dip and each one keeps bleeding; only
// the washout dips (RSI ~5-10, 60-bar return about -2%) bounced hard enough
// to pay the ~26 bps round trip. A dip in a flat or drifting market is not
// a washout and is skipped.
const WASHOUT_BARS = 60;
const WASHOUT_PCT = -0.008;
// Downtrend guard, as a share of price: block entries while SMA60 sits more
// than 2% below SMA240. (The raw (SMA60-SMA240)/ATR ratio is useless here:
// per-minute ATR is ~$0.015 while the SMAs differ by ~$0.30, so the ratio
// reads -10 or worse through every dip and blocks every entry.)
const TREND_BLOCK_PCT = -0.02;

// Exits
const STOP_PCT = 0.012; // -1.2% vs entry cost
const TAKE_PCT = 0.02; // +2.0% vs entry cost: the washout bounce that pays
// runs further than the first +1.5%, and a wider target also keeps the bot
// in the one good trade instead of churning through small dips.
const TRAIL_PCT = 0.012; // -1.2% from the peak since entry

// Safety
const EQUITY_DD_HALT = 0.04; // flatten + halt at 4% equity drawdown
const COOLDOWN_BARS = 5;
const NO_NEW_ENTRY_AFTER_SEQ = 1200; // entries after this have too little
// window left to reach the +2.0% take-profit before the final flatten, so
// their expected value is negative: the flatten alone costs ~13 bps.

// Guardrail fallbacks (only to guarantee >= 1 trade)
const WIDEN_SEQ = 1080; // widen the entry if no trade yet
const WIDEN_RANGE = 0.3;
const WIDEN_RSI = 50;
const LAST_RESORT_SEQ = 1320; // below-SMA60 entry if still no trade
const LAST_RESORT_RSI = 55;

const closes: number[] = []; // closes in USDC, oldest first
let priceScale = 5; // CBBTC's price_scale from hello (raw price / 10^scale);
// the kit's bars are raw integers near 6.5e9, i.e. ~$65,000 at scale 5 —
// never hardcode the divisor: the first build divided by 1e8 and its stop
// fired on the very next bar because entryPrice (from cost/qty) was in
// different units than the closes.
let peakEquity = 0n;
let halted = false;
let cooldownUntil = -1;
let trades = 0;
let entrySeq = -1; // seq of the bar on which the current position was opened
let peakSinceEntry = 0; // highest close since the current entry
let entryPrice = 0; // cost per unit of the current position, in USDC

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

// Wilder RSI over the closes seen so far.
function rsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// (SMA60 - SMA240) as a share of the latest close; null without history.
function trendScore(): number | null {
  const s60 = sma(closes, 60);
  const s240 = sma(closes, 240);
  if (s60 === null || s240 === null) return null;
  return (s60 - s240) / closes[closes.length - 1];
}

function rangePosition(): { pos: number; spanPct: number } | null {
  if (closes.length < RANGE_BARS) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = closes.length - RANGE_BARS; i < closes.length; i++) {
    if (closes[i] < lo) lo = closes[i];
    if (closes[i] > hi) hi = closes[i];
  }
  if (hi === lo) return null;
  return { pos: (closes[closes.length - 1] - lo) / (hi - lo), spanPct: (hi - lo) / lo };
}

function sellAll(state: BarsState): OrderInput[] {
  const p = state.positions.get(SYMBOL);
  if (!p || p.qty === 0n) return [];
  return [{ side: 'sell', symbol: SYMBOL, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onHello(state) {
    const sym = state.symbols.get(SYMBOL);
    if (sym !== undefined) priceScale = sym.price_scale;
  },
  onBatch(state, batch) {
    const closeRaw = state.close(SYMBOL);
    if (closeRaw === null) return [];
    // Prices arrive as raw integers at the symbol's price_scale.
    const close = Number(closeRaw) / 10 ** priceScale;
    closes.push(close);
    const seq = batch.seq;

    // Track the peak equity for the drawdown halt.
    if (state.equity > peakEquity) peakEquity = state.equity;

    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;

    // A buy filled on the previous batch: record its cost basis now.
    if (holding && entrySeq < 0) {
      entrySeq = seq;
      peakSinceEntry = close;
      // cost per unit in USDC: cost_quote_units x 10^qty_scale /
      // (qty x 10^quote_scale). The price_scale cancels, so this holds for
      // any price_scale — but it must be compared against closes divided by
      // 10^price_scale, never a hardcoded divisor.
      entryPrice = (Number(pos.cost) * 100) / Number(pos.qty);
    }

    // --- Safety: equity drawdown halt -------------------------------------
    if (!halted && peakEquity > 0n) {
      const dd = Number(peakEquity - state.equity) / Number(peakEquity);
      if (dd >= EQUITY_DD_HALT) {
        halted = true;
        if (holding) return sellAll(state);
        return [];
      }
    }
    if (halted) return [];

    // --- Position management ----------------------------------------------
    if (holding) {
      if (close > peakSinceEntry) peakSinceEntry = close;
      let exit = false;
      if (close <= entryPrice * (1 - STOP_PCT)) exit = true; // stop
      else if (close >= entryPrice * (1 + TAKE_PCT)) exit = true; // take-profit
      else if (close <= peakSinceEntry * (1 - TRAIL_PCT)) exit = true; // trailing stop
      if (exit) {
        cooldownUntil = seq + COOLDOWN_BARS;
        entrySeq = -1;
        entryPrice = 0;
        peakSinceEntry = 0;
        trades++;
        return sellAll(state);
      }
      return [];
    }

    // --- Entries ------------------------------------------------------------
    if (state.warmingUp) return [];
    if (seq >= NO_NEW_ENTRY_AFTER_SEQ) return [];
    if (seq < cooldownUntil) return [];
    if (state.cash <= 0n) return [];

    const r = rsi(closes, RSI_PERIOD);
    const range = rangePosition();
    const trend = trendScore();
    if (r === null || range === null) return [];
    const rp = range.pos;
    const uptick = closes.length >= 2 && close > closes[closes.length - 2];
    // A dip inside a near-flat range is noise: the round-trip cost eats it.
    const rangeWideEnough = range.spanPct >= RANGE_MIN_PCT;
    // 60-bar return, for the washout filter (null without the history).
    const ret60 =
      closes.length > WASHOUT_BARS
        ? (close - closes[closes.length - 1 - WASHOUT_BARS]) / closes[closes.length - 1 - WASHOUT_BARS]
        : null;
    const washedOut = ret60 !== null && ret60 <= WASHOUT_PCT;

    let wantBuy = false;
    if (trades === 0 && seq >= LAST_RESORT_SEQ) {
      // Last-resort guardrail entry: below the 60-bar average, weak RSI.
      const s60 = sma(closes, 60);
      if (s60 !== null && close < s60 && r < LAST_RESORT_RSI && uptick) wantBuy = true;
    } else if (trades === 0 && seq >= WIDEN_SEQ) {
      // Widened entry while still no trade.
      if (rangeWideEnough && rp <= WIDEN_RANGE && r < WIDEN_RSI && uptick && (trend === null || trend >= TREND_BLOCK_PCT)) wantBuy = true;
    } else if (rangeWideEnough && rp <= RANGE_BOTTOM && r < RSI_CAP && uptick && washedOut && (trend === null || trend >= TREND_BLOCK_PCT)) {
      wantBuy = true;
    }

    if (!wantBuy) return [];
    const room = state.weightRoom(SYMBOL);
    const spend = state.cash < room ? state.cash : room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
