// 1분 우위 전수 조사: "이 신호가 나온 직후 N분 동안 가격이 비용보다 크게 한쪽으로 움직였나?"
// 데이터: 바이낸스 선물 1분봉(체결 건수·테이커 매수 포함) + 5분 단위 시장 지표(미결제약정, 상위 트레이더 롱숏, 테이커 롱숏)
// 앞 8개월로 구간(10분위) 기준을 정하고, 뒤 4개월(처음 보는 기간)에서 각 구간의 이후 수익률을 잼
// node tools/edge-scan.js [개월=12]
const fs = require("fs"), os = require("os"), path = require("path"), { execSync } = require("child_process");
const MONTHS = +process.argv[2] || 12, SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"], HZ = [5, 15, 30, 60];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "e"));
const bp = v => (v * 1e4).toFixed(1);

function months(n) { const out = [], d = new Date(); for (let k = n; k >= 1; k--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)); out.push(x); } return out; }
const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
function readZip(url) { const f = path.join(TMP, path.basename(url)); try { execSync(`curl -sf --retry 3 -o ${f} ${url}`); return execSync(`unzip -p ${f}`, { maxBuffer: 1 << 30 }).toString(); } catch { return null; } finally { try { fs.unlinkSync(f); } catch {} } }

function loadKlines(sym) {
  if (process.env.MOCK) { let a = sym.length * 99991 >>> 0; const r = () => { a ^= a << 13; a >>>= 0; a ^= a >>> 17; a ^= a << 5; a >>>= 0; return a / 4294967296; };
    const n = MONTHS * 30 * 1440, c = { ts: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), vol: new Float64Array(n), qv: new Float64Array(n), cnt: new Float64Array(n), tb: new Float64Array(n) }; let px = 100;
    for (let i = 0; i < n; i++) { const o = px; px *= Math.exp(0.0007 * (r() - 0.5) * 3.4); c.ts[i] = Date.UTC(2025, 0, 1) + i * 6e4; c.open[i] = o; c.close[i] = px; c.high[i] = Math.max(o, px) * 1.0003; c.low[i] = Math.min(o, px) * 0.9997; c.vol[i] = 1 + r(); c.qv[i] = c.vol[i] * px; c.cnt[i] = 10 + 10 * r(); c.tb[i] = c.vol[i] * r(); }
    return c; }
  const cols = { ts: [], open: [], high: [], low: [], close: [], vol: [], qv: [], cnt: [], tb: [] };
  for (const m of months(MONTHS)) {
    const csv = readZip(`https://data.binance.vision/data/futures/um/monthly/klines/${sym}/1m/${sym}-1m-${ym(m)}.zip`); if (!csv) continue;
    for (const line of csv.split("\n")) { const r = line.split(","); const t = +r[0]; if (!Number.isFinite(t) || r.length < 10) continue;
      cols.ts.push(t); cols.open.push(+r[1]); cols.high.push(+r[2]); cols.low.push(+r[3]); cols.close.push(+r[4]); cols.vol.push(+r[5]); cols.qv.push(+r[7]); cols.cnt.push(+r[8]); cols.tb.push(+r[9]); }
  }
  const c = {}; for (const k in cols) c[k] = Float64Array.from(cols[k]); return c;
}
// 일별 metrics zip을 병렬로 받음
function loadMetrics(sym) {
  if (process.env.MOCK) { const n = MONTHS * 30 * 288, ts = new Float64Array(n), oi = new Float64Array(n), top = new Float64Array(n), acct = new Float64Array(n), taker = new Float64Array(n); let v = 1e9;
    for (let i = 0; i < n; i++) { ts[i] = Date.UTC(2025, 0, 1) + i * 3e5; v *= 1 + (Math.random() - 0.5) * 0.004; oi[i] = v; top[i] = 1 + Math.random(); acct[i] = 1 + Math.random(); taker[i] = 0.5 + Math.random(); }
    return { header: ["mock"], ts, oi, top, acct, taker }; }
  const days = []; const end = new Date(); end.setUTCDate(1);
  for (let d = new Date(months(MONTHS)[0]); d < end; d = new Date(d.getTime() + 864e5)) days.push(d.toISOString().slice(0, 10));
  const dir = path.join(TMP, "m_" + sym); fs.mkdirSync(dir, { recursive: true });
  const list = path.join(dir, "urls.txt");
  fs.writeFileSync(list, days.map(d => `https://data.binance.vision/data/futures/um/daily/metrics/${sym}/${sym}-metrics-${d}.zip`).join("\n"));
  try { execSync(`cd ${dir} && xargs -P 16 -n 1 curl -sf --retry 2 -O < urls.txt`, { stdio: "ignore", timeout: 900000 }); } catch {}
  const rows = []; let header = null;
  for (const d of days) {
    const f = path.join(dir, `${sym}-metrics-${d}.zip`); if (!fs.existsSync(f)) continue;
    const csv = execSync(`unzip -p ${f}`).toString(); fs.unlinkSync(f);
    for (const line of csv.trim().split("\n")) {
      const r = line.split(",");
      if (!header && isNaN(Date.parse(r[0]))) { header = r; continue; }
      if (isNaN(Date.parse(r[0]))) continue;
      rows.push(r);
    }
  }
  if (!rows.length) return null;
  const H = header || ["create_time", "symbol", "sum_open_interest", "sum_open_interest_value", "count_toptrader_long_short_ratio", "sum_toptrader_long_short_ratio", "count_long_short_ratio", "sum_taker_long_short_vol_ratio"];
  const col = k => H.indexOf(k);
  const ts = rows.map(r => Date.parse(r[0].replace(" ", "T") + "Z"));
  const ord = ts.map((_, k) => k).sort((a, b) => ts[a] - ts[b]);
  const get = k => Float64Array.from(ord.map(j => +rows[j][col(k)]));
  return { header: H, ts: Float64Array.from(ord.map(j => ts[j])), oi: get("sum_open_interest_value"), top: get("sum_toptrader_long_short_ratio"),
           acct: get("count_long_short_ratio"), taker: get("sum_taker_long_short_vol_ratio") };
}

// ---------- 특징 (i번째 1분봉이 끝난 시점에 알 수 있는 것만) ----------
function features(c, m) {
  const n = c.ts.length, F = {};
  const ret = k => { const r = new Float64Array(n).fill(NaN); for (let i = k; i < n; i++) r[i] = c.close[i] / c.close[i - k] - 1; return r; };
  const rmean = (x, k) => { const o = new Float64Array(n).fill(NaN); let s = 0, cnt = 0; for (let i = 0; i < n; i++) { if (Number.isFinite(x[i])) { s += x[i]; cnt++; } if (i >= k && Number.isFinite(x[i - k])) { s -= x[i - k]; cnt--; } if (i >= k - 1 && cnt > k * 0.8) o[i] = s / cnt; } return o; };
  const r1 = ret(1), sd = (() => { const sq = r1.map(v => v * v), m2 = rmean(sq, 240); return m2.map(Math.sqrt); })();
  F.ret1z = r1.map((v, i) => v / sd[i]);
  F.ret5z = ret(5).map((v, i) => v / (sd[i] * Math.sqrt(5)));
  F.ret15z = ret(15).map((v, i) => v / (sd[i] * Math.sqrt(15)));
  F.ret60z = ret(60).map((v, i) => v / (sd[i] * Math.sqrt(60)));
  const va = rmean(c.vol, 60); F.volx = c.vol.map((v, i) => v / va[i]);
  const tb5 = rmean(c.tb, 5), v5 = rmean(c.vol, 5); F.flow5 = tb5.map((v, i) => v / v5[i] - 0.5);
  const tb60 = rmean(c.tb, 60), v60 = rmean(c.vol, 60); F.flow60 = tb60.map((v, i) => v / v60[i] - 0.5);
  const size = c.qv.map((q, i) => c.cnt[i] > 0 ? q / c.cnt[i] : NaN), sa = rmean(size, 240); F.tradeSize = size.map((v, i) => v / sa[i]);
  const hi60 = new Float64Array(n).fill(NaN), lo60 = new Float64Array(n).fill(NaN);
  for (let i = 60; i < n; i++) { let h = -Infinity, l = Infinity; for (let j = i - 59; j <= i; j++) { if (c.high[j] > h) h = c.high[j]; if (c.low[j] < l) l = c.low[j]; } hi60[i] = h; lo60[i] = l; }
  F.pos60 = c.close.map((v, i) => (v - lo60[i]) / (hi60[i] - lo60[i]) - 0.5);
  const hour = new Float64Array(n); for (let i = 0; i < n; i++) hour[i] = new Date(c.ts[i]).getUTCHours();
  F.hourUTC = hour;
  if (m) {
    // 5분 지표는 한 칸 늦게 반영 (발표 시점이 확실하지 않으니 보수적으로)
    const at = new Int32Array(n).fill(-1); let j = 0;
    // at[i] = 봉 마감 5분 전까지 발표된 마지막 지표 행
    for (let i = 0; i < n; i++) { const t = c.ts[i] + 6e4 - 5 * 6e4; while (j + 1 < m.ts.length && m.ts[j + 1] <= t) j++; at[i] = m.ts[j] <= t ? j : -1; }
    const mf = (arr, lag) => Float64Array.from(at, (k, i) => k - lag >= 0 && k >= 0 ? arr[k] / arr[k - lag] - 1 : NaN);
    F.oi5 = mf(m.oi, 1); F.oi15 = mf(m.oi, 3); F.oi60 = mf(m.oi, 12);
    F.topLS = Float64Array.from(at, k => k >= 0 ? m.top[k] : NaN); F.topLSchg60 = mf(m.top, 12);
    F.acctLS = Float64Array.from(at, k => k >= 0 ? m.acct[k] : NaN);
    F.takerLS = Float64Array.from(at, k => k >= 0 ? m.taker[k] : NaN);
    // 조합: 가격 15분 변화 × 미결제약정 15분 변화 (둘 다 하락 = 롱 청산 쏟아짐)
    F.flush15 = Float64Array.from({ length: n }, (_, i) => Number.isFinite(F.ret15z[i]) && Number.isFinite(F.oi15[i]) ? Math.sign(F.ret15z[i]) * Math.min(Math.abs(F.ret15z[i]), 6) * (F.oi15[i] < 0 ? -F.oi15[i] * 100 : 0) : NaN);
    F.build15 = Float64Array.from({ length: n }, (_, i) => Number.isFinite(F.ret15z[i]) && Number.isFinite(F.oi15[i]) ? Math.sign(F.ret15z[i]) * Math.min(Math.abs(F.ret15z[i]), 6) * (F.oi15[i] > 0 ? F.oi15[i] * 100 : 0) : NaN);
  }
  // 이후 수익률: 다음 봉 시가에 들어가서 h분 뒤 종가
  const fwd = {}; for (const h of HZ) { const f = new Float64Array(n).fill(NaN); for (let i = 0; i + h < n; i++) f[i] = c.close[i + h] / c.open[i + 1] - 1; fwd[h] = f; }
  return { F, fwd };
}

// ---------- 10분위 분석 ----------
function decileScan(all, split) {
  const out = [];
  const names = Object.keys(all[0].F);
  for (const name of names) {
    // 학습 기간 값으로 10분위 경계
    const tr = []; for (const s of all) { const x = s.F[name]; for (let i = 0; i < split[s.sym]; i += 7) if (Number.isFinite(x[i])) tr.push(x[i]); }
    if (tr.length < 1000) continue;
    tr.sort((a, b) => a - b);
    const cut = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => tr[Math.floor(tr.length * k / 10)]);
    if (new Set(cut).size < 5) continue;              // 값이 거의 안 변하는 특징은 건너뜀
    const bucket = v => { let b = 0; while (b < 9 && v >= cut[b]) b++; return b; };
    for (const h of HZ) {
      const acc = { train: Array.from({ length: 10 }, () => ({ s: 0, q: 0, n: 0 })), test: Array.from({ length: 10 }, () => ({ s: 0, q: 0, n: 0, mo: {} })) };
      for (const s of all) {
        const x = s.F[name], f = s.fwd[h], T = s.ts;
        for (let i = 300; i < x.length; i += 1) {
          const v = x[i], r = f[i]; if (!Number.isFinite(v) || !Number.isFinite(r)) continue;
          const b = bucket(v), A = i < split[s.sym] ? acc.train[b] : acc.test[b];
          A.s += r; A.q += r * r; A.n++;
          if (A.mo) { const mk = s.mon[i]; A.mo[mk] = (A.mo[mk] || 0) + r; }
        }
      }
      const st = a => { const m = a.s / a.n, sdv = Math.sqrt(Math.max(0, a.q / a.n - m * m)); return { m, t: m / (sdv / Math.sqrt(a.n / h)), n: a.n }; };   // 겹치는 표본 → n/h로 보정
      for (const b of [0, 9]) {
        const a = st(acc.train[b]), z = st(acc.test[b]), base = st(acc.test.reduce((x, y) => ({ s: x.s + y.s, q: x.q + y.q, n: x.n + y.n }), { s: 0, q: 0, n: 0 }));
        const mo = acc.test[b].mo, moPos = Object.values(mo).filter(v => Math.sign(v) === Math.sign(a.m)).length, moN = Object.keys(mo).length;
        out.push({ name, h, b: b ? "상위 10%" : "하위 10%", train: a, test: z, edge: z.m - base.m, base: base.m, sameSign: Math.sign(a.m) === Math.sign(z.m), moPos, moN, cut: b ? cut[8] : cut[0] });
      }
    }
  }
  return out;
}

(async () => {
  const t0 = Date.now(), all = [], split = {};
  for (const sym of SYMS) {
    const c = loadKlines(sym), m = loadMetrics(sym);
    if (sym === SYMS[0] && m) console.log(`지표 파일 열: ${m.header.join(", ")} · ${m.ts.length}행`);
    if (!c.ts.length) { console.log(`${sym} 1분봉 없음`); continue; }
    const { F, fwd } = features(c, m);
    const cutT = c.ts[0] + (c.ts[c.ts.length - 1] - c.ts[0]) * (8 / 12);
    let k = 0; while (k < c.ts.length && c.ts[k] < cutT) k++;
    const mon = new Int32Array(c.ts.length); for (let i = 0; i < c.ts.length; i++) { const d = new Date(c.ts[i]); mon[i] = d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    split[sym] = k; all.push({ sym, F, fwd, ts: c.ts, mon });
    console.log(`${sym}: 1분봉 ${c.ts.length.toLocaleString()} (${new Date(c.ts[0]).toISOString().slice(0, 10)} ~ ${new Date(c.ts[c.ts.length - 1]).toISOString().slice(0, 10)}) · 지표 ${m ? m.ts.length : 0}행 · 검증 시작 ${new Date(c.ts[k]).toISOString().slice(0, 10)} · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  }
  const res = decileScan(all, split);
  console.log(`\n비용 기준 (왕복): 지정가만 4bp · 시장가 진입+지정가 익절 약 8.5bp · 시장가만 13bp   (1bp = 0.01%)`);
  console.log(`표 읽는 법: 그 신호가 나온 다음 봉에 '이긴 방향'으로 들어갔다면 h분 뒤 평균 몇 bp 벌었나. 학습(앞 8개월)과 검증(뒤 4개월) 부호가 같고, 검증에서도 비용보다 커야 의미 있음\n`);
  const rows = res.filter(r => r.sameSign).map(r => ({ ...r, gain: Math.abs(r.test.m) })).sort((a, b) => b.gain - a.gain);
  console.log("== 검증 기간에서 가장 크게 움직인 신호 상위 40 (학습과 같은 방향인 것만) ==");
  for (const r of rows.slice(0, 40)) console.log(`${(r.name + " " + r.b).padEnd(22)} ${String(r.h).padStart(2)}분 | 학습 ${bp(r.train.m).padStart(6)}bp (t ${r.train.t.toFixed(1)}) → 검증 ${bp(r.test.m).padStart(6)}bp (t ${r.test.t.toFixed(1)}, ${r.test.n.toLocaleString()}개) | 평소 ${bp(r.base)}bp | 검증 월별 같은 방향 ${r.moPos}/${r.moN} | 기준값 ${r.cut.toPrecision(3)}`);
  const pass = rows.filter(r => r.gain > 13e-4 && Math.abs(r.test.t) > 2 && r.moPos >= r.moN - 1);
  const pass2 = rows.filter(r => r.gain > 8.5e-4 && Math.abs(r.test.t) > 2 && r.moPos >= r.moN - 1);
  console.log(`\n시장가 왕복(13bp)을 넘고 검증에서도 꾸준한 신호: ${pass.length}개 · 지정가 익절 기준(8.5bp) 넘는 신호: ${pass2.length}개`);
  for (const r of pass2) console.log(`  ✓ ${r.name} ${r.b} ${r.h}분: 검증 ${bp(r.test.m)}bp, 월별 ${r.moPos}/${r.moN}`);
  console.log(`\n총 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
})();
