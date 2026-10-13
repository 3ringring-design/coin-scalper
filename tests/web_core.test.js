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
  const w = Core.warmupOf(s, Core.defaults(s), Core.tfOf(c)), st0 = Math.max(split, w);
  assert.strictEqual(tr2.start, st0); assert(tr2.equity.length === c.close.length - st0);
  assert(full.equity.length >= tr2.equity.length);
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

// 6) 선물: 숏 손익, 레버리지, 강제청산, 펀딩
{
  const fb = new Core.FuturesBroker(1000, 0, 0);
  fb.open("X", -1, 100, 100, 0, 0, { lev: 2, atr: 1 });            // 숏 증거금 100 × 2배
  assert(Math.abs(fb.equity({ X: 90 }) - 1020) < 1e-9);             // 10% 하락 → +20
  const t = fb.close("X", 90, "take_profit", 0);
  assert(Math.abs(t.pnl - 20) < 1e-9 && Math.abs(t.grossPct - 0.1) < 1e-12 && Math.abs(fb.cash - 1020) < 1e-9);

  const lb = new Core.FuturesBroker(1000, 0.0005, 0, 0.005);
  const pos = lb.open("X", 1, 100, 100, 0, 0, { lev: 10, atr: 10 });
  assert(Math.abs(pos.liq - 90.5) < 1e-9);                           // 100 × (1 − 0.1 + 0.005)
  const pl = { stopAtr: 2, takeAtr: 0, trailAtr: 0, maxHold: 99, minExitPct: 0 };
  assert.strictEqual(Core.checkExit(pos, 101, 90, 95, 0, false, pl).reason, "liquidation");   // 손절(80)보다 청산가가 먼저
  const tight = { ...pl, stopAtr: 0.3 };                             // 손절 97 → 청산가보다 먼저
  assert.strictEqual(Core.checkExit({ ...pos }, 101, 90, 95, 0, false, tight).reason, "stop_loss");
  const lt = lb.close("X", 90.5, "liquidation", 0);
  assert(Math.abs(lt.pnl + 100 + 0.5) < 1e-9 && lb.nLiq === 1);      // 증거금 + 진입 수수료 손실

  const sp = { stopAtr: 2, takeAtr: 3, trailAtr: 2, maxHold: 99, minExitPct: 0.005 };
  const sh = { dir: -1, entryPrice: 100, atr: 1, lowest: 100 };
  assert.strictEqual(Core.checkExit(sh, 102.5, 99, 100, 0, false, sp).reason, "stop_loss");
  const sh2 = { dir: -1, entryPrice: 100, atr: 1, lowest: 100 };
  assert.strictEqual(Core.checkExit(sh2, 100.5, 97, 98, 0, false, sp).reason, "take_profit");
  const sh3 = { dir: -1, entryPrice: 100, atr: 1, lowest: 100 };
  assert.strictEqual(Core.checkExit(sh3, 100, 98.5, 99, 0, false, sp), null);                 // 최저 98.5 기록
  assert.strictEqual(Core.checkExit(sh3, 100.6, 99, 100, 1, false, sp).reason, "trail_stop"); // 98.5 + 2 = 100.5

  const fu = new Core.FuturesBroker(1000, 0, 0);
  fu.open("X", 1, 100, 100, 0, 0, { lev: 1 }); fu.fund("X", 100, 0.0001);
  assert(Math.abs(fu.close("X", 100, "t", 0).pnl + 0.01) < 1e-12);  // 롱은 펀딩비를 냄
}
{
  const c = synthetic(9000, 21), cm = Core.mirror(c), I = Core.makeI(c), Im = Core.makeI(cm);
  const F = { ...O, market: "futures", feeRate: 0.0005, slippageBps: 3, I, cm, Im };
  for (const s of Core.STRATEGIES) {
    const p = Core.defaults(s);
    const L = Core.simulate(c, s, p, { ...F, dir: "long" }), S = Core.simulate(c, s, p, { ...F, dir: "short" }), B = Core.simulate(c, s, p, { ...F, dir: "both" });
    assert(L.trades.every(t => t.dir === 1) && S.trades.every(t => t.dir === -1), `${s.id} 방향`);
    assert(B.equity.every(Number.isFinite) && S.equity.every(Number.isFinite), `${s.id} NaN`);
    const l10 = Core.simulate(c, s, p, { ...F, dir: "both", leverage: 10 });
    assert(l10.equity.every(v => v >= 0), `${s.id} 자산 음수`);
  }
  // 숏 신호 = 뒤집힌 차트의 롱 신호
  const v = Core.byId("v1"), sOnly = Core.simulate(c, v, Core.defaults(v), { ...F, dir: "short" });
  assert(sOnly.trades.length > 0, "숏 거래 없음");
  // 레버리지를 올리면 낙폭이 커져야 함
  const pb = Core.byId("pullback"), pp = Core.defaults(pb);
  const d1 = Core.simulate(c, pb, pp, { ...F, dir: "both", leverage: 1 }).stats.maxDrawdown,
        d5 = Core.simulate(c, pb, pp, { ...F, dir: "both", leverage: 5 }).stats.maxDrawdown;
  assert(d5 < d1, "레버리지 낙폭");
}

// 7) 조사 기반 전략·시장 상태 필터
{
  const H = 36e5, D = 864e5;
  // 효율비율: 일직선 상승 = 1, 왕복 = 0
  assert.strictEqual(Core.effRatio([1, 2, 3, 4, 5], 4)[4], 1);
  assert.strictEqual(Core.effRatio([1, 2, 1, 2, 1], 4)[4], 0);
  // 일봉 정보: 둘째 날 시가·전날 변동폭
  const mk = rows => ({ ts: rows.map(r => r[0]), open: rows.map(r => r[1]), high: rows.map(r => r[2]), low: rows.map(r => r[3]), close: rows.map(r => r[4]), volume: rows.map(() => 1) });
  const dd = Core.dayInfo(mk([[0, 10, 12, 9, 11], [12 * H, 11, 15, 10, 14], [D, 14, 14, 13, 13], [D + 12 * H, 13, 16, 12, 15]]));
  assert.deepStrictEqual([dd.dayOpen[2], dd.dayOpen[3], dd.prevRange[2]], [14, 14, 6]);   // 전날 고 15 − 저 9
  // 시간대 예측: 매일 UTC 22시에만 +1% 오르는 1시간봉 → 21시 끝 봉에서 다음 1시간 예상 ≈ +1%
  const rows = []; let px = 100;
  for (let k = 0; k < 24 * 40; k++) { const t = k * H, o = px; if ((t % D) / H === 22) px *= 1.01; rows.push([t, o, Math.max(o, px), Math.min(o, px), px]); }
  const cc = mk(rows), f = Core.seasonForecast(cc, 30, 1), at21 = rows.findIndex((r, k) => k > 24 * 35 && (r[0] % D) / H === 21);
  assert(Math.abs(f[at21] - 0.01) < 1e-9, "시간대 예측");
  assert(Math.abs(f[at21 + 5]) < 1e-12);
  // 필터: 같은 전략에 추세장만 켜면 거래 수가 같거나 줄어야 함
  const c = Core.resample(synthetic(12000, 5), 3e5, 36e5), I = Core.makeI(c);
  for (const s of Core.STRATEGIES) {
    const p0 = Core.defaults(s), a = Core.simulate(c, s, p0, { ...O, I }), b = Core.simulate(c, s, { ...p0, regime: 1 }, { ...O, I });
    assert(b.trades.length <= a.trades.length + 1, `${s.id} 필터`);
    assert(a.equity.every(Number.isFinite), `${s.id} 1h NaN`);
  }
  // 변동성 돌파·장중 모멘텀은 하루 안에 청산 (보유 ≤ 24시간)
  for (const id of ["volbreak", "intramom"]) {
    const s = Core.byId(id), r = Core.simulate(c, s, { ...Core.defaults(s), stopAtr: 50 }, { ...O, I, market: "futures", dir: "both" });
    assert(r.trades.length > 0, `${id} 거래 없음`);
    assert(r.trades.every(t => t.reason === "end_of_data" || Math.floor((t.exitTime - 1) / D) === Math.floor(t.entryTime / D)), `${id} 하루 넘김`);
  }
}

// 8) 봉 내부 확인 필터 · 앙상블
{
  const base = synthetic(16000, 9);
  let s2 = 77; const rnd = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648;
  base.takerBuy = base.volume.map((v, i) => v * Math.min(0.95, Math.max(0.05, 0.5 + (base.close[i] > base.open[i] ? 0.12 : -0.12) + (rnd() - 0.5) * 0.3)));
  // 리샘플 합산 · 뒤집힌 차트는 매수↔매도 체결
  const r15 = Core.resample(base, 3e5, 9e5), m = Core.mirror(base);
  assert(Math.abs(r15.takerBuy[2] - (base.takerBuy[6] + base.takerBuy[7] + base.takerBuy[8])) < 1e-9);
  assert(Math.abs(m.takerBuy[5] - (base.volume[5] - base.takerBuy[5])) < 1e-12);
  // 규칙: 추세형은 매수 우세 + 위쪽 마감, 되돌림형은 직전 매도 우세 + 받아낸 마감
  const mk = (tb, o, h, l, c) => ({ ts: tb.map((_, i) => i * 3e5), open: o, high: h, low: l, close: c, volume: tb.map(() => 1), takerBuy: tb });
  const p = { flow: 1, flowThr: 0.55 };
  const up = mk([0.5, 0.5, 0.5, 0.7], [1, 1, 1, 1], [2, 2, 2, 2], [0, 0, 0, 0], [1, 1, 1, 1.8]);
  assert.strictEqual(Core.flowOk(up, Core.makeI(up), 3, p, "trend"), true);
  const weak = mk([0.5, 0.5, 0.5, 0.5], [1, 1, 1, 1], [2, 2, 2, 2], [0, 0, 0, 0], [1, 1, 1, 1.8]);
  assert.strictEqual(Core.flowOk(weak, Core.makeI(weak), 3, p, "trend"), false);
  const dump = mk([0.3, 0.35, 0.3, 0.5], [1, 1, 1, 1], [2, 2, 2, 2], [0, 0, 0, 0], [1, 1, 1, 1.2]);
  assert.strictEqual(Core.flowOk(dump, Core.makeI(dump), 3, p, "revert"), true);
  assert.strictEqual(Core.flowOk(up, Core.makeI(up), 3, p, "revert"), false);
  // 필터를 켜면 거래가 줄고, 앙상블은 동의 수를 높일수록 거래가 줄어야 함
  const c = Core.resample(base, 3e5, 9e5), I = Core.makeI(c), cm = Core.mirror(c), Im = Core.makeI(cm);
  const F = { ...O, market: "futures", feeRate: 0.0005, slippageBps: 3, dir: "both", I, cm, Im };
  for (const id of ["pullback", "squeeze", "capitulation", "volbreak"]) {
    const s = Core.byId(id), p0 = Core.defaults(s);
    const a = Core.simulate(c, s, p0, F).trades.length, b = Core.simulate(c, s, { ...p0, flow: 1 }, F).trades.length;
    assert(b <= a + 1, `${id} 봉 내부 필터`);
  }
  const ens = Core.byId("ensemble"), pe = Core.defaults(ens);
  const e1 = Core.simulate(c, ens, { ...pe, votes: 1 }, F), e2 = Core.simulate(c, ens, { ...pe, votes: 2 }, F);
  assert(e1.trades.length > 0 && e2.trades.length <= e1.trades.length, "앙상블 투표");
  assert(e1.equity.every(Number.isFinite), "앙상블 NaN");
  // 대칭성: 뒤집은 차트(= 하락장)에서는 같은 신호가 숏으로 나와야 함
  const em = Core.simulate(cm, ens, { ...pe, votes: 1 }, { ...F, I: Im, cm: c, Im: I });
  assert(e1.trades.filter(t => t.dir > 0).length > 0 && em.trades.filter(t => t.dir < 0).length > 0, "앙상블 롱·숏 대칭");
}

// 9) 분할 매수 · 분할 매도
{
  const near = (a, b, m) => assert(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  // 선물 회계: 2배, 100@100 진입 → 100@90 추가 → 절반 110에 익절 → 나머지 100에 청산 (수수료 0)
  const fb = new Core.FuturesBroker(1000, 0, 0);
  const pos = fb.open("X", 1, 100, 100, 0, 0, { lev: 2, atr: 5 });
  fb.add("X", 90, 100);
  near(pos.qty, 2 + 200 / 90, "수량"); near(pos.entryPrice, 400 / pos.qty, "평단"); near(pos.ref, 100, "손절 기준은 최초가");
  fb.partial("X", 0.5, 110);
  const t = fb.close("X", 100, "time_exit", 0);
  const manual = (pos.qty * 2) / 2 * (110 - 400 / (2 + 200 / 90)) + (2 + 200 / 90) / 2 * (100 - 400 / (2 + 200 / 90));
  near(t.pnl, manual, "분할 손익"); near(fb.cash, 1000 + manual, "현금"); near(t.cost, 200, "총 투자금");
  // 수수료 있을 때도 현금 = 시작 + 손익
  const fb2 = new Core.FuturesBroker(1000, 0.0005, 3);
  fb2.open("X", -1, 100, 100, 0, 0, { lev: 3, atr: 2 }); fb2.add("X", 103, 80); fb2.fund("X", 102, 0.0001); fb2.partial("X", 0.5, 97);
  const t2 = fb2.close("X", 99, "take_profit", 0);
  near(fb2.cash, 1000 + t2.pnl, "선물 현금 일치");
  const sb = new Core.PaperBroker(1000, 0.001, 5);
  sb.buy("X", 100, 300, 0, 0, { atr: 2 }); sb.add("X", 97, 200); sb.partial("X", 0.5, 105);
  const t3 = sb.sell("X", 101, "time_exit", 0);
  near(sb.cash, 1000 + t3.pnl, "현물 현금 일치"); near(t3.cost, 500, "현물 총 투자금");

  // 손절선 고정: 되돌림형 평단 낮추기 후에도 손절선은 최초가 − 2ATR
  const p = { stopAtr: 2, takeAtr: 0, trailAtr: 0, maxHold: 99, minExitPct: 0, scaleIn: 1, siFrac: 0.5, siAtr: 1, scaleOut: 1, soFrac: 0.5, soAtr: 1.5 };
  const b3 = new Core.FuturesBroker(1000, 0, 0);
  const ps = Core.openPos(b3, "X", 1, 100, 200, 0, 0, { atr: 2, lev: 1 }, p, "revert");
  near(ps.margin, 100, "1차 50%"); near(ps.reserve, 100, "예약 50%");
  assert(Core.scaleInStep(b3, "X", ps, 101, 97.9, p)); near(b3.positions.X.entryPrice, 200 / (1 + 100 / 98), "추가 진입가 98");
  assert.strictEqual(Core.checkExit(ps, 99, 96.1, 97, 1, false, p), null);              // 손절 96에 안 닿음
  assert.strictEqual(Core.checkExit(ps, 99, 95.9, 97, 2, false, p).reason, "stop_loss");
  // 분할 매도 후 남은 물량은 본전 손절
  const b4 = new Core.FuturesBroker(1000, 0, 0);
  const p4 = { ...p, scaleIn: 0 }, ps4 = Core.openPos(b4, "X", 1, 100, 200, 0, 0, { atr: 2, lev: 1 }, p4, "trend");
  assert(Core.scaleOutStep(b4, "X", ps4, 103.1, 100.5, p4, 0));                          // 100 + 1.5×2 = 103
  assert.strictEqual(Core.checkExit(ps4, 101, 99.9, 100, 3, false, p4).reason, "breakeven");
  // 불타기: 추가 후 최악 손실이 처음 계획(전량 × 2ATR)을 넘지 않음
  const p5 = { ...p, scaleOut: 0 }, b5 = new Core.FuturesBroker(1000, 0, 0), ps5 = Core.openPos(b5, "X", 1, 100, 200, 0, 0, { atr: 2, lev: 1 }, p5, "trend");
  assert(Core.scaleInStep(b5, "X", ps5, 102.1, 100, p5), "불타기 추가");
  const stopNow = ps5.ref - 2 * 2, worst = ps5.qty * (stopNow - ps5.entryPrice);
  assert(worst >= -200 * 4 / 100 - 1e-9 && worst < -7.5, `불타기 최악 손실 ≤ 계획: ${worst}`);

  // 시뮬레이션: 옵션을 켜도 사실상 꺼진 설정이면 결과 동일 (siFrac=1, soAtr=1000)
  const c = Core.resample(synthetic(15000, 13), 3e5, 9e5), I = Core.makeI(c), cm = Core.mirror(c), Im = Core.makeI(cm);
  const F = { ...O, market: "futures", feeRate: 0.0005, slippageBps: 3, dir: "both", I, cm, Im };
  for (const id of ["capitulation", "pullback", "donchian", "v1"]) {
    const s = Core.byId(id), p0 = Core.defaults(s), a = Core.simulate(c, s, p0, F);
    const z = Core.simulate(c, s, { ...p0, scaleIn: 1, siFrac: 1, scaleOut: 1, soAtr: 1000 }, F);
    assert.strictEqual(z.trades.length, a.trades.length, `${id} 꺼진 분할 = 기본`);
    near(z.stats.totalReturn, a.stats.totalReturn, `${id} 수익률 동일`);
    for (const v of [{ scaleIn: 1 }, { scaleOut: 1 }, { scaleIn: 1, scaleOut: 1 }]) {
      const r = Core.simulate(c, s, { ...p0, ...v }, { ...F, leverage: 3 });
      assert(r.equity.every(x => Number.isFinite(x) && x >= 0), `${id} 분할 NaN`);
    }
  }
}

// 10) 넓은 익절·손절 탐색: 비교값만 바뀌고, 원래 비교값이 없는 항목은 그대로
{
  const s = Core.byId("capitulation"), g = Core.grid(s, { regime: 2 }, Core.WIDE_GRID);
  assert.deepStrictEqual([...new Set(g.map(p => p.stopAtr))], [2.5, 4, 6, 8]);
  assert.deepStrictEqual([...new Set(g.map(p => p.takeAtr))], [2.5, 4, 6, 8]);
  assert.deepStrictEqual([...new Set(g.map(p => p.maxHold))], [36, 108]);
  assert(g.every(p => p.regime === 2 && p.trailAtr === 0));                // 추적손절은 원래 비교값이 없어서 그대로
  const v1 = Core.byId("v1");
  assert.strictEqual(Core.grid(v1, null, Core.WIDE_GRID).length, 2);      // v1은 보유 시간만 (고정 % 손절)
}

// 11) 위험 기준 크기 · 큰 방향 · 러너 · 지정가 진입
{
  const near = (a, b, m) => assert(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  const R = { positionPct: 1, sizing: "risk", riskPct: 0.01 }, P = { stopAtr: 2 };
  near(Core.sizeFor(1000, 1000, 100, 2, P, R, 1), 250, "손절 4% → 위험 1% = 250");        // 1000×1% / 4%
  near(Core.sizeFor(1000, 1000, 100, 2, P, R, 5), 50, "5배면 증거금 50");
  near(Core.sizeFor(1000, 1000, 100, 0.1, P, R, 1), 1000, "상한은 고정 비중");
  near(Core.sizeFor(1000, 1000, 100, 2, P, { positionPct: 0.3 }, 1), 300, "고정 모드");

  // 방향성 없는 1시간봉 랜덤워크 (체결강도 포함)
  const c = (() => {
    let sd = 4242; const r = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648;
    const x = { ts: [], open: [], high: [], low: [], close: [], volume: [], takerBuy: [] }; let px = 100;
    for (let i = 0; i < 6000; i++) { const o = px; px *= Math.exp(0.012 * (r() + r() + r() - 1.5) * 1.15); const v = 100 * (0.3 + r());
      x.ts.push(i * 36e5); x.open.push(o); x.close.push(px); x.high.push(Math.max(o, px) * (1 + r() * 0.004)); x.low.push(Math.min(o, px) * (1 - r() * 0.004));
      x.volume.push(v); x.takerBuy.push(v * (0.4 + r() * 0.2)); }
    return x;
  })();
  const I = Core.makeI(c), cm = Core.mirror(c), Im = Core.makeI(cm);
  const F = { ...O, market: "futures", feeRate: 0.0005, slippageBps: 3, makerFee: 0.0002, dir: "both", I, cm, Im };
  const s = Core.byId("pullback"), p0 = { ...Core.defaults(s), stopAtr: 4 };
  // 위험 기준: 손절 거래의 손실이 자산의 약 1% (수수료 여유 포함)
  const rk = Core.simulate(c, s, { ...p0, stopAtr: 1, scaleIn: 0 }, { ...F, sizing: "risk", riskPct: 0.01 });
  let eq = 1000, sl = 0;
  for (const t of rk.trades) { if (t.reason === "stop_loss") { sl++; assert(t.pnl >= -0.0115 * eq, `위험 기준 손실 한도 ${t.pnl / eq}`); } eq += t.pnl; }
  assert(sl > 0, "손절 거래가 있어야 검증 가능");
  // 큰 방향: 켜면 거래가 같거나 줄고, 숏/롱 손익이 따로 집계됨
  const base = Core.simulate(c, s, p0, F), bi = Core.simulate(c, s, { ...p0, bias: 1, biasDays: 10 }, F);
  assert(bi.trades.length <= base.trades.length, "큰 방향 필터");
  near(base.stats.longPnl + base.stats.shortPnl, base.trades.reduce((a, t) => a + t.pnl, 0) / 1000, "롱+숏 손익 = 전체");
  // 러너: 분할 익절 뒤에는 익절선·신호 청산 없이 추적/본전/시간으로만
  const rn = Core.simulate(c, s, { ...p0, scaleOut: 1, runner: 1, runAtr: 3 }, F);
  assert(rn.trades.filter(t => t.scaled.includes("½")).every(t => !["take_profit", "signal_exit"].includes(t.reason)), "러너 청산 방식");
  assert(rn.equity.every(Number.isFinite));
  // 지정가 진입: 체결가는 신호 봉 종가보다 좋은 가격(롱은 낮게), 슬리피지 없음, 일부 신호는 미체결
  const lm = Core.simulate(c, s, { ...p0, limitEntry: 1, limOff: 0.25, limBars: 3 }, F);
  assert(lm.trades.length > 0 && lm.trades.length <= base.trades.length + 2, "지정가 체결 수");
  assert(lm.trades.every(t => Math.abs(t.entryPrice / (t.rawEntry ?? t.entryPrice) - 1) < 1e-12 || t.scaled), "지정가는 슬리피지 없음");
  // 메이커 익절: 익절 체결가 = 목표가 그대로 (슬리피지 없음)
  const fb = new Core.FuturesBroker(1000, 0.0005, 10, 0.005, null, 0.0002);
  fb.open("X", 1, 100, 100, 0, 0, { lev: 1 });
  const tp = fb.close("X", 110, "take_profit", 0, true);
  near(tp.exitPrice, 110, "메이커 익절가"); near(fb.cash, 1000 + tp.pnl, "현금 일치");
}

// 12) 켈리 동적 위험 · 자동 레버리지
{
  const near = (a, b, m) => assert(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  const K = { kellyFrac: 0.25, kellyN: 30, riskMin: 0.005, riskMax: 0.03 };
  const mk = (w, l, rw = 1, rl = -1) => [...Array(w).fill({ rmult: rw }), ...Array(l).fill({ rmult: rl })];
  near(Core.kellyRisk(mk(3, 3), K, 0.01).risk, 0.01, "거래 10개 미만 → 기본 위험");
  near(Core.kellyRisk(mk(12, 8, 1, -0.5), K, 0.01).risk, 0.03, "W 0.6, R 2 → f 0.4 → 1/4 = 10% → 최대 3%");
  near(Core.kellyRisk(mk(11, 9), K, 0.01).risk, 0.25 * (0.55 - 0.45 / 1), "W 0.55, R 1 → f 0.1 → 1/4 켈리 2.5%");
  near(Core.kellyRisk(mk(4, 6), K, 0.01).risk, 0.005, "우위 없음 → 최소 위험");
  // 상황별: 숏은 잘 맞고(승 12/15) 롱은 안 맞으면(승 3/15) → 숏엔 크게, 롱엔 최소로
  const hist = [...Array(12).fill({ dir: -1, rmult: 1 }), ...Array(3).fill({ dir: -1, rmult: -1 }),
                ...Array(3).fill({ dir: 1, rmult: 1 }), ...Array(12).fill({ dir: 1, rmult: -1 })];
  const KK = { ...K, riskMax: 0.08, kellyFrac: 0.5 };
  near(Core.kellyRisk(hist, KK, 0.01, -1).risk, 0.08, "숏: W 0.8 → 1/2 켈리 30% → 최대 8%");
  near(Core.kellyRisk(hist, KK, 0.01, 1).risk, 0.005, "롱: 우위 없음 → 최소");
  near(Core.kellyRisk(hist, KK, 0.01).risk, 0.005, "합쳐서 보면 W 0.5 → 우위 없음");
  // 자동 레버리지: 손절 1%에 위험 2% → 필요 포지션 2,000, 증거금 상한 330 → 3배 상한
  const pl = Core.sizePlan(1000, 1000, 100, 0.5, { stopAtr: 2 }, { positionPct: 0.33, sizing: "risk", riskPct: 0.02, autoLev: true, maxLev: 3 }, 1, []);
  near(pl.lev, 3, "자동 레버리지 상한"); near(pl.amount, 330, "증거금 상한"); near(pl.riskAmt, 9.9, "실제 위험 금액");
  const pl2 = Core.sizePlan(1000, 1000, 100, 2, { stopAtr: 2 }, { positionPct: 0.33, sizing: "risk", riskPct: 0.02, autoLev: true, maxLev: 5 }, 1, []);
  near(pl2.lev, 2, "필요한 만큼만 (500 ÷ 330 → 2배)"); near(pl2.amount * pl2.lev, 500, "포지션 500");
  // 시뮬레이션: 거래마다 위험 대비 배수(R) 기록, 켈리를 켜도 자산이 정상
  const c = (() => { let sd = 99; const r = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648;
    const x = { ts: [], open: [], high: [], low: [], close: [], volume: [] }; let px = 100;
    for (let i = 0; i < 6000; i++) { const o = px; px *= Math.exp(0.012 * (r() + r() + r() - 1.5) * 1.15);
      x.ts.push(i * 36e5); x.open.push(o); x.close.push(px); x.high.push(Math.max(o, px) * (1 + r() * 0.004)); x.low.push(Math.min(o, px) * (1 - r() * 0.004)); x.volume.push(1); }
    return x; })();
  const s = Core.byId("pullback"), p0 = { ...Core.defaults(s), stopAtr: 2, kelly: 1 };
  const r = Core.simulate(c, s, p0, { ...O, market: "futures", feeRate: 0.0005, slippageBps: 3, dir: "both", sizing: "risk", riskPct: 0.01, autoLev: true, maxLev: 3 });
  assert(r.trades.length > 10 && r.trades.every(t => Number.isFinite(t.rmult)), "R 배수 기록");
  assert(r.trades.every(t => t.lev >= 1 && t.lev <= 3), "레버리지 상한");
  assert(r.equity.every(v => Number.isFinite(v) && v >= 0));
}

// (선택) 파이썬 결과와 비교
if (process.argv[2]) {
  const fx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  fx.candles.volume = fx.candles.close.map(() => 1);
  const out = Core.simulate(fx.candles, v1, Core.defaults(v1), O);
  console.log(JSON.stringify({ trades: out.stats.trades, ret: out.stats.totalReturn }));
} else {
  console.log(`web core tests passed (${Core.STRATEGIES.length} strategies, ${Core.STRATEGIES.reduce((s, x) => s + Core.grid(x).length, 0)} combos, ${anyTrades} trades)`);
}
