// 견고성 테스트: 지금 실행 중인 추천 포트폴리오를 '실제 계좌 그대로' 여러 해 · 무작위 기간 · 여러 종목에서 돌려봄
// 사용: node tools/stress.js [일수=1460]  (GitHub Actions에서 돌고 결과는 stress-result 브랜치에 기록)
const Core = require("../web/core.js");

const DAYS = +process.argv[2] || 1460;
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com", "https://api2.binance.com"];
const BASE = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const OTHERS = ["BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "LTCUSDT", "TRXUSDT", "DOTUSDT"];

// 추천 세팅 v4 (index.html PRESET과 같게 유지)
const SLOTS = [
  { name: "채널 돌파", strategyId: "donchian", dir: "both", weight: 60, params: { chN: 20, adxMin: 20, stopAtr: 2.5, trailAtr: 8, regime: 1, runner: 1, scaleIn: 1, scaleOut: 1 } },
  { name: "눌림목", strategyId: "pullback", dir: "both", weight: 40, params: { bbStd: 2.5, rsiEntry: 38, stopAtr: 4, takeAtr: 6, bias: 1, scaleIn: 1, scaleOut: 1 } },
];
const OPT = { startingCash: 1000, market: "futures", feeRate: 0.0005, makerFee: 0.0002, slippageBps: 3, fundingRate: 0.0001, dir: "both",
              leverage: 1, cooldownBars: 3, minOrder: 10, positionPct: 0.5, sizing: "risk", riskPct: 0.02, autoLev: true, maxLev: 3 };

async function get(path) {
  let err;
  for (const h of HOSTS) {
    for (let t = 0; t < 3; t++) {
      try { const r = await fetch(h + path); if (r.ok) return r.json(); err = new Error(`${h} ${r.status}`); if (r.status < 500 && r.status !== 429) break; }
      catch (e) { err = e; }
      await new Promise(r => setTimeout(r, 1000 * (t + 1)));
    }
  }
  throw err;
}
async function history(sym, days) {
  const tf = 36e5, now = Date.now(); let start = now - days * 864e5;
  const rows = [];
  while (start < now) {
    const b = await get(`/api/v3/klines?symbol=${sym}&interval=1h&limit=1000&startTime=${start}`);
    if (!b.length) break;
    rows.push(...b); start = b[b.length - 1][0] + tf;
    if (b.length < 1000) break;
  }
  if (rows.length && rows[rows.length - 1][0] + tf > now) rows.pop();
  const c = { ts: [], open: [], high: [], low: [], close: [], volume: [], takerBuy: [] };
  for (const r of rows) { c.ts.push(r[0]); c.open.push(+r[1]); c.high.push(+r[2]); c.low.push(+r[3]); c.close.push(+r[4]); c.volume.push(+r[5]); c.takerBuy.push(+r[9]); }
  return c;
}
const pct = (v, d = 1) => (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const day = t => new Date(t).toISOString().slice(0, 10);
const slotsOf = (list, only) => {
  const use = only ? list.filter(s => s.strategyId === only) : list, tot = use.reduce((a, s) => a + s.weight, 0);
  return use.map(s => { const st = Core.byId(s.strategyId); return { name: s.name, s: st, p: { ...Core.defaults(st), ...s.params }, dir: s.dir, share: s.weight / tot }; });
};

(async () => {
  const data = {};
  for (const sym of [...BASE, ...OTHERS]) {
    try { const c = await history(sym, DAYS); if (c.ts.length > 24 * 200) data[sym] = { sym, c, I: Core.makeI(c), cm: Core.mirror(c) }; }
    catch (e) { console.log(`! ${sym} 데이터 실패: ${e.message}`); }
  }
  for (const d of Object.values(data)) d.Im = Core.makeI(d.cm);
  if (!BASE.every(s => data[s])) { console.log("기본 종목 데이터를 못 받았어요"); process.exit(1); }
  const master = data.BTCUSDT.c, oneYearAgo = Date.now() - 365 * 864e5;
  const run = (syms, opt = {}, only) => {
    const sets = [syms.includes("BTCUSDT") ? data.BTCUSDT : data[syms[0]], ...syms.filter(s => s !== (syms.includes("BTCUSDT") ? "BTCUSDT" : syms[0])).map(s => data[s])];
    const sl = slotsOf(SLOTS, only);
    return Core.simulatePortfolio(sets, sl, { ...OPT, maxPositions: sl.length * syms.length, ...opt });
  };
  const split = r => {
    const k = r.ts.findIndex(t => t >= oneYearAgo);
    return { all: Core.spanStats(r.equity, r.ts), before: k > 1 ? Core.spanStats(r.equity, r.ts, 0, k + 1) : null, recent: Core.spanStats(r.equity, r.ts, Math.max(0, k)) };
  };
  const line = (label, r) => {
    const s = split(r), w = Core.randomWindows(r.equity, r.ts, 90, 400, 7);
    const ratio = s.all.mdd < 0 ? s.all.cagr / -s.all.mdd : Infinity;
    return `${label.padEnd(26)} 연 ${pct(s.all.cagr)} 낙폭 ${pct(s.all.mdd)} 연수익÷낙폭 ${ratio.toFixed(2)} | 처음 보는 기간 연 ${s.before ? pct(s.before.cagr) : "-"} / 최근1년 ${pct(s.recent.ret)} | 90일 무작위: + ${Math.round(w.pos * 100)}% · 중간 ${pct(w.median)} · 하위10% ${pct(w.p10)} · 최악 ${pct(w.worst)} | 거래 ${r.trades.length}${r.stats.liquidations ? ` 청산 ${r.stats.liquidations}` : ""}`;
  };

  console.log(`기간 ${day(master.ts[0])} ~ ${day(master.ts[master.ts.length - 1])} (${(master.ts.length / 24 / 365).toFixed(1)}년), 1시간봉, 선물 시장가 0.05%+3bp, 펀딩 0.01%/8h`);
  console.log(`설정은 최근 1년 데이터로 골랐음 → '처음 보는 기간' = 그 이전 구간 (진짜 검증)`);
  console.log(`BTC 그냥 보유: ${pct(master.close[master.close.length - 1] / master.close[0] - 1)}\n`);

  console.log("== A. 지금 세팅 그대로 (BTC/ETH/SOL, 위험 2%, 자동 레버리지 ≤3배) ==");
  const base = run(BASE);
  console.log(line("추천 포트폴리오", base));
  console.log("연도별: " + Core.yearly(base.equity, base.ts).map(y => `${y.year} ${pct(y.ret)} (낙폭 ${pct(y.mdd)})`).join(" · "));
  for (const d of [30, 90, 180, 365]) {
    const w = Core.randomWindows(base.equity, base.ts, d, 400, 11);
    if (w) console.log(`무작위 ${d}일 × 400번: 플러스 ${Math.round(w.pos * 100)}% · 중간값 ${pct(w.median)} · 하위10% ${pct(w.p10)} · 최악 ${pct(w.worst)} · 최고 ${pct(w.best)} · 낙폭 중간 ${pct(w.mddMedian)} 최악 ${pct(w.mddWorst)}`);
  }
  const bySlot = {}; for (const t of base.trades) { const k = t.slotName; bySlot[k] = bySlot[k] || { n: 0, pnl: 0, L: 0, S: 0 }; bySlot[k].n++; bySlot[k].pnl += t.pnl; bySlot[k][t.dir > 0 ? "L" : "S"] += t.pnl; }
  console.log("전략별 손익: " + Object.entries(bySlot).map(([k, v]) => `${k} ${v.n}회 ${v.pnl.toFixed(0)} (롱 ${v.L.toFixed(0)} / 숏 ${v.S.toFixed(0)})`).join(" · "));

  console.log("\n== B. 전략 하나만 vs 묶음 (위험 2%) ==");
  console.log(line("채널 돌파만", run(BASE, {}, "donchian")));
  console.log(line("눌림목만", run(BASE, {}, "pullback")));
  console.log(line("묶음 60/40", base));

  console.log("\n== C. 거래당 위험 % (원금 손실 감수 ↔ 수익) ==");
  for (const r of [0.005, 0.01, 0.02, 0.03, 0.04, 0.06]) console.log(line(`위험 ${r * 100}%`, run(BASE, { riskPct: r, maxLev: r > 0.03 ? 5 : 3 })));

  console.log("\n== D. 비용 민감도 ==");
  console.log(line("슬리피지 6bp", run(BASE, { slippageBps: 6 })));
  console.log(line("수수료 0.04% (BNB 할인)", run(BASE, { feeRate: 0.0004 })));

  console.log("\n== E. 처음 보는 코인 (각각 따로, 설정은 BTC/ETH/SOL로 고른 것) ==");
  for (const s of [...BASE, ...OTHERS]) if (data[s]) console.log(line(s, run([s])));

  console.log("\n== F. 종목 늘린 계좌 ==");
  const many = [...BASE, ...OTHERS].filter(s => data[s]);
  console.log(line(`${many.length}종목 위험 1%`, run(many, { riskPct: 0.01 })));

  console.log("\n== G. 후보 세팅 (전부 같은 기간 · 연도별) ==");
  const cand = (label, syms, opt, only, slotOv) => {
    const save = SLOTS.map(s => ({ ...s, params: { ...s.params } }));
    if (slotOv) SLOTS.forEach(s => slotOv(s));
    const r = run(syms, opt, only);
    SLOTS.splice(0, SLOTS.length, ...save);
    console.log(line(label, r));
    console.log("    연도별: " + Core.yearly(r.equity, r.ts).map(y => `${y.year} ${pct(y.ret)}(${pct(y.mdd, 0)})`).join(" · "));
    const L = r.trades.filter(t => t.dir > 0).reduce((a, t) => a + t.pnl, 0), S = r.trades.filter(t => t.dir < 0).reduce((a, t) => a + t.pnl, 0);
    console.log(`    롱 손익 ${L.toFixed(0)} / 숏 손익 ${S.toFixed(0)} (시작 1000)`);
  };
  const BE = ["BTCUSDT", "ETHUSDT"];
  cand("지금 세팅 · 위험 1%", BASE, { riskPct: 0.01 });
  cand("채널만 · 위험 1%", BASE, { riskPct: 0.01 }, "donchian");
  cand("채널만 · BTC/ETH · 1%", BE, { riskPct: 0.01 }, "donchian");
  cand("채널만 · 롱만 · 1%", BASE, { riskPct: 0.01 }, "donchian", s => { s.dir = "long"; });
  cand("채널만 · 숏만 · 1%", BASE, { riskPct: 0.01 }, "donchian", s => { s.dir = "short"; });
  cand("묶음 · BTC/ETH · 1%", BE, { riskPct: 0.01 });
  cand("묶음 · 눌림목 롱만 · 1%", BASE, { riskPct: 0.01 }, null, s => { if (s.strategyId === "pullback") s.dir = "long"; });
})().catch(e => { console.error(e); process.exit(1); });
