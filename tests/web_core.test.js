// 웹 계산 엔진 테스트: node tests/web_core.test.js [python_fixture.json]
const assert = require("assert");
const fs = require("fs");
const Core = require("../web/core.js");
const Legacy = require("./legacy_v1_core.js");

function synthetic(n = 6000, seed = 1) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const c = { ts: [], open: [], high: [], low: [], close: [], volume: [] };
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px, shock = rnd() < 0.01 ? -0.02 * rnd() : 0;
    px *= Math.exp(0.0001 + shock + 0.004 * (rnd() + rnd() + rnd() - 1.5) * 2);
    c.ts.push(i * 300000); c.open.push(o); c.close.push(px);
    c.high.push(Math.max(o, px) * (1 + rnd() * 0.002)); c.low.push(Math.min(o, px) * (1 - rnd() * 0.002));
    c.volume.push(100 * (0.3 + rnd()) * (shock ? 4 : 1) * (rnd() < 0.05 ? 3 : 1));
  }
  return c;
}
const O = { startingCash: 1000, feeRate: 0.001, slippageBps: 5, positionPct: 1, cooldownBars: 3, minOrder: 10 };
const LEGACY_P = { emaTrend: 200, bbPeriod: 20, bbStd: 2, rsiPeriod: 14, rsiEntry: 35, takeProfitPct: 0.01,
                   stopLossPct: 0.006, maxHoldBars: 24, midExit: true, midExitMinPct: 0.003 };
const v1 = Core.byId("v1");
const reasonMap = r => r === "signal_exit" ? "mid_band" : r;

// 1) 새 엔진의 v1 == 기존 엔진 (회귀 테스트)
for (const seed of [1, 2, 3, 4]) {
  const c = synthetic(8000, seed);
  const a = Legacy.simulate(c, LEGACY_P, O), b = Core.simulate(c, v1, Core.defaults(v1), O);
  assert.strictEqual(b.trades.length, a.trades.length, `seed ${seed} 거래 수 다름`);
  assert(Math.abs(b.stats.totalReturn - a.stats.totalReturn) < 1e-12, `seed ${seed} 수익률 다름`);
  assert.deepStrictEqual(b.trades.map(t => reasonMap(t.reason)), a.trades.map(t => t.reason));
}

// 2) 청산 규칙
const p = { stopAtr: 2, takeAtr: 3, trailAtr: 0, maxHold: 10, minExitPct: 0.005 };
const pos = () => ({ entryPrice: 100, atr: 1, highest: 100 });
assert.strictEqual(Core.checkExit(pos(), 104, 97, 100, 0, false, p).reason, "stop_loss");   // 동시 도달 → 손절
assert.strictEqual(Core.checkExit(pos(), 103, 99, 100, 0, false, p).reason, "take_profit");
assert.strictEqual(Core.checkExit(pos(), 101, 99, 100.6, 0, true, p).reason, "signal_exit");
assert.strictEqual(Core.checkExit(pos(), 101, 99, 100.2, 0, true, p), null);              // 최소 수익 미달
assert.strictEqual(Core.checkExit(pos(), 101, 99, 100, 10, false, p).reason, "time_exit");
const tp = { ...p, takeAtr: 0, trailAtr: 2 }, tpos = pos();
assert.strictEqual(Core.checkExit(tpos, 106, 100, 105, 1, false, tp), null);               // 최고가 106 기록
const tr = Core.checkExit(tpos, 105, 103.9, 104, 2, false, tp);                            // 106 − 2 = 104
assert.strictEqual(tr.reason, "trail_stop"); assert.strictEqual(tr.price, 104);

// 3) 모든 전략이 오류·NaN 없이 돌고, 구간 분할이 맞는지
const c = synthetic(9000, 7), I = Core.makeI(c);
let anyTrades = 0;
for (const s of Core.STRATEGIES) {
  for (const prm of Core.grid(s)) {
    const r = Core.simulate(c, s, prm, { ...O, I });
    assert(r.equity.every(Number.isFinite), `${s.id} 자산 NaN`);
    assert(r.trades.every(t => Number.isFinite(t.pnl)), `${s.id} 손익 NaN`);
    anyTrades += r.trades.length;
  }
  const d = s.prepare(c, Core.defaults(s), I), v = s.view(c, d, c.close.length - 1, Core.defaults(s));
  assert(Array.isArray(v.conds) && v.conds.length >= 2, `${s.id} view`);
  const split = 6000, full = Core.simulate(c, s, Core.defaults(s), { ...O, I }),
        tr2 = Core.simulate(c, s, Core.defaults(s), { ...O, I, from: split });
  assert.strictEqual(tr2.start, split); assert(tr2.equity.length === c.close.length - split);
  assert(full.equity.length > tr2.equity.length);
}
assert(anyTrades > 0);

// 4) 리샘플: 5분봉 3개 → 15분봉 1개
const r15 = Core.resample(c, 3e5, 9e5);
assert.strictEqual(r15.ts.length, Math.floor(c.ts.length / 3));
assert.strictEqual(r15.high[0], Math.max(c.high[0], c.high[1], c.high[2]));
assert.strictEqual(r15.volume[1], c.volume[3] + c.volume[4] + c.volume[5]);

// 5) 수수료
const br = new Core.PaperBroker(1000, 0.001, 0);
br.buy("X", 100, 1000, 0, 0); assert(Math.abs(br.sell("X", 100, "t", 0).pnl + 1.999) < 1e-9);

// (선택) 파이썬 결과와 비교
if (process.argv[2]) {
  const fx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  fx.candles.volume = fx.candles.close.map(() => 1);
  const out = Core.simulate(fx.candles, v1, Core.defaults(v1), O);
  console.log(JSON.stringify({ trades: out.stats.trades, ret: out.stats.totalReturn }));
} else {
  console.log(`web core tests passed (${Core.STRATEGIES.length} strategies, ${Core.STRATEGIES.reduce((s, x) => s + Core.grid(x).length, 0)} combos, ${anyTrades} trades)`);
}
