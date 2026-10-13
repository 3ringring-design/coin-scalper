// 웹 버전 전략 코드(web/index.html의 CORE 블록) 테스트: node tests/web_core.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const src = html.split("// ===================== CORE-START")[1].split("// ===================== CORE-END")[0];
const Core = new Function("module", src.slice(src.indexOf("\n")) + "\nreturn Core;")(undefined);

// 파이썬과 비교할 데이터가 주어지면 그걸 쓰고, 아니면 결정적인 합성 데이터 생성
function synthetic(n = 3000, seed = 1) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const c = { ts: [], open: [], high: [], low: [], close: [] };
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px *= Math.exp(0.0002 + 0.004 * (rnd() + rnd() + rnd() - 1.5) * 2);
    c.ts.push(i * 300000); c.open.push(o); c.close.push(px);
    c.high.push(Math.max(o, px) * (1 + rnd() * 0.002)); c.low.push(Math.min(o, px) * (1 - rnd() * 0.002));
  }
  return c;
}

const P = { emaTrend: 200, bbPeriod: 20, bbStd: 2, rsiPeriod: 14, rsiEntry: 35, takeProfitPct: 0.01,
            stopLossPct: 0.006, maxHoldBars: 24, midExit: true, midExitMinPct: 0.003 };
const O = { startingCash: 1000, feeRate: 0.001, slippageBps: 5, positionPct: 1, cooldownBars: 3, minOrder: 10 };

// 청산 우선순위
assert.strictEqual(Core.exitSignal(100, 0, 102, 99, 100, 100, P).reason, "stop_loss");
assert.strictEqual(Core.exitSignal(100, 0, 101.5, 99.9, 100, 105, P).reason, "take_profit");
assert.strictEqual(Core.exitSignal(100, 0, 100.5, 99.9, 100.4, 100.2, P).reason, "mid_band");
assert.strictEqual(Core.exitSignal(100, 24, 100.1, 99.9, 100, 101, P).reason, "time_exit");
assert.strictEqual(Core.exitSignal(100, 3, 100.1, 99.9, 100, 101, P), null);

// 수수료
const b = new Core.PaperBroker(1000, 0.001, 0);
b.buy("X", 100, 1000, 0, 0);
const t = b.sell("X", 100, "test", 0);
assert(Math.abs(t.pnl + 1.999) < 1e-9);

// 지표 범위
const c = synthetic();
const r = Core.rsi(c.close, 14).filter(v => !Number.isNaN(v));
assert(r.every(v => v >= 0 && v <= 100));

// 백테스트가 돌고 거래가 생기는지
const res = Core.simulate(c, P, O);
assert(res.stats.trades > 0, "거래가 하나도 없음");
assert.strictEqual(res.equity.length, c.close.length - Core.warmup(P));

// 파이썬 결과와 교차검증 (선택): node tests/web_core.test.js fixture.json
if (process.argv[2]) {
  const fx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = Core.simulate(fx.candles, P, O);
  console.log(JSON.stringify({ stats: out.stats, reasons: out.trades.map(t => t.reason) }));
} else {
  console.log("web core tests passed", res.stats);
}
