// 1분봉 스캘핑 연구: 바이낸스 선물 1분봉 · 한 계좌 · 롤링 검증(학습 60일 → 검증 30일)
// node tools/scalp-research.js [개월=15]
const fs = require("fs"), os = require("os"), path = require("path"), { execSync } = require("child_process");
const Scalp = require("../web/scalp.js");
const MONTHS = +process.argv[2] || 15, SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"], DAY = 864e5;
const COST = { takerFee: 0.0005, makerFee: 0.0002, slip: 0.00015, through: 0.0001 };
const BASE = { startingCash: 1000, riskPct: 0.005, maxLev: 20, cooldown: 1, ...COST };
const pct = (v, d = 1) => !Number.isFinite(v) ? "-" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const day = t => new Date(t).toISOString().slice(0, 10);

function monthsBack(n) {
  const out = [], d = new Date(); d.setUTCDate(1);
  for (let k = n; k >= 1; k--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)); out.push(`${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`); }
  return out;
}
function load(sym) {
  if (process.env.MOCK) {                 // 로컬 점검용 가짜 데이터
    let sd = sym.length * 7919, px = 100; const r = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648, n = MONTHS * 30 * 1440;
    const c = { ts: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n), takerBuy: new Float64Array(n) };
    const st = Date.UTC(2025, 0, 1);
    for (let i = 0; i < n; i++) { const o = px; px *= Math.exp(0.0009 * (r() + r() + r() - 1.5)); c.ts[i] = st + i * 6e4; c.open[i] = o; c.close[i] = px; c.high[i] = Math.max(o, px) * (1 + r() * 3e-4); c.low[i] = Math.min(o, px) * (1 - r() * 3e-4); c.volume[i] = 1 + r(); c.takerBuy[i] = c.volume[i] * r(); }
    return c;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k")), cols = { ts: [], open: [], high: [], low: [], close: [], volume: [], takerBuy: [] };
  for (const m of monthsBack(MONTHS)) {
    const f = path.join(tmp, `${sym}-${m}.zip`);
    execSync(`curl -sf --retry 3 -o ${f} https://data.binance.vision/data/futures/um/monthly/klines/${sym}/1m/${sym}-1m-${m}.zip`);
    const csv = execSync(`unzip -p ${f}`, { maxBuffer: 1 << 30 }).toString();
    for (const line of csv.split("\n")) {
      const r = line.split(","); const t = +r[0]; if (!Number.isFinite(t) || r.length < 10) continue;
      cols.ts.push(t); cols.open.push(+r[1]); cols.high.push(+r[2]); cols.low.push(+r[3]); cols.close.push(+r[4]); cols.volume.push(+r[5]); cols.takerBuy.push(+r[9]);
    }
  }
  const c = {}; for (const k in cols) c[k] = Float64Array.from(cols[k]);
  return c;
}

const t0 = Date.now();
const sets = SYMS.map(sym => ({ sym, F: Scalp.features(load(sym)) }));
const idx = Scalp.align(sets), T = sets[0].F.c.ts;
console.log(`바이낸스 선물 1분봉 ${day(T[0])} ~ ${day(T[T.length - 1])} (${(T.length / 1440).toFixed(0)}일) · ${SYMS.join("/")} 한 계좌 · 데이터 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
console.log(`비용: 시장가 0.05% + 슬리피지 1.5bp, 지정가 0.02% (가격이 1bp 이상 뚫어야 체결) · 거래당 위험 ${BASE.riskPct * 100}% · 레버리지 최대 ${BASE.maxLev}배`);
for (const s of sets) { const c = s.F.c, ret = c.close[c.close.length - 1] / c.close[0] - 1; console.log(`  ${s.sym} 그냥 보유 ${pct(ret)}`); }

// 롤링 구간
const at = ms => { let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < ms) lo = m + 1; else hi = m; } return lo; };
const folds = []; for (let a = T[0] + 2 * DAY; ; a += 30 * DAY) { const b = a + 60 * DAY, e = b + 30 * DAY; if (e > T[T.length - 1] + DAY) break; folds.push({ a: at(a), b: at(b), e: at(e) }); }
console.log(`롤링 검증 ${folds.length}구간 (학습 60일 → 검증 30일)\n`);

function walk(id, opt, grid) {
  const G = grid || Scalp.gridOf(id), res = [];
  for (const f of folds) {
    let best = null;
    for (const p of G) {
      const r = Scalp.simulate(sets, idx, id, p, { ...opt, from: f.a, to: f.b });
      const sc = r.trades >= 30 ? r.ret : r.ret - 1;
      if (!best || sc > best.sc) best = { p, sc, r };
    }
    const te = Scalp.simulate(sets, idx, id, best.p, { ...opt, from: f.b, to: f.e, curve: true, trades: true });
    res.push({ f, p: best.p, train: best.r, test: te });
  }
  let cum = 1, pk = 1, mdd = 0, n = 0, g = 0, w = 0, fee = 0, mk = 0;
  for (const x of res) {
    const c0 = x.test.curve; for (const v of c0) { const e = cum * v / opt.startingCash; pk = Math.max(pk, e); mdd = Math.min(mdd, e / pk - 1); }
    cum *= 1 + x.test.ret; n += x.test.trades; g += x.test.edge * x.test.trades; w += x.test.win * x.test.trades; fee += x.test.fees; mk += x.test.makerShare * x.test.trades;
  }
  const days = (T[folds[folds.length - 1].e - 1] - T[folds[0].b]) / DAY;
  return { res, ret: cum - 1, cagr: Math.pow(Math.max(cum, 1e-9), 365 / days) - 1, mdd, n, edge: n ? g / n : 0, win: n ? w / n : 0, pos: res.filter(x => x.test.ret > 0).length, fee, maker: n ? mk / n : 0, perDay: n / days };
}
const show = (label, W) => console.log(`${label.padEnd(30)} 검증 누적 ${pct(W.ret).padStart(8)} (연 ${pct(W.cagr)}) 낙폭 ${pct(W.mdd)} | +구간 ${W.pos}/${W.res.length} [${W.res.map(x => pct(x.test.ret, 0)).join(" ")}] | ${W.n}회 (하루 ${W.perDay.toFixed(1)}) 승률 ${Math.round(W.win * 100)}% 거래당 가격이득 ${pct(W.edge, 3)} 지정가 비율 ${Math.round(W.maker * 100)}%`);

const best = {};
for (const id of (process.env.ONLY || Object.keys(Scalp.STRATS).join(",")).split(",")) {
  const s = Scalp.STRATS[id];
  console.log(`== ${s.name} (${Scalp.gridOf(id).length}개 조합) ==`);
  const W = walk(id, BASE); show("실제 비용", W); best[id] = W;
  console.log(`   최근 구간 설정: ${JSON.stringify(Object.fromEntries(Object.entries(W.res[W.res.length - 1].p).filter(([k]) => k in s.grid)))}`);
  show("  (진단) 비용 0", walk(id, { ...BASE, takerFee: 0, makerFee: 0, slip: 0 }));
  show("  (진단) 지정가 수수료 0", walk(id, { ...BASE, makerFee: 0 }));
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(0)}초)\n`);
}

const top = Object.entries(best).sort((a, b) => b[1].ret - a[1].ret)[0];
console.log(`== 위험·레버리지 (최고: ${Scalp.STRATS[top[0]].name}, 구간마다 고른 설정 그대로) ==`);
for (const [r, lev, dd] of [[0.0025, 20, 0], [0.005, 20, 0], [0.01, 20, 0], [0.02, 20, 0], [0.01, 50, 0], [0.01, 20, 0.1], [0.02, 20, 0.1], [0.02, 50, 0.1]]) {
  const o = { ...BASE, riskPct: r, maxLev: lev, ddCut: dd || undefined };
  let cum = 1, pk = 1, mdd = 0, n = 0, levMax = 0;
  for (const x of top[1].res) {
    const te = Scalp.simulate(sets, idx, top[0], x.p, { ...o, from: x.f.b, to: x.f.e, curve: true, trades: true });
    for (const v of te.curve) { const e = cum * v / o.startingCash; pk = Math.max(pk, e); mdd = Math.min(mdd, e / pk - 1); }
    cum *= 1 + te.ret; n += te.trades; for (const t of te.list) levMax = Math.max(levMax, t.lev);
  }
  console.log(`위험 ${r * 100}% · 최대 ${lev}배${dd ? " · 낙폭 브레이크" : ""}`.padEnd(30) + ` 누적 ${pct(cum - 1)} 낙폭 ${pct(mdd)} · ${n}회 · 실제 최대 레버리지 ${levMax.toFixed(1)}배`);
}
console.log(`\n총 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
