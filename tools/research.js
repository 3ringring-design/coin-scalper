// 위험 부담 · 불타기/물타기 · 변동성 조절 · 동시 위험 한도 · 낙폭 브레이크 탐색 (6년, 실제 계좌 재현)
// 앞 3년 / 뒤 3년 둘 다에서 좋은 세팅을 찾음 (한쪽에서만 좋으면 우연일 가능성)
const Core = require("../web/core.js");
const DAYS = +process.argv[2] || 2190;
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const OPT = { startingCash: 1000, market: "futures", feeRate: 0.0005, makerFee: 0.0002, slippageBps: 3, fundingRate: 0.0001, dir: "both",
              leverage: 1, cooldownBars: 3, minOrder: 10, positionPct: 0.5, sizing: "risk", riskPct: 0.01, autoLev: true, maxLev: 3 };
const CH = { chN: 20, adxMin: 20, stopAtr: 2.5, trailAtr: 8, regime: 1, runner: 1, scaleIn: 1, scaleOut: 1 };
const PB = { bbStd: 2.5, rsiEntry: 38, stopAtr: 4, takeAtr: 6, bias: 1, scaleIn: 1, scaleOut: 1 };

async function get(path) {
  let err;
  for (const h of HOSTS) for (let t = 0; t < 3; t++) {
    try { const r = await fetch(h + path); if (r.ok) return r.json(); err = new Error(`${h} ${r.status}`); if (r.status < 500 && r.status !== 429) break; } catch (e) { err = e; }
    await new Promise(r => setTimeout(r, 1000 * (t + 1)));
  }
  throw err;
}
async function history(sym, days) {
  const tf = 36e5, now = Date.now(); let start = now - days * 864e5; const rows = [];
  while (start < now) { const b = await get(`/api/v3/klines?symbol=${sym}&interval=1h&limit=1000&startTime=${start}`); if (!b.length) break; rows.push(...b); start = b[b.length - 1][0] + tf; if (b.length < 1000) break; }
  if (rows.length && rows[rows.length - 1][0] + tf > now) rows.pop();
  const c = { ts: [], open: [], high: [], low: [], close: [], volume: [], takerBuy: [] };
  for (const r of rows) { c.ts.push(r[0]); c.open.push(+r[1]); c.high.push(+r[2]); c.low.push(+r[3]); c.close.push(+r[4]); c.volume.push(+r[5]); c.takerBuy.push(+r[9]); }
  return c;
}
const pct = (v, d = 1) => !Number.isFinite(v) ? "-" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const day = t => new Date(t).toISOString().slice(0, 10);

(async () => {
  const sets = [];
  for (const sym of SYMS) { const c = await history(sym, DAYS), cm = Core.mirror(c); sets.push({ sym, c, I: Core.makeI(c), cm, Im: Core.makeI(cm) }); }
  const ts = sets[0].c.ts, mid = ts[0] + (ts[ts.length - 1] - ts[0]) / 2;
  const run = (slots, o = {}) => {
    const sl = slots.map(x => { const s = Core.byId(x.id); return { name: x.id, s, p: { ...Core.defaults(s), ...x.p }, dir: x.dir, share: x.share ?? 1 / slots.length }; });
    return Core.simulatePortfolio(sets, sl, { ...OPT, maxPositions: sl.length * sets.length, ...o });
  };
  const evalR = r => {
    const k = r.ts.findIndex(t => t >= mid), all = Core.spanStats(r.equity, r.ts), h1 = Core.spanStats(r.equity, r.ts, 0, k + 1), h2 = Core.spanStats(r.equity, r.ts, k);
    const w = Core.randomWindows(r.equity, r.ts, 90, 400, 7), m = Core.randomWindows(r.equity, r.ts, 30, 400, 9);
    return { all, h1, h2, w, m, n: r.trades.length, liq: r.stats.liquidations, minHalf: Math.min(h1.cagr, h2.cagr) };
  };
  const fmt = (label, e) => `${label.padEnd(44)} 연 ${pct(e.all.cagr).padStart(7)} 낙폭 ${pct(e.all.mdd).padStart(7)} | 앞3년 ${pct(e.h1.cagr).padStart(7)} 뒤3년 ${pct(e.h2.cagr).padStart(7)} | 90일 +${Math.round(e.w.pos * 100)}% 하위10% ${pct(e.w.p10)} 최악 ${pct(e.w.worst)} | 30일 최악 ${pct(e.m.worst)} | ${e.n}회${e.liq ? ` 청산${e.liq}` : ""}`;

  console.log(`기간 ${day(ts[0])} ~ ${day(ts[ts.length - 1])} · 앞/뒤 경계 ${day(mid)} · BTC/ETH/SOL 한 계좌 · 선물 시장가\n`);

  // 1) 급락 원인 진단: v5 (채널 롱, 1%)의 큰 낙폭 구간
  console.log("== 1. 급락 구간 진단 (v5: 채널 돌파 롱 · 위험 1%) ==");
  const v5 = run([{ id: "donchian", p: CH, dir: "long" }]);
  const eq = v5.equity, eps = []; let pk = 0;
  for (let i = 1; i < eq.length; i++) {
    if (eq[i] >= eq[pk]) { pk = i; continue; }
    let lo = i, rec = i;
    while (rec < eq.length && eq[rec] < eq[pk]) { if (eq[rec] < eq[lo]) lo = rec; rec++; }
    eps.push({ a: pk, b: lo, c: rec, d: eq[lo] / eq[pk] - 1 });
    if (rec >= eq.length) break;
    pk = rec; i = rec;
  }
  eps.sort((x, y) => x.d - y.d);
  for (const e of eps.slice(0, 6)) {
    const t0 = v5.ts[e.a], t1 = v5.ts[e.b], tr = v5.trades.filter(t => t.exitTime > t0 && t.exitTime <= t1);
    const loss = tr.filter(t => t.pnl < 0), big = tr.filter(t => t.rmult < -1.3);
    const bars = e.b - e.a, conc = (() => { let mx = 0; for (const t of tr) { const k = tr.filter(u => u.entryTime <= t.entryTime && u.exitTime > t.entryTime).length; mx = Math.max(mx, k); } return mx; })();
    console.log(`${day(t0)} → ${day(t1)} (${(bars / 24).toFixed(0)}일) ${pct(e.d)} · 회복 ${e.c < eq.length ? (((e.c - e.b) / 24).toFixed(0) + "일") : "아직"} · 거래 ${tr.length} 손실 ${loss.length} · 손절보다 크게 잃은 거래 ${big.length} · 최대 동시 보유 ${conc} · 평균 R ${(tr.reduce((a, t) => a + (t.rmult || 0), 0) / Math.max(1, tr.length)).toFixed(2)}`);
  }
  const rs = v5.trades.map(t => t.rmult).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`전체 거래 R 분포: 최악 ${rs[0].toFixed(2)} · 하위5% ${rs[Math.floor(rs.length * 0.05)].toFixed(2)} · 중간 ${rs[Math.floor(rs.length / 2)].toFixed(2)} · 상위5% ${rs[Math.floor(rs.length * 0.95)].toFixed(2)} · 최고 ${rs[rs.length - 1].toFixed(2)} · 승률 ${Math.round(rs.filter(x => x > 0).length / rs.length * 100)}%`);

  // 2) 불타기 / 물타기
  console.log("\n== 2. 불타기 · 물타기 (위험 1%) ==");
  const pyr = [
    ["분할 끔", { scaleIn: 0, scaleOut: 0 }], ["분할매도만", { scaleIn: 0 }], ["v5 (2차 진입 50%, 1ATR)", {}],
    ["불타기 +50% 추가", { siBoost: 0.5 }], ["불타기 +100% 추가", { siBoost: 1 }], ["불타기 +100% · 2ATR 확인", { siBoost: 1, siAtr: 2 }],
    ["불타기 +100% · 0.5ATR 확인", { siBoost: 1, siAtr: 0.5 }], ["1차 33% → 2ATR에서 나머지", { siFrac: 0.33, siAtr: 2 }],
  ];
  const pyrRes = [];
  for (const dir of ["long", "both"]) for (const [n, ov] of pyr) {
    const e = evalR(run([{ id: "donchian", p: { ...CH, ...ov }, dir }])); pyrRes.push({ n: `채널 ${dir === "long" ? "롱" : "롱+숏"} · ${n}`, ov, dir, e }); console.log(fmt(`채널 ${dir === "long" ? "롱" : "롱+숏"} · ${n}`, e));
  }
  for (const [n, ov] of [["물타기 끔", { scaleIn: 0 }], ["물타기 (v4)", {}], ["물타기 1차 33%", { siFrac: 0.33 }]])
    console.log(fmt(`눌림목 롱+숏 · ${n}`, evalR(run([{ id: "pullback", p: { ...PB, ...ov }, dir: "both" }]))));

  // 3) 위험 부담 × 계좌 위험 조절
  const bestP = pyrRes.slice().sort((a, b) => b.e.minHalf - a.e.minHalf)[0];
  console.log(`\n== 3. 위험 부담 × 위험 조절 (기준: ${bestP.n}) — 앞·뒤 3년 중 나쁜 쪽 기준 정렬 ==`);
  const rows = [];
  for (const dir of ["long", "both"]) for (const risk of [0.01, 0.015, 0.02, 0.03, 0.04]) for (const heat of [0, 0.02, 0.03, 0.045]) for (const vt of [0, 1]) for (const dd of [0, 0.15]) {
    if (heat && heat < risk) continue;
    const o = { riskPct: risk, heatMax: heat || undefined, volTarget: !!vt, ddCut: dd || undefined, maxLev: risk >= 0.03 ? 5 : 3 };
    const label = `${dir === "long" ? "롱" : "롱+숏"} 위험${risk * 100}%${heat ? ` 동시한도${heat * 100}%` : ""}${vt ? " 변동성조절" : ""}${dd ? " 낙폭브레이크" : ""}`;
    rows.push({ label, e: evalR(run([{ id: "donchian", p: { ...CH, ...bestP.ov }, dir }], o)) });
  }
  rows.sort((a, b) => b.e.minHalf - a.e.minHalf);
  for (const r of rows.slice(0, 25)) console.log(fmt(r.label, r.e));
  console.log("\n-- 낙폭 30% 이내 중 상위 --");
  for (const r of rows.filter(r => r.e.all.mdd > -0.3).slice(0, 12)) console.log(fmt(r.label, r.e));
  console.log("\n-- 낙폭 20% 이내 중 상위 --");
  for (const r of rows.filter(r => r.e.all.mdd > -0.2).slice(0, 8)) console.log(fmt(r.label, r.e));
  console.log("\n-- 위험만 키운 경우 (조절 없음) --");
  for (const r of rows.filter(r => !/동시|변동|브레이크/.test(r.label))) console.log(fmt(r.label, r.e));
})().catch(e => { console.error(e); process.exit(1); });
