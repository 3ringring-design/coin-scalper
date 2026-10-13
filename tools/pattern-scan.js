// 1분봉 여러 개를 한 묶음으로 보고 다음 방향 예측 → 처음 보는 기간에서 적중률·수익(비용 차감) 측정
// A. 캔들 모양 패턴표 (직전 N개 봉 → 모양 코드)  B. 비슷한 과거 찾기 (k-최근접)  C. 로지스틱 회귀 (직전 10개 봉 특징)
// 데이터: 바이낸스 선물 1분봉 12개월, BTC/ETH/SOL · 앞 8개월 학습 / 뒤 4개월 검증
const fs = require("fs"), os = require("os"), path = require("path"), { execSync } = require("child_process");
const MONTHS = +process.argv[2] || 12, SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"], HZ = [1, 5, 15];
const COST = { maker: 4e-4, mixed: 8.5e-4, taker: 13e-4 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "p"));
const bp = v => (v >= 0 ? "+" : "") + (v * 1e4).toFixed(1) + "bp";
const pc = v => (v * 100).toFixed(1) + "%";

function months(n) { const out = [], d = new Date(); for (let k = n; k >= 1; k--) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1))); return out; }
const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
function loadKlines(sym) {
  const cols = { ts: [], open: [], high: [], low: [], close: [], vol: [], tb: [] };
  if (process.env.MOCK) { let a = sym.length * 99991 >>> 0; const r = () => { a ^= a << 13; a >>>= 0; a ^= a >>> 17; a ^= a << 5; a >>>= 0; return a / 4294967296; }; let px = 100;
    for (let i = 0; i < MONTHS * 30 * 1440; i++) { const o = px; let h = o, l = o; for (let k = 0; k < 3; k++) { px *= Math.exp(0.0005 * (r() - 0.5) * 3.4); h = Math.max(h, px); l = Math.min(l, px); }
      cols.ts.push(Date.UTC(2025, 0, 1) + i * 6e4); cols.open.push(o); cols.high.push(h); cols.low.push(l); cols.close.push(px); const v = 1 + r(); cols.vol.push(v); cols.tb.push(v * r()); } }
  else for (const m of months(MONTHS)) {
    const f = path.join(TMP, `${sym}-${ym(m)}.zip`);
    try { execSync(`curl -sf --retry 3 -o ${f} https://data.binance.vision/data/futures/um/monthly/klines/${sym}/1m/${sym}-1m-${ym(m)}.zip`); } catch { continue; }
    const csv = execSync(`unzip -p ${f}`, { maxBuffer: 1 << 30 }).toString(); fs.unlinkSync(f);
    for (const line of csv.split("\n")) { const r = line.split(","); const t = +r[0]; if (!Number.isFinite(t) || r.length < 10) continue;
      cols.ts.push(t); cols.open.push(+r[1]); cols.high.push(+r[2]); cols.low.push(+r[3]); cols.close.push(+r[4]); cols.vol.push(+r[5]); cols.tb.push(+r[9]); }
  }
  const c = {}; for (const k in cols) c[k] = Float64Array.from(cols[k]); return c;
}

// 봉 하나의 모양 (ATR로 나눠 코인·시기와 상관없이 비교)
function prep(c) {
  const n = c.ts.length, atr = new Float64Array(n).fill(NaN); let a = 0;
  for (let i = 1; i < n; i++) { const tr = Math.max(c.high[i] - c.low[i], Math.abs(c.high[i] - c.close[i - 1]), Math.abs(c.low[i] - c.close[i - 1])); a = i < 14 ? a + tr / 14 : a + (tr - a) / 14; if (i >= 14) atr[i] = a; }
  const vavg = new Float64Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += c.vol[i]; if (i >= 60) s -= c.vol[i - 60]; if (i >= 59) vavg[i] = s / 60; }
  const body = new Float64Array(n), up = new Float64Array(n), lo = new Float64Array(n), vr = new Float64Array(n), fl = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const A = atr[i - 1] || atr[i]; const o = c.open[i], cl = c.close[i];
    body[i] = (cl - o) / A; up[i] = (c.high[i] - Math.max(o, cl)) / A; lo[i] = (Math.min(o, cl) - c.low[i]) / A;
    vr[i] = Math.log((c.vol[i] + 1e-12) / (vavg[i] || c.vol[i] || 1)); fl[i] = c.vol[i] > 0 ? c.tb[i] / c.vol[i] - 0.5 : 0;
  }
  const fwd = {}; for (const h of HZ) { const f = new Float64Array(n).fill(NaN); for (let i = 0; i + h < n; i++) f[i] = c.close[i + h] / c.open[i + 1] - 1; fwd[h] = f; }
  return { n, atr, body, up, lo, vr, fl, fwd, ts: c.ts };
}

// 비용 차감 수익 요약: dir(+1/−1) 신호대로 들어갔을 때
function summarize(list) {   // list: [{r, dir, mon}]
  if (!list.length) return null;
  let s = 0, hit = 0; const mo = {};
  for (const x of list) { const g = x.dir * x.r; s += g; if (g > 0) hit++; mo[x.mon] = (mo[x.mon] || 0) + g; }
  const m = s / list.length, moV = Object.values(mo);
  return { n: list.length, gross: m, hit: hit / list.length, moPos: moV.filter(v => v > 0).length, moN: moV.length };
}
const line = (label, z) => z ? `${label.padEnd(44)} 신호 ${String(z.n).padStart(7)}개 · 방향 적중 ${pc(z.hit)} · 거래당 ${bp(z.gross).padStart(8)} → 비용 뺀 뒤 지정가 ${bp(z.gross - COST.maker)} / 혼합 ${bp(z.gross - COST.mixed)} / 시장가 ${bp(z.gross - COST.taker)} · 월별 + ${z.moPos}/${z.moN}` : `${label.padEnd(44)} 신호 없음`;

(async () => {
  const t0 = Date.now(), D = [];
  for (const sym of SYMS) {
    const c = loadKlines(sym); if (!c.ts.length) continue;
    const P = prep(c), cutT = c.ts[0] + (c.ts[c.ts.length - 1] - c.ts[0]) * (8 / 12);
    let k = 0; while (k < P.n && P.ts[k] < cutT) k++;
    P.split = k; P.sym = sym; P.mon = Int32Array.from(P.ts, t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); });
    D.push(P);
    console.log(`${sym}: ${P.n.toLocaleString()}개 1분봉 (${new Date(P.ts[0]).toISOString().slice(0, 10)} ~ ${new Date(P.ts[P.n - 1]).toISOString().slice(0, 10)}), 검증 시작 ${new Date(P.ts[k]).toISOString().slice(0, 10)} · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  }
  console.log(`\n비용(왕복): 지정가만 4bp · 시장가 진입+지정가 익절 8.5bp · 시장가만 13bp (1bp = 0.01%) · '방향 적중'은 50%가 동전 던지기\n`);
  for (const h of HZ) {
    let up = 0, tot = 0; for (const P of D) for (let i = P.split; i < P.n; i++) { const r = P.fwd[h][i]; if (Number.isFinite(r)) { tot++; if (r > 0) up++; } }
    console.log(`(참고) 검증 기간 ${h}분 뒤 오른 비율 ${pc(up / tot)}`);
  }

  // ---------- A. 캔들 모양 패턴표 ----------
  // 봉 하나 = 4종류 (강한 음봉 < −0.5 ATR ≤ 약한 음봉 < 0 ≤ 약한 양봉 < 0.5 ATR ≤ 강한 양봉) × 거래량 많음/보통 = 8종류
  console.log("\n== A. 캔들 모양 패턴표 (직전 N개 봉의 모양 조합 → 학습 기간에 한쪽으로 뚜렷했던 패턴만 검증 기간에 매매) ==");
  const sym1 = (P, i, withVol) => { const b = P.body[i], k = b < -0.5 ? 0 : b < 0 ? 1 : b < 0.5 ? 2 : 3; return withVol ? k * 2 + (P.vr[i] > 0.7 ? 1 : 0) : k; };
  for (const [N, withVol] of [[3, false], [4, false], [5, false], [6, false], [3, true], [4, true]]) for (const h of HZ) {
    const base = withVol ? 8 : 4, code = (P, i) => { let c = 0; for (let j = i - N + 1; j <= i; j++) c = c * base + sym1(P, j, withVol); return c; };
    const st = new Map();
    for (const P of D) for (let i = 300; i < P.split; i++) { const r = P.fwd[h][i]; if (!Number.isFinite(r)) continue; const k = code(P, i); let e = st.get(k); if (!e) st.set(k, e = { s: 0, q: 0, n: 0 }); e.s += r; e.q += r * r; e.n++; }
    const pick = new Map();
    for (const [k, e] of st) { if (e.n < 300) continue; const m = e.s / e.n, sd = Math.sqrt(Math.max(1e-18, e.q / e.n - m * m)), t = m / (sd / Math.sqrt(e.n / h)); if (Math.abs(t) > 3 && Math.abs(m) > 2e-4) pick.set(k, Math.sign(m)); }
    const list = [];
    for (const P of D) for (let i = P.split; i < P.n; i++) { const r = P.fwd[h][i]; if (!Number.isFinite(r)) continue; const d = pick.get(code(P, i)); if (d) list.push({ r, dir: d, mon: P.mon[i] }); }
    console.log(line(`봉 ${N}개${withVol ? " +거래량" : ""} → ${h}분 뒤 (뚜렷한 패턴 ${pick.size}/${st.size}개)`, summarize(list)));
  }

  // 공통 특징 벡터: 직전 L개 봉의 몸통·윗꼬리·아랫꼬리·거래량·체결쏠림
  const vec = (P, i, L) => { const v = []; for (let j = i - L + 1; j <= i; j++) v.push(P.body[j], P.up[j], P.lo[j], P.vr[j] * 0.5, P.fl[j] * 4); return v; };
  const clean = v => v.every(Number.isFinite);

  // ---------- B. 비슷한 과거 찾기 ----------
  console.log("\n== B. 비슷한 과거 찾기 (지금 직전 5개 봉과 가장 비슷한 과거 100장면의 평균으로 예측 · 확신 큰 10%만 매매) ==");
  {
    const L = 5, rnd = (() => { let a = 12345; return () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296; })();
    const TR = [], TE = [];
    for (const P of D) {
      for (let k = 0; k < 25000; k++) { const i = 300 + Math.floor(rnd() * (P.split - 400)); const v = vec(P, i, L); if (clean(v)) TR.push({ v, f: HZ.map(h => P.fwd[h][i]) }); }
      for (let k = 0; k < 2000; k++) { const i = P.split + Math.floor(rnd() * (P.n - P.split - 20)); const v = vec(P, i, L); if (clean(v)) TE.push({ v, f: HZ.map(h => P.fwd[h][i]), mon: P.mon[i] }); }
    }
    const K = 100, dim = TR[0].v.length, X = new Float64Array(TR.length * dim); TR.forEach((x, k) => x.v.forEach((v, j) => X[k * dim + j] = v));
    const preds = TE.map(q => {
      const best = new Float64Array(K).fill(Infinity), bi = new Int32Array(K).fill(-1);
      for (let k = 0; k < TR.length; k++) { let d = 0; const o = k * dim; for (let j = 0; j < dim; j++) { const z = X[o + j] - q.v[j]; d += z * z; if (d > best[K - 1]) break; }
        if (d < best[K - 1]) { let p = K - 1; while (p > 0 && best[p - 1] > d) { best[p] = best[p - 1]; bi[p] = bi[p - 1]; p--; } best[p] = d; bi[p] = k; } }
      return HZ.map((_, hk) => { let s = 0, c = 0; for (const k of bi) if (k >= 0 && Number.isFinite(TR[k].f[hk])) { s += TR[k].f[hk]; c++; } return s / c; });
    });
    HZ.forEach((h, hk) => {
      const sc = preds.map(p => p[hk]), sorted = sc.slice().sort((a, b) => a - b), lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.9)];
      const all = TE.map((q, k) => ({ r: q.f[hk], dir: Math.sign(sc[k]) || 1, mon: q.mon })).filter(x => Number.isFinite(x.r));
      const conf = TE.map((q, k) => ({ r: q.f[hk], dir: sc[k] >= hi ? 1 : sc[k] <= lo ? -1 : 0, mon: q.mon })).filter(x => x.dir && Number.isFinite(x.r));
      console.log(line(`${h}분 뒤 · 모든 장면`, summarize(all)));
      console.log(line(`${h}분 뒤 · 확신 큰 10%`, summarize(conf)));
    });
    console.log(`(학습 장면 ${TR.length.toLocaleString()}개 · 검증 장면 ${TE.length.toLocaleString()}개 · ${((Date.now() - t0) / 1000).toFixed(0)}초)`);
  }

  // ---------- C. 로지스틱 회귀 ----------
  console.log("\n== C. 통계 예측 모델 (직전 10개 봉 50개 특징 → 오를 확률 · 확신 큰 1%/5%/10%만 매매) ==");
  for (const h of HZ) {
    const L = 10, dim = L * 5 + 1;
    const rows = [];
    for (const P of D) for (let i = 300; i < P.split; i += 3) { const v = vec(P, i, L), r = P.fwd[h][i]; if (clean(v) && Number.isFinite(r) && r !== 0) rows.push({ v, y: r > 0 ? 1 : 0 }); }
    const w = new Float64Array(dim); let lr = 0.02;
    for (let ep = 0; ep < 3; ep++, lr *= 0.5) for (let k = 0; k < rows.length; k++) {
      const x = rows[(k * 7919) % rows.length]; let z = w[dim - 1]; for (let j = 0; j < dim - 1; j++) z += w[j] * x.v[j];
      const p = 1 / (1 + Math.exp(-z)), g = p - x.y; for (let j = 0; j < dim - 1; j++) w[j] -= lr * (g * x.v[j] + 1e-5 * w[j]); w[dim - 1] -= lr * g;
    }
    const prob = v => { let z = w[dim - 1]; for (let j = 0; j < dim - 1; j++) z += w[j] * v[j]; return 1 / (1 + Math.exp(-z)); };
    const trP = rows.filter((_, k) => k % 5 === 0).map(x => prob(x.v)).sort((a, b) => a - b);
    const te = []; for (const P of D) for (let i = P.split; i < P.n; i++) { const v = vec(P, i, L), r = P.fwd[h][i]; if (clean(v) && Number.isFinite(r)) te.push({ p: prob(v), r, mon: P.mon[i] }); }
    console.log(line(`${h}분 뒤 · 모든 봉 (확률 50% 기준)`, summarize(te.map(x => ({ r: x.r, dir: x.p >= 0.5 ? 1 : -1, mon: x.mon })))));
    for (const q of [0.10, 0.05, 0.01]) {
      const lo = trP[Math.floor(trP.length * q)], hi = trP[Math.floor(trP.length * (1 - q))];
      console.log(line(`${h}분 뒤 · 확신 큰 ${q * 100}%씩 (양쪽)`, summarize(te.filter(x => x.p >= hi || x.p <= lo).map(x => ({ r: x.r, dir: x.p >= hi ? 1 : -1, mon: x.mon })))));
    }
  }
  console.log(`\n총 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
})();
