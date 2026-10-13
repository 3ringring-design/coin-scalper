// 웹 v1 전략 코드의 고정 사본 (회귀 테스트용 기준). 수정하지 마세요.
const Core = (() => {
  function ema(x, n) {
    const a = 2 / (n + 1), out = new Array(x.length);
    let prev;
    for (let i = 0; i < x.length; i++) { prev = i === 0 ? x[0] : a * x[i] + (1 - a) * prev; out[i] = prev; }
    return out;
  }
  function rsi(c, n) {
    const out = new Array(c.length).fill(NaN);
    let ag = 0, al = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
      if (i === 1) { ag = g; al = l; } else { ag += (g - ag) / n; al += (l - al) / n; }
      out[i] = al === 0 ? (ag === 0 ? NaN : 100) : 100 - 100 / (1 + ag / al);
    }
    return out;
  }
  function bollinger(c, n, k) {
    const mid = new Array(c.length).fill(NaN), up = mid.slice(), low = mid.slice();
    for (let i = n - 1; i < c.length; i++) {
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j];
      const m = s / n; let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (c[j] - m) ** 2;
      const sd = Math.sqrt(v / n);
      mid[i] = m; up[i] = m + k * sd; low[i] = m - k * sd;
    }
    return { mid, up, low };
  }
  const warmup = p => Math.max(p.emaTrend * 2, p.bbPeriod, p.rsiPeriod * 5);

  function addIndicators(c, p) {
    const bb = bollinger(c.close, p.bbPeriod, p.bbStd);
    return { ema: ema(c.close, p.emaTrend), mid: bb.mid, up: bb.up, low: bb.low, rsi: rsi(c.close, p.rsiPeriod) };
  }
  function conditions(c, ind, i, p) {
    return [c.close[i] > ind.ema[i], c.close[i] < ind.low[i], ind.rsi[i] < p.rsiEntry];
  }
  function entrySignal(c, ind, i, p) {
    if ([c.close[i], ind.ema[i], ind.low[i], ind.rsi[i]].some(v => v === undefined || Number.isNaN(v))) return false;
    return conditions(c, ind, i, p).every(Boolean);
  }
  // 한 캔들에서 손절·익절 동시 도달 시 보수적으로 손절
  function exitSignal(entry, barsHeld, high, low, close, bbMid, p) {
    const sl = entry * (1 - p.stopLossPct), tp = entry * (1 + p.takeProfitPct);
    if (low <= sl) return { reason: "stop_loss", price: sl };
    if (high >= tp) return { reason: "take_profit", price: tp };
    if (p.midExit && !Number.isNaN(bbMid) && close >= bbMid && close >= entry * (1 + p.midExitMinPct))
      return { reason: "mid_band", price: close };
    if (barsHeld >= p.maxHoldBars) return { reason: "time_exit", price: close };
    return null;
  }

  class PaperBroker {
    constructor(startingCash, feeRate, slippageBps, state) {
      this.feeRate = feeRate; this.slip = slippageBps / 10000;
      Object.assign(this, { startingCash, cash: startingCash, positions: {}, trades: [], nTrades: 0, nWins: 0, realizedPnl: 0 }, state || {});
    }
    toJSON() {
      const { startingCash, cash, positions, nTrades, nWins, realizedPnl } = this;
      return { startingCash, cash, positions, trades: this.trades.slice(-500), nTrades, nWins, realizedPnl };
    }
    buy(symbol, price, quote, candleTs, when) {
      quote = Math.min(quote, this.cash);
      const fill = price * (1 + this.slip), fee = quote * this.feeRate, qty = (quote - fee) / fill;
      this.cash -= quote;
      const pos = { qty, entryPrice: fill, cost: quote, entryTime: when, entryCandleTs: candleTs };
      this.positions[symbol] = pos;
      return pos;
    }
    sell(symbol, price, reason, when) {
      const pos = this.positions[symbol]; delete this.positions[symbol];
      const fill = price * (1 - this.slip), gross = pos.qty * fill, proceeds = gross - gross * this.feeRate;
      this.cash += proceeds;
      const pnl = proceeds - pos.cost;
      this.nTrades++; if (pnl > 0) this.nWins++; this.realizedPnl += pnl;
      const t = { symbol, entryTime: pos.entryTime, exitTime: when, entryPrice: pos.entryPrice, exitPrice: fill,
                  qty: pos.qty, cost: pos.cost, proceeds, pnl, pnlPct: pnl / pos.cost, reason };
      this.trades.push(t);
      return t;
    }
    equity(prices) {
      let v = this.cash;
      for (const [s, pos] of Object.entries(this.positions)) v += pos.qty * (prices[s] ?? pos.entryPrice);
      return v;
    }
  }

  function simulate(c, p, o) {
    const sym = o.symbol || "SYM", ind = addIndicators(c, p), n = c.close.length, w = warmup(p);
    const b = new PaperBroker(o.startingCash, o.feeRate, o.slippageBps);
    let entryI = null, lastExitI = -1e9;
    const equity = [];
    for (let i = w; i < n; i++) {
      if (entryI === null && i - lastExitI > o.cooldownBars && entrySignal(c, ind, i - 1, p)) {
        const size = Math.min(b.equity({ [sym]: c.open[i] }) * o.positionPct, b.cash);
        if (size >= (o.minOrder ?? 10)) { b.buy(sym, c.open[i], size, c.ts[i - 1], c.ts[i]); entryI = i; }
      }
      if (entryI !== null) {
        const pos = b.positions[sym];
        const r = exitSignal(pos.entryPrice, i - entryI, c.high[i], c.low[i], c.close[i], ind.mid[i], p);
        if (r) { b.sell(sym, r.price, r.reason, c.ts[i]); entryI = null; lastExitI = i; }
      }
      equity.push(b.equity({ [sym]: c.close[i] }));
    }
    if (entryI !== null) { b.sell(sym, c.close[n - 1], "end_of_data", c.ts[n - 1]); equity[equity.length - 1] = b.equity({}); }
    const tr = b.trades, wins = tr.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0),
          losses = -tr.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
    let peak = -Infinity, mdd = 0;
    for (const e of equity) { peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1); }
    const stats = {
      trades: tr.length,
      winRate: tr.length ? tr.filter(t => t.pnl > 0).length / tr.length : 0,
      totalReturn: equity.length ? equity[equity.length - 1] / o.startingCash - 1 : 0,
      maxDrawdown: equity.length ? mdd : 0,
      profitFactor: losses > 0 ? wins / losses : Infinity,
      buyHoldReturn: n > w ? c.close[n - 1] / c.close[w] - 1 : NaN,
    };
    return { stats, trades: tr, equity, start: w };
  }

  return { ema, rsi, bollinger, warmup, addIndicators, conditions, entrySignal, exitSignal, PaperBroker, simulate };
})();
module.exports = Core;
