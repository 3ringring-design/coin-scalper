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

  if (process.argv[3] === "final") {
    const CH0 = { ...CH, scaleIn: 0, scaleOut: 0 }, BR = { volTarget: true, ddCut: 0.1, ddMult: 0.5, ddCut2: 0.2, ddMult2: 0.5 };
    console.log(`최종 후보 검증 · ${day(ts[0])} ~ ${day(ts[ts.length - 1])} · 채널 돌파 롱 · 분할 끔 · 변동성 조절 · 2단 낙폭 브레이크(10%→½, 20%→¼)\n`);
    const prof = [["v5 (비교)", { ...CH }, { riskPct: 0.01 }], ["안정 1.5%", CH0, { ...BR, riskPct: 0.015 }], ["균형 2%", CH0, { ...BR, riskPct: 0.02 }],
                  ["공격 3%", CH0, { ...BR, riskPct: 0.03, maxLev: 5 }], ["공격 3% · 레버리지 최대 3배", CH0, { ...BR, riskPct: 0.03, maxLev: 3 }], ["매우 공격 4%", CH0, { ...BR, riskPct: 0.04, maxLev: 5 }]];
    for (const [n, p, o] of prof) for (const slip of [3, 6]) {
      const r = run([{ id: "donchian", p, dir: "long" }], { ...o, slippageBps: slip }), e = evalR(r);
      console.log(fmt(`${n}${slip === 6 ? " · 슬리피지 2배" : ""}`, e));
      if (slip === 3) {
        console.log("    연도별: " + Core.yearly(r.equity, r.ts).map(y => `${y.year} ${pct(y.ret)}(${pct(y.mdd, 0)})`).join(" · "));
        console.log("    무작위: " + [30, 90, 180, 365].map(d => { const w = Core.randomWindows(r.equity, r.ts, d, 400, 11); return `${d}일 +${Math.round(w.pos * 100)}% 중간 ${pct(w.median)} 최악 ${pct(w.worst)}`; }).join(" · "));
        const lv = r.trades.map(t => t.lev); console.log(`    레버리지 평균 ${(lv.reduce((a, b) => a + b, 0) / lv.length).toFixed(2)} 최대 ${Math.max(...lv)} · 청산 ${r.stats.liquidations}`);
      }
    }
    return;
  }
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

  // 3) 위험 부담 × 낙폭 브레이크 × 불타기 × 변동성 조절 → 낙폭 한도별 최고 수익
  console.log("\n== 3. 낙폭 한도별 최고 세팅 (앞·뒤 3년 둘 다 +인 것만) ==");
  const BRAKES = [["", {}], ["브레이크10%×½", { ddCut: 0.1, ddMult: 0.5 }], ["브레이크15%×½", { ddCut: 0.15, ddMult: 0.5 }], ["브레이크20%×½", { ddCut: 0.2, ddMult: 0.5 }],
    ["브레이크10%×¼", { ddCut: 0.1, ddMult: 0.25 }], ["2단 10%×½·20%×½", { ddCut: 0.1, ddMult: 0.5, ddCut2: 0.2, ddMult2: 0.5 }], ["2단 15%×½·25%×½", { ddCut: 0.15, ddMult: 0.5, ddCut2: 0.25, ddMult2: 0.5 }]];
  const PYR = [["분할 v5", {}], ["불타기+100%", { siBoost: 1 }], ["분할 끔", { scaleIn: 0, scaleOut: 0 }]];
  const rows = [];
  for (const [pn, pov] of PYR) for (const risk of [0.01, 0.015, 0.02, 0.03, 0.04]) for (const [bn, bo] of BRAKES) for (const vt of [0, 1]) {
    const o = { riskPct: risk, volTarget: !!vt, maxLev: risk >= 0.03 ? 5 : 3, ...bo };
    rows.push({ label: `롱 ${pn} 위험${risk * 100}% ${bn}${vt ? " 변동성조절" : ""}`, risk, e: evalR(run([{ id: "donchian", p: { ...CH, ...pov }, dir: "long" }], o)) });
  }
  const good = rows.filter(r => r.e.h1.cagr > 0 && r.e.h2.cagr > 0);
  for (const lim of [0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6]) {
    const top = good.filter(r => r.e.all.mdd > -lim).sort((a, b) => b.e.all.cagr - a.e.all.cagr).slice(0, 3);
    console.log(`\n-- 최대 낙폭 ${lim * 100}% 이내 --`);
    for (const r of top) console.log(fmt(r.label, r.e));
  }
  console.log("\n-- 브레이크 효과 (분할 v5, 변동성조절 없음) --");
  for (const r of rows.filter(r => r.label.startsWith("롱 분할 v5") && !r.label.includes("변동성"))) console.log(fmt(r.label, r.e));
})().catch(e => { console.error(e); process.exit(1); });
