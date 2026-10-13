// Coin Scalper 계산 엔진: 지표 · 전략 · 청산 · 모의 브로커 · 백테스트
// 브라우저(window.Core)와 node(require) 양쪽에서 사용.
(function (root) {
  "use strict";
  const NaNs = n => new Array(n).fill(NaN);
  const ok = v => typeof v === "number" && !Number.isNaN(v);

  // ---------------- 지표 ----------------
  function ema(x, n) {
    const a = 2 / (n + 1), out = new Array(x.length);
    let prev;
    for (let i = 0; i < x.length; i++) { prev = i === 0 ? x[0] : a * x[i] + (1 - a) * prev; out[i] = prev; }
    return out;
  }
  // Wilder 이동평균 (앞쪽 NaN은 건너뜀)
  function rma(x, n) {
    const out = NaNs(x.length);
    let prev = NaN;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (Number.isNaN(v)) { out[i] = prev; continue; }
      prev = Number.isNaN(prev) ? v : prev + (v - prev) / n;
      out[i] = prev;
    }
    return out;
  }
  function rsi(c, n) {
    const out = NaNs(c.length);
    let ag = 0, al = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
      if (i === 1) { ag = g; al = l; } else { ag += (g - ag) / n; al += (l - al) / n; }
      out[i] = al === 0 ? (ag === 0 ? NaN : 100) : 100 - 100 / (1 + ag / al);
    }
    return out;
  }
  function sma(x, n) {
    const out = NaNs(x.length);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0, bad = false;
      for (let j = i - n + 1; j <= i; j++) { if (Number.isNaN(x[j])) { bad = true; break; } s += x[j]; }
      if (!bad) out[i] = s / n;
    }
    return out;
  }
  function bollinger(c, n, k) {
    const mid = NaNs(c.length), up = mid.slice(), low = mid.slice(), width = mid.slice();
    for (let i = n - 1; i < c.length; i++) {
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j];
      const m = s / n; let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (c[j] - m) ** 2;
      const sd = Math.sqrt(v / n);
      mid[i] = m; up[i] = m + k * sd; low[i] = m - k * sd; width[i] = (2 * k * sd) / m;
    }
    return { mid, up, low, width };
  }
  // 직전 n개(lag=1이면 현재 봉 제외) 최댓값/최솟값
  function rollMax(x, n, lag = 0) {
    const out = NaNs(x.length);
    for (let i = n - 1 + lag; i < x.length; i++) {
      let m = -Infinity, bad = false;
      for (let j = i - lag - n + 1; j <= i - lag; j++) { const v = x[j]; if (Number.isNaN(v)) { bad = true; break; } if (v > m) m = v; }
      if (!bad) out[i] = m;
    }
    return out;
  }
  function rollMin(x, n, lag = 0) {
    const out = NaNs(x.length);
    for (let i = n - 1 + lag; i < x.length; i++) {
      let m = Infinity, bad = false;
      for (let j = i - lag - n + 1; j <= i - lag; j++) { const v = x[j]; if (Number.isNaN(v)) { bad = true; break; } if (v < m) m = v; }
      if (!bad) out[i] = m;
    }
    return out;
  }
  function trueRange(c) {
    return c.close.map((_, i) => i === 0 ? c.high[0] - c.low[0]
      : Math.max(c.high[i] - c.low[i], Math.abs(c.high[i] - c.close[i - 1]), Math.abs(c.low[i] - c.close[i - 1])));
  }
  const atr = (c, n) => rma(trueRange(c), n);
  function macd(close, f, s, g) {
    const ef = ema(close, f), es = ema(close, s), line = ef.map((v, i) => v - es[i]), signal = ema(line, g);
    return { line, signal, hist: line.map((v, i) => v - signal[i]) };
  }
  function stochRsi(close, rn, sn, kn, dn) {
    const r = rsi(close, rn), lo = rollMin(r, sn), hi = rollMax(r, sn);
    const st = r.map((v, i) => ok(lo[i]) && ok(v) ? (hi[i] > lo[i] ? (v - lo[i]) / (hi[i] - lo[i]) * 100 : 50) : NaN);
    const k = sma(st, kn);
    return { k, d: sma(k, dn) };
  }
  function adx(c, n) {
    const len = c.close.length, pdm = NaNs(len), mdm = NaNs(len);
    for (let i = 1; i < len; i++) {
      const up = c.high[i] - c.high[i - 1], dn = c.low[i - 1] - c.low[i];
      pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0;
    }
    const tr = trueRange(c); tr[0] = NaN;
    const a = rma(tr, n), sp = rma(pdm, n), sm = rma(mdm, n);
    const pdi = sp.map((v, i) => 100 * v / a[i]), mdi = sm.map((v, i) => 100 * v / a[i]);
    const dx = pdi.map((v, i) => ok(v) && ok(mdi[i]) ? (v + mdi[i] > 0 ? 100 * Math.abs(v - mdi[i]) / (v + mdi[i]) : 0) : NaN);
    return { adx: rma(dx, n), pdi, mdi };
  }
  function vwap(c, n) {
    const out = NaNs(c.close.length);
    let pv = 0, vv = 0;
    for (let i = 0; i < c.close.length; i++) {
      const tp = (c.high[i] + c.low[i] + c.close[i]) / 3;
      pv += tp * c.volume[i]; vv += c.volume[i];
      if (i >= n) { const j = i - n, tpj = (c.high[j] + c.low[j] + c.close[j]) / 3; pv -= tpj * c.volume[j]; vv -= c.volume[j]; }
      if (i >= n - 1) out[i] = vv > 0 ? pv / vv : c.close[i];
    }
    return out;
  }

  const DAY = 864e5, HOUR = 36e5;
  const tfOf = c => c.ts.length > 1 ? c.ts[1] - c.ts[0] : HOUR;
  // 카우프만 효율비율: |N봉 순변화| / N봉 움직임 합. 1에 가까울수록 한 방향 추세, 0에 가까울수록 횡보
  function effRatio(x, n) {
    const out = NaNs(x.length);
    let path = 0;
    for (let i = 1; i < x.length; i++) {
      path += Math.abs(x[i] - x[i - 1]);
      if (i > n) path -= Math.abs(x[i - n] - x[i - n - 1]);
      if (i >= n) out[i] = path > 0 ? Math.abs(x[i] - x[i - n]) / path : 0;
    }
    return out;
  }
  // UTC 하루(= 한국 오전 9시 기준) 단위 정보: 오늘 시가, 전날 변동폭, 최근 5일 종가 평균 (모두 과거만 사용)
  function dayInfo(c) {
    const n = c.ts.length, dayOpen = NaNs(n), prevRange = NaNs(n), ma5 = NaNs(n), days = [];
    let cur = null, o, h, l, cl;
    for (let i = 0; i < n; i++) {
      const d = Math.floor(c.ts[i] / DAY);
      if (d !== cur) { if (cur !== null) days.push({ h, l, cl }); cur = d; o = c.open[i]; h = c.high[i]; l = c.low[i]; }
      dayOpen[i] = o;
      const pv = days[days.length - 1];
      if (pv) prevRange[i] = pv.h - pv.l;
      if (days.length >= 5) { let s = 0; for (let k = days.length - 5; k < days.length; k++) s += days[k].cl; ma5[i] = s / 5; }
      h = Math.max(h, c.high[i]); l = Math.min(l, c.low[i]); cl = c.close[i];
    }
    return { dayOpen, prevRange, ma5 };
  }
  // 최근 lookDays일 동안 시간대(UTC)별 1시간 평균 수익률 → 다음 holdH시간 예상 수익 (정각에 끝나는 봉에만 값)
  function seasonForecast(c, lookDays, holdH) {
    const n = c.ts.length, tf = tfOf(c), f = NaNs(n);
    if (tf > HOUR) return f;
    const bph = Math.round(HOUR / tf), sums = new Array(24).fill(0), cnts = new Array(24).fill(0), q = [];
    for (let i = 0; i < n; i++) {
      const end = c.ts[i] + tf;
      if (end % HOUR !== 0 || i < bph) continue;
      const h = ((end - HOUR) % DAY) / HOUR, r = c.close[i] / c.close[i - bph] - 1;
      q.push({ h, r, t: end }); sums[h] += r; cnts[h]++;
      while (q.length && q[0].t <= end - lookDays * DAY) { const x = q.shift(); sums[x.h] -= x.r; cnts[x.h]--; }
      const next = (end % DAY) / HOUR;
      let s = 0, good = true;
      for (let k = 0; k < holdH; k++) { const hh = (next + k) % 24; if (cnts[hh] < lookDays * 0.6) { good = false; break; } s += sums[hh] / cnts[hh]; }
      if (good) f[i] = s;
    }
    return f;
  }

  // 같은 데이터에서 지표를 한 번만 계산하도록 캐시
  function makeI(c) {
    const m = new Map();
    const get = (k, fn) => { if (!m.has(k)) m.set(k, fn()); return m.get(k); };
    return {
      ema: n => get("ema" + n, () => ema(c.close, n)),
      rsi: n => get("rsi" + n, () => rsi(c.close, n)),
      bb: (n, k) => get(`bb${n},${k}`, () => bollinger(c.close, n, k)),
      atr: n => get("atr" + n, () => atr(c, n)),
      volSma: n => get("vs" + n, () => sma(c.volume, n)),
      hh: n => get("hh" + n, () => rollMax(c.high, n, 1)),
      ll: n => get("ll" + n, () => rollMin(c.low, n, 1)),
      macd: (f, s, g) => get(`macd${f},${s},${g}`, () => macd(c.close, f, s, g)),
      stoch: (r, s, k, d) => get(`st${r},${s},${k},${d}`, () => stochRsi(c.close, r, s, k, d)),
      adx: n => get("adx" + n, () => adx(c, n)),
      vwap: n => get("vwap" + n, () => vwap(c, n)),
      rollMinOf: (key, arr, n) => get(`rmin${key},${n}`, () => rollMin(arr, n)),
      er: n => get("er" + n, () => effRatio(c.close, n)),
      memo: (k, fn) => get("m:" + k, fn),
      tbr: () => get("tbr", () => c.close.map((_, i) => c.takerBuy && c.volume[i] > 0 ? c.takerBuy[i] / c.volume[i] : NaN)),
      clv: () => get("clv", () => c.close.map((v, i) => c.high[i] > c.low[i] ? (v - c.low[i]) / (c.high[i] - c.low[i]) : 0.5)),
      day: () => get("day", () => dayInfo(c)),
      season: (L, H) => get(`season${L},${H}`, () => seasonForecast(c, L, H)),
    };
  }

  // ---------------- 전략 ----------------
  // 모든 전략은 롱(현물) 전용. 신호는 '마감된' 봉 기준, 진입은 다음 봉 시가(실시간은 현재가).
  // 청산 공통 파라미터: stopAtr/takeAtr/trailAtr(ATR 배수) 또는 stopPct/takePct, maxHold(봉), minExitPct(신호 청산 최소 수익)
  const X = (k, label, def, grid) => ({ k, label, def, grid });
  const exitParams = ({ stop = [2], take = [0], trail = [0], hold = 48, min = 0.005 } = {}) => [
    X("stopAtr", "손절 (ATR 배수)", stop[0], stop.length > 1 ? stop : null),
    X("takeAtr", "익절 (ATR 배수, 0=없음)", take[0], take.length > 1 ? take : null),
    X("trailAtr", "추적손절 (ATR 배수, 0=없음)", trail[0], trail.length > 1 ? trail : null),
    X("maxHold", "최대 보유 (봉)", hold, null),
    X("minExitPct", "신호 청산 최소 수익", min, null),
  ];
  const c3 = (label, v) => ({ label, ok: !!v });
  const f1 = v => ok(v) ? v.toFixed(1) : "–";

  const STRATEGIES = [
    {
      id: "v1", kind: "revert", name: "기존 전략 (v1)",
      desc: "상승추세(EMA200 위)에서 볼린저 하단을 깨고 RSI가 과매도일 때 매수. 고정 % 익절·손절. 비교 기준용.",
      params: [X("emaTrend", "추세 EMA", 200), X("bbPeriod", "볼린저 기간", 20), X("bbStd", "볼린저 배수", 2),
        X("rsiPeriod", "RSI 기간", 14), X("rsiEntry", "RSI 진입 (미만)", 35),
        X("stopPct", "손절 %", 0.006), X("takePct", "익절 %", 0.01), X("maxHold", "최대 보유 (봉)", 24),
        X("midExit", "중심선 복귀 청산 (1/0)", 1), X("minExitPct", "신호 청산 최소 수익", 0.003)],
      warmup: p => Math.max(p.emaTrend * 2, p.bbPeriod, p.rsiPeriod * 5),
      prepare: (c, p, I) => ({ ema: I.ema(p.emaTrend), bb: I.bb(p.bbPeriod, p.bbStd), rsi: I.rsi(p.rsiPeriod) }),
      entry: (c, d, i, p) => ok(d.ema[i]) && ok(d.bb.low[i]) && ok(d.rsi[i]) &&
        c.close[i] > d.ema[i] && c.close[i] < d.bb.low[i] && d.rsi[i] < p.rsiEntry,
      exit: (c, d, i, p) => !!p.midExit && ok(d.bb.mid[i]) && c.close[i] >= d.bb.mid[i],
      view: (c, d, i, p) => ({ info: `RSI ${f1(d.rsi[i])}`, conds: [c3("추세↑", c.close[i] > d.ema[i]),
        c3("볼린저 하단 이탈", c.close[i] < d.bb.low[i]), c3(`RSI<${p.rsiEntry}`, d.rsi[i] < p.rsiEntry)] }),
    },
    {
      id: "pullback", kind: "revert", name: "눌림목 반등 (ATR)",
      desc: "v1과 같은 눌림목 매수지만, 익절·손절을 변동성(ATR)에 맞춰 조절. 변동성이 클 땐 넓게, 작을 땐 좁게.",
      params: [X("emaTrend", "추세 EMA", 200), X("bbPeriod", "볼린저 기간", 20), X("bbStd", "볼린저 배수", 2, [2, 2.5]),
        X("rsiEntry", "RSI 진입 (미만)", 35, [30, 38]), ...exitParams({ stop: [1.5, 2.5, 4], take: [2, 3, 5], hold: 48 })],
      warmup: p => Math.max(p.emaTrend * 2, p.bbPeriod, 70),
      prepare: (c, p, I) => ({ ema: I.ema(p.emaTrend), bb: I.bb(p.bbPeriod, p.bbStd), rsi: I.rsi(14) }),
      entry: (c, d, i, p) => ok(d.ema[i]) && ok(d.bb.low[i]) && ok(d.rsi[i]) &&
        c.close[i] > d.ema[i] && c.close[i] < d.bb.low[i] && d.rsi[i] < p.rsiEntry,
      exit: (c, d, i) => ok(d.bb.mid[i]) && c.close[i] >= d.bb.mid[i],
      view: (c, d, i, p) => ({ info: `RSI ${f1(d.rsi[i])}`, conds: [c3("추세↑", c.close[i] > d.ema[i]),
        c3("볼린저 하단 이탈", c.close[i] < d.bb.low[i]), c3(`RSI<${p.rsiEntry}`, d.rsi[i] < p.rsiEntry)] }),
    },
    {
      id: "squeeze", kind: "trend", name: "스퀴즈 돌파",
      desc: "볼린저밴드가 최근 가장 좁아진(에너지 응축) 직후, 거래량을 동반해 상단을 뚫으면 매수. 추적손절로 추세를 길게 탐.",
      params: [X("emaTrend", "추세 EMA", 200), X("bbPeriod", "볼린저 기간", 20), X("bbStd", "볼린저 배수", 2),
        X("sqLookback", "스퀴즈 비교 기간 (봉)", 120, [60, 120]), X("volMult", "거래량 배수", 1.5, [1.5, 2]),
        ...exitParams({ stop: [1.5, 2.5, 4], trail: [2, 3, 4.5], hold: 96 })],
      warmup: p => Math.max(p.emaTrend * 2, p.sqLookback + p.bbPeriod + 6, 25),
      prepare: (c, p, I) => {
        const bb = I.bb(p.bbPeriod, p.bbStd);
        return { bb, minW: I.rollMinOf(`w${p.bbPeriod},${p.bbStd}`, bb.width, p.sqLookback), ema: I.ema(p.emaTrend), vs: I.volSma(20) };
      },
      squeezed(d, i) { for (let j = i - 5; j < i; j++) if (j >= 0 && ok(d.minW[j]) && d.bb.width[j] <= d.minW[j] * 1.05) return true; return false; },
      entry(c, d, i, p) {
        return ok(d.bb.up[i]) && ok(d.vs[i]) && c.close[i] > d.ema[i] && c.close[i] > d.bb.up[i] &&
          c.volume[i] > p.volMult * d.vs[i] && this.squeezed(d, i);
      },
      view(c, d, i, p) {
        return { info: `밴드폭 ${ok(d.bb.width[i]) ? (d.bb.width[i] * 100).toFixed(2) + "%" : "–"}`, conds: [c3("추세↑", c.close[i] > d.ema[i]),
          c3("최근 스퀴즈", this.squeezed(d, i)), c3("상단 돌파", c.close[i] > d.bb.up[i]), c3("거래량 급증", c.volume[i] > p.volMult * d.vs[i])] };
      },
    },
    {
      id: "donchian", kind: "trend", name: "채널 돌파 + ADX",
      desc: "최근 N봉 최고가를 돌파하고 ADX로 추세 강도가 확인될 때 매수(터틀 트레이딩 방식). 채널 하단 이탈이나 추적손절로 청산.",
      params: [X("emaTrend", "추세 EMA", 200), X("chN", "채널 기간 (봉)", 20, [20, 48]), X("adxMin", "ADX 최소", 20, [20, 25]),
        ...exitParams({ stop: [1.5, 2.5, 4], trail: [2, 3, 4.5], hold: 144 })],
      warmup: p => Math.max(p.emaTrend * 2, p.chN + 1, 70),
      prepare: (c, p, I) => ({ hh: I.hh(p.chN), ll: I.ll(Math.max(2, Math.floor(p.chN / 2))), adx: I.adx(14), ema: I.ema(p.emaTrend) }),
      entry: (c, d, i, p) => ok(d.hh[i]) && ok(d.adx.adx[i]) && c.close[i] > d.hh[i] && d.adx.adx[i] > p.adxMin &&
        d.adx.pdi[i] > d.adx.mdi[i] && c.close[i] > d.ema[i],
      exit: (c, d, i) => ok(d.ll[i]) && c.close[i] < d.ll[i],
      view: (c, d, i, p) => ({ info: `ADX ${f1(d.adx.adx[i])}`, conds: [c3("추세↑", c.close[i] > d.ema[i]),
        c3("채널 상단 돌파", c.close[i] > d.hh[i]), c3(`ADX>${p.adxMin}`, d.adx.adx[i] > p.adxMin), c3("+DI>−DI", d.adx.pdi[i] > d.adx.mdi[i])] }),
    },
    {
      id: "stochrsi", kind: "revert", name: "정배열 + StochRSI 반전",
      desc: "단기·장기 이동평균이 정배열인 상승장에서, StochRSI가 과매도 구간에서 위로 꺾일 때 매수. 과매수 도달 시 청산.",
      params: [X("emaFast", "단기 EMA", 50, [50, 100]), X("emaTrend", "장기 EMA", 200), X("lvl", "과매도 기준", 20, [20, 30]),
        X("exitLvl", "과매수 청산 기준", 80), ...exitParams({ stop: [1.5, 2.5, 4], take: [2, 3, 5], hold: 72, min: 0.004 })],
      warmup: p => Math.max(p.emaTrend * 2, 60),
      prepare: (c, p, I) => ({ st: I.stoch(14, 14, 3, 3), ef: I.ema(p.emaFast), et: I.ema(p.emaTrend) }),
      entry: (c, d, i, p) => i > 0 && ok(d.st.d[i - 1]) && ok(d.st.d[i]) && d.ef[i] > d.et[i] && c.close[i] > d.et[i] &&
        d.st.k[i - 1] <= d.st.d[i - 1] && d.st.k[i] > d.st.d[i] && d.st.k[i - 1] < p.lvl,
      exit: (c, d, i, p) => d.st.k[i] > p.exitLvl,
      view: (c, d, i, p) => ({ info: `K ${f1(d.st.k[i])} / D ${f1(d.st.d[i])}`, conds: [c3("정배열", d.ef[i] > d.et[i] && c.close[i] > d.et[i]),
        c3(`K<${p.lvl}`, d.st.k[i - 1] < p.lvl), c3("K↗D 교차", d.st.k[i - 1] <= d.st.d[i - 1] && d.st.k[i] > d.st.d[i])] }),
    },
    {
      id: "vwap", kind: "revert", name: "VWAP 회귀",
      desc: "거래량 가중 평균가(VWAP)보다 ATR 몇 배 이상 과하게 빠진 뒤 RSI가 반등을 시작하면 매수. VWAP 복귀 시 청산.",
      params: [X("vwapN", "VWAP 기간 (봉)", 288, [144, 288]), X("dev", "이탈 폭 (ATR 배수)", 2, [1.5, 2.5]), X("rsiLvl", "RSI 과매도", 30, [30, 35]),
        ...exitParams({ stop: [1.5, 2.5, 4], hold: 72, min: 0.004 })],
      warmup: p => Math.max(p.vwapN + 1, 70),
      prepare: (c, p, I) => ({ vw: I.vwap(p.vwapN), atr: I.atr(14), rsi: I.rsi(14) }),
      entry: (c, d, i, p) => i > 0 && ok(d.vw[i]) && ok(d.rsi[i - 1]) && c.close[i] < d.vw[i] - p.dev * d.atr[i] &&
        d.rsi[i - 1] < p.rsiLvl && d.rsi[i] > d.rsi[i - 1],
      exit: (c, d, i) => ok(d.vw[i]) && c.close[i] >= d.vw[i],
      view: (c, d, i, p) => ({ info: `VWAP 대비 ${ok(d.vw[i]) ? ((c.close[i] / d.vw[i] - 1) * 100).toFixed(2) + "%" : "–"}`,
        conds: [c3(`VWAP−${p.dev}ATR 이탈`, c.close[i] < d.vw[i] - p.dev * d.atr[i]), c3(`RSI<${p.rsiLvl}`, d.rsi[i - 1] < p.rsiLvl), c3("RSI 반등", d.rsi[i] > d.rsi[i - 1])] }),
    },
    {
      id: "macd", kind: "trend", name: "MACD 반전 + 거래량",
      desc: "상승추세 중 MACD가 0선 아래로 눌렸다가 히스토그램이 양으로 돌아서고 거래량이 붙을 때 매수. 히스토그램이 다시 음수면 청산.",
      params: [X("emaTrend", "추세 EMA", 200, [100, 200]), X("volMult", "거래량 배수", 1.5, [1.2, 1.8]),
        ...exitParams({ stop: [1.5, 2.5, 4], take: [2.5, 4, 6], hold: 72, min: 0.004 })],
      warmup: p => Math.max(p.emaTrend * 2, 90),
      prepare: (c, p, I) => ({ m: I.macd(12, 26, 9), vs: I.volSma(20), et: I.ema(p.emaTrend) }),
      entry: (c, d, i, p) => i > 0 && ok(d.vs[i]) && c.close[i] > d.et[i] && d.m.line[i] < 0 &&
        d.m.hist[i - 1] <= 0 && d.m.hist[i] > 0 && c.volume[i] > p.volMult * d.vs[i],
      exit: (c, d, i) => d.m.hist[i] < 0,
      view: (c, d, i, p) => ({ info: `히스토 ${d.m.hist[i] >= 0 ? "+" : "−"}`, conds: [c3("추세↑", c.close[i] > d.et[i]),
        c3("MACD 0선 아래", d.m.line[i] < 0), c3("히스토 양전환", d.m.hist[i - 1] <= 0 && d.m.hist[i] > 0), c3("거래량", c.volume[i] > p.volMult * d.vs[i])] }),
    },
    {
      id: "capitulation", kind: "revert", name: "투매 반등",
      desc: "음봉이 연달아 나오며 ATR 몇 배만큼 급락하고 거래량이 터진 뒤, 첫 양봉이 나오면 짧게 반등을 노림. EMA20 회복 시 청산.",
      params: [X("reds", "연속 음봉 수", 3, [3, 4]), X("dropAtr", "급락 폭 (ATR 배수)", 2, [2, 3]), X("volMult", "거래량 배수", 1.5),
        ...exitParams({ stop: [1, 1.5, 2.5], take: [1.5, 2.5, 4], hold: 36, min: 0.004 })],
      warmup: () => 60,
      prepare: (c, p, I) => ({ atr: I.atr(14), vs: I.volSma(20), e20: I.ema(20) }),
      parts(c, d, i, p) {
        const a = i - p.reds;
        if (a < 1) return [false, false, false, false];
        let reds = true, vmax = 0;
        for (let j = a; j < i; j++) { if (c.close[j] >= c.open[j]) reds = false; vmax = Math.max(vmax, c.volume[j]); }
        vmax = Math.max(vmax, c.volume[i]);
        return [reds, c.open[a] - c.close[i - 1] >= p.dropAtr * d.atr[i - 1], vmax > p.volMult * d.vs[i - 1], c.close[i] > c.open[i]];
      },
      entry(c, d, i, p) { return ok(d.vs[i - 1]) && this.parts(c, d, i, p).every(Boolean); },
      exit: (c, d, i) => c.close[i] >= d.e20[i],
      view(c, d, i, p) {
        const [a, b, v, g] = this.parts(c, d, i, p);
        return { info: `ATR ${ok(d.atr[i]) ? (d.atr[i] / c.close[i] * 100).toFixed(2) + "%" : "–"}`,
          conds: [c3(`${p.reds}연속 음봉`, a), c3(`급락 ≥${p.dropAtr}ATR`, b), c3("거래량 급증", v), c3("양봉 반전", g)] };
      },
    },
    // ---------- 조사 기반 전략 (2026-10 추가) ----------
    {
      id: "intramom", name: "장중 모멘텀 (논문)", kind: "trend",
      desc: "Shen·Urquhart·Wang(2022, Financial Review) 연구: 비트코인은 하루 초반의 수익률 방향이 하루 후반에도 이어지는 경향이 있어요. UTC 0시(한국 오전 9시)부터 정한 시각까지 일정 이상 오르면 롱(내리면 숏)으로 들어가서 그날 끝(한국 다음날 오전 9시)에 청산해요.",
      params: [X("hour", "진입 시각 (UTC 시)", 16, [12, 16, 20]), X("thr", "최소 장중 등락 (0.01=1%)", 0.005, [0.005, 0.015]),
        ...exitParams({ stop: [2, 4], hold: 999, min: -1 })],
      warmup: (p, tf) => Math.ceil(2 * DAY / tf) + 20,
      prepare: (c, p, I) => ({ day: I.day(), tf: tfOf(c) }),
      entry: (c, d, i, p) => (c.ts[i] + d.tf) % DAY === p.hour * HOUR && c.close[i] / d.day.dayOpen[i] - 1 > p.thr,
      exit: (c, d, i) => (c.ts[i] + d.tf) % DAY === 0,
      view(c, d, i, p) {
        const r = c.close[i] / d.day.dayOpen[i] - 1, left = ((p.hour * HOUR - (c.ts[i] + d.tf) % DAY) + DAY) % DAY / HOUR;
        return { info: `오늘 ${(r * 100).toFixed(2)}%`, conds: [c3(`오늘 +${(p.thr * 100).toFixed(1)}% 이상`, r > p.thr), c3(`UTC ${p.hour}시 (${left.toFixed(0)}시간 남음)`, left === 0)] };
      },
    },
    {
      id: "season", name: "시간대 효과 (적응형)", kind: "time",
      desc: "연구들(Quantpedia 등)에서 비트코인은 특정 시간대(예: UTC 22~23시)에 수익이 몰리는 경향이 보고됐어요. 고정된 시간을 믿지 않고, 최근 N일 동안의 시간대별 평균 수익률을 매시간 다시 계산해서 다음 몇 시간 예상 수익이 기준보다 클 때만 진입해요.",
      params: [X("lookDays", "학습 기간 (일)", 30, [30, 60]), X("holdH", "보유 시간", 3, [2, 4]), X("thr", "최소 예상 수익", 0.003, [0.002, 0.004]),
        ...exitParams({ stop: [2, 4], hold: 999, min: -1 })],
      warmup: (p, tf) => Math.ceil((p.lookDays + 1) * DAY / tf),
      prepare: (c, p, I) => ({ f: I.season(p.lookDays, p.holdH), tf: tfOf(c) }),
      entry: (c, d, i, p) => ok(d.f[i]) && d.f[i] > p.thr,
      exit: (c, d, i, p, pos) => c.ts[i] - pos.entryCandleTs >= p.holdH * HOUR,
      view(c, d, i, p) {
        let j = i; while (j > 0 && Number.isNaN(d.f[j]) && i - j < 8) j--;
        const f = d.f[j];
        return { info: `다음 ${p.holdH}시간 예상 ${ok(f) ? (f * 100).toFixed(2) + "%" : "–"}`,
          conds: [c3(`예상 > ${(p.thr * 100).toFixed(1)}%`, ok(f) && f > p.thr), c3("정각", (c.ts[i] + d.tf) % HOUR === 0)] };
      },
    },
    {
      id: "volbreak", name: "변동성 돌파 (래리 윌리엄스)", kind: "trend",
      desc: "한국 코인봇에서 가장 유명한 전략이에요. 오늘 시가 + 전날 변동폭 × k를 돌파하면 진입하고, 그날 끝(한국 시간 오전 9시)에 청산해요. 5일 이동평균 위에서만 사는 필터를 켤 수 있어요. 숏은 아래로 돌파할 때.",
      params: [X("k", "돌파 계수 k", 0.5, [0.3, 0.5, 0.7]), X("maF", "5일선 필터 (1/0)", 1, [0, 1]), ...exitParams({ stop: [2, 4], hold: 999, min: -1 })],
      warmup: (p, tf) => Math.ceil(7 * DAY / tf),
      prepare: (c, p, I) => ({ day: I.day(), tf: tfOf(c) }),
      level: (d, i, p) => d.day.dayOpen[i] + p.k * d.day.prevRange[i],
      parts(c, d, i, p) {
        if (i < 1) return [false, false, false];
        const L = this.level(d, i, p);
        if (!ok(L)) return [false, false, false];
        const same = Math.floor(c.ts[i] / DAY) === Math.floor(c.ts[i - 1] / DAY);
        const cross = c.close[i] > L && (same ? c.close[i - 1] <= L : c.open[i] <= L) && (c.ts[i] + d.tf) % DAY !== 0;
        return [c.close[i] > L, cross, !p.maF || (ok(d.day.ma5[i]) && d.day.dayOpen[i] > d.day.ma5[i])];
      },
      entry(c, d, i, p) { const [, x, m] = this.parts(c, d, i, p); return x && m; },
      exit: (c, d, i) => (c.ts[i] + d.tf) % DAY === 0,
      view(c, d, i, p) {
        const [a, , m] = this.parts(c, d, i, p), L = this.level(d, i, p);
        return { info: `돌파선까지 ${ok(L) ? ((L / c.close[i] - 1) * 100).toFixed(2) + "%" : "–"}`, conds: [c3("돌파선 위", a), c3("5일선 위", m)] };
      },
    },
  ];
  // ---------------- 상황별 앙상블 ----------------
  // 시장 상태(효율비율)에 따라 추세형 또는 되돌림형 전략들만 투표 → 최근 memory봉 안에 votes개 이상 신호면 진입.
  // 각 전략은 기본 설정 그대로 사용 (과거에 끼워 맞출 여지를 줄이기 위해).
  const ENS_COMPONENTS = ["pullback", "stochrsi", "vwap", "capitulation", "squeeze", "donchian", "macd", "intramom", "volbreak"];
  STRATEGIES.push({
    id: "ensemble", name: "상황별 앙상블", kind: "meta",
    desc: "지금까지의 전략 9개를 한 팀으로 묶어요. 추세장(효율비율 높음)에서는 추세형 5개(스퀴즈·채널·MACD·장중 모멘텀·변동성 돌파)가, 횡보장에서는 되돌림형 4개(눌림목·StochRSI·VWAP·투매 반등)가 투표하고, 최근 몇 봉 안에 여러 전략이 같은 방향으로 동의할 때만 진입해요. 각 전략은 기본 설정 그대로 써요.",
    params: [X("votes", "최소 동의 전략 수", 2, [1, 2]), X("memory", "신호 유효 기간 (봉)", 3, [1, 3]), X("erThrE", "추세장 기준 (효율비율)", 0.3),
      ...exitParams({ stop: [1.5, 2.5, 4], take: [2, 4], trail: [0, 3], hold: 48 })],
    comps: () => ENS_COMPONENTS.map(id => STRATEGIES.find(s => s.id === id)),
    warmup(p, tf) { return Math.max(...this.comps().map(s => s.warmup(defaults(s), tf)), 60) + p.memory; },
    prepare(c, p, I) {
      return I.memo("ensemble", () => {
        const n = c.ts.length;
        const sig = this.comps().map(s => {
          const p0 = defaults(s), d = s.prepare(c, p0, I), a = new Uint8Array(n);
          for (let i = 0; i < n; i++) { try { a[i] = s.entry(c, d, i, p0) ? 1 : 0; } catch { a[i] = 0; } }
          return { s, a };
        });
        return { er: I.er(48), sig };
      });
    },
    kindAt: (c, d, i, p) => ok(d.er[i]) && d.er[i] >= p.erThrE ? "trend" : "revert",
    count(c, d, i, p) {
      const kind = this.kindAt(c, d, i, p), names = [];
      for (const { s, a } of d.sig) {
        if (s.kind !== kind) continue;
        for (let j = Math.max(0, i - p.memory + 1); j <= i; j++) if (a[j]) { names.push(s.name.replace(/ \(.*\)/, "")); break; }
      }
      return { kind, names };
    },
    entry(c, d, i, p) { return this.count(c, d, i, p).names.length >= p.votes; },
    view(c, d, i, p) {
      const { kind, names } = this.count(c, d, i, p);
      return { info: `${kind === "trend" ? "추세장" : "횡보장"} · ER ${ok(d.er[i]) ? d.er[i].toFixed(2) : "–"} · 동의 ${names.length}`,
        conds: [c3(kind === "trend" ? "추세장 → 추세형 전략 투표" : "횡보장 → 되돌림형 전략 투표", true),
                c3(`${p.votes}개 이상 동의${names.length ? ": " + names.join(", ") : ""}`, names.length >= p.votes)] };
    },
  });

  // ---------------- 공통 필터 ----------------
  // ① 시장 상태 (0=끔, 1=추세장에서만, 2=횡보장에서만)
  // ② 봉 내부 확인 (체결강도 = 시장가 매수 비율, 봉 모양 = 종가가 봉 안에서 어디쯤인지)
  //    추세형: 신호 봉을 공격적 매수가 밀어 올리고(체결강도 ≥ 기준) 위쪽에서 마감
  //    되돌림형: 직전 3봉에 공격적 매도가 쏟아졌고(체결강도 ≤ 1−기준) 신호 봉은 매수가 받아내 중간 이상에서 마감
  for (const s of STRATEGIES) s.params.push(
    X("regime", "시장 상태 필터 (0 끔 · 1 추세장만 · 2 횡보장만)", 0), X("erLen", "추세 판단 기간 (봉)", 48), X("erThr", "추세 기준 (효율비율 0~1)", 0.3),
    X("flow", "봉 내부 확인 (0 끔 · 1 켬)", 0), X("flowThr", "체결강도 기준 (시장가 매수 비율)", 0.55),
    X("scaleIn", "분할 매수 (0 끔 · 1 켬)", 0), X("siFrac", "1차 진입 비중", 0.5), X("siAtr", "2차 진입 간격 (ATR 배수)", 1),
    X("scaleOut", "분할 매도 (0 끔 · 1 켬)", 0), X("soFrac", "1차 익절 비중", 0.5), X("soAtr", "1차 익절 (ATR 배수)", 1.5),
    X("bias", "큰 방향 필터 (0 끔 · 1 켬: 추세선 위면 롱만, 아래면 숏만)", 0), X("biasDays", "큰 방향 추세선 (일)", 30),
    X("runner", "러너 (0 끔 · 1 켬: 분할 익절 후 남은 물량은 추적손절로만)", 0), X("runAtr", "러너 추적손절 (ATR 배수)", 3),
    X("limitEntry", "지정가 진입 (0 끔 · 1 켬)", 0), X("limOff", "지정가 간격 (ATR 배수, 더 좋은 가격 쪽)", 0.25), X("limBars", "지정가 대기 (봉)", 3),
    X("kelly", "켈리 동적 위험 (0 끔 · 1 켬)", 0), X("kellyFrac", "켈리 비율 (0.25 = 1/4 켈리)", 0.25), X("kellyN", "켈리 계산 거래 수 (최근)", 30),
    X("riskMin", "동적 위험 최소 (0.005 = 0.5%)", 0.005), X("riskMax", "동적 위험 최대 (0.03 = 3%)", 0.03));
  // 보관: 여러 번의 롤링 검증에서 상위권에 들지 못한 전략 (코드는 남겨서 예전 설정은 계속 동작, 연구실에서는 제외)
  const RETIRED = new Set(["v1", "stochrsi", "vwap", "macd", "intramom", "season", "volbreak", "ensemble", "squeeze", "capitulation"]);
  for (const s of STRATEGIES) s.retired = RETIRED.has(s.id);
  const ACTIVE = () => STRATEGIES.filter(s => !s.retired);
  const KIND_REGIME = { trend: 1, revert: 2 };
  function regimeOk(I, i, p) {
    if (!p.regime) return true;
    const e = I.er(p.erLen)[i];
    if (!ok(e)) return false;
    return p.regime === 1 ? e >= p.erThr : e < p.erThr;
  }
  const kindOf = (s, c, d, i, p) => s.kindAt ? s.kindAt(c, d, i, p) : s.kind;
  function flowParts(c, I, i, p, kind) {
    const tb = I.tbr(), cl = I.clv();
    if (!ok(tb[i])) return null;                              // 체결강도 데이터 없음 → 판단 보류(통과)
    if (kind === "trend") return [tb[i] >= p.flowThr, cl[i] >= 0.6, tb[i]];
    if (kind === "revert") {
      let s = 0, n = 0; for (let j = Math.max(0, i - 3); j < i; j++) if (ok(tb[j])) { s += tb[j]; n++; }
      const avg = n ? s / n : NaN;
      return [ok(avg) && avg <= 1 - p.flowThr, cl[i] >= 0.5, avg];
    }
    return [true, true, tb[i]];
  }
  function flowOk(c, I, i, p, kind) {
    if (!p.flow) return true;
    const f = flowParts(c, I, i, p, kind);
    return !f || (f[0] && f[1]);
  }
  // 큰 방향: N일 지수이동평균 위에서만 롱 (숏은 뒤집힌 차트에서 같은 규칙 → 추세선 아래에서만 숏)
  const biasBars = (p, tf) => Math.max(2, Math.round(p.biasDays * DAY / tf));
  function biasOk(c, I, i, p) {
    if (!p.bias) return true;
    const e = I.ema(biasBars(p, tfOf(c)))[i];
    return ok(e) && c.close[i] > e;
  }
  function entryOk(s, c, d, I, i, p) {
    return s.entry(c, d, i, p) && regimeOk(I, i, p) && flowOk(c, I, i, p, kindOf(s, c, d, i, p)) && biasOk(c, I, i, p);
  }
  const warmupOf = (s, p, tf) => Math.max(s.warmup(p, tf), p.regime ? p.erLen + 1 : 0, p.flow ? 4 : 0, p.bias ? 2 * biasBars(p, tf) : 0, 1);
  // 화면용: 전략 조건 + 필터 조건
  function viewOf(s, c, d, I, i, p) {
    const v = s.view(c, d, i, p);
    if (p.regime) {
      const e = I.er(p.erLen)[i];
      v.conds = [...v.conds, c3(p.regime === 1 ? `추세장 (ER≥${p.erThr})` : `횡보장 (ER<${p.erThr})`, regimeOk(I, i, p))];
      v.info += ` · ER ${ok(e) ? e.toFixed(2) : "–"}`;
    }
    if (p.flow) {
      const kind = kindOf(s, c, d, i, p), f = flowParts(c, I, i, p, kind);
      if (!f) v.conds = [...v.conds, c3("체결강도 데이터 없음 (통과)", true)];
      else if (kind === "trend") v.conds = [...v.conds, c3(`매수 체결강도 ≥ ${p.flowThr * 100}%`, f[0]), c3("봉 위쪽 마감", f[1])];
      else if (kind === "revert") v.conds = [...v.conds, c3(`직전 매도 체결 우세 (매수 ≤ ${Math.round((1 - p.flowThr) * 100)}%)`, f[0]), c3("매수가 받아낸 마감", f[1])];
      if (f && ok(f[2])) v.info += ` · 체결 ${(f[2] * 100).toFixed(0)}%`;
    }
    if (p.bias) v.conds = [...v.conds, c3(`큰 방향 일치 (${p.biasDays}일 추세선)`, biasOk(c, I, i, p))];
    return v;
  }
  const byId = id => STRATEGIES.find(s => s.id === id) || STRATEGIES[0];
  const defaults = s => Object.fromEntries(s.params.map(x => [x.k, x.def]));
  // override: 고정할 값 / gx: 비교값을 바꿔 끼울 목록 (그 전략에 원래 비교값이 있는 항목만, maxHold는 배수로)
  function gridValues(s, x, gx) {
    if (!gx) return x.grid;
    if (x.k === "maxHold" && gx.holdMult) return gx.holdMult.map(m => Math.round(x.def * m));
    return x.grid && gx[x.k] ? gx[x.k] : x.grid;
  }
  function grid(s, override, gx) {
    let combos = [{ ...defaults(s), ...(override || {}) }];
    for (const x of s.params) {
      const vals = gridValues(s, x, gx);
      if (vals && !(override && x.k in override)) combos = combos.flatMap(c => vals.map(v => ({ ...c, [x.k]: v })));
    }
    return combos;
  }
  // 넓은 익절·손절 탐색용 비교값 (ATR 배수)
  const WIDE_GRID = { stopAtr: [2.5, 4, 6, 8], takeAtr: [2.5, 4, 6, 8], trailAtr: [3, 4.5, 6, 8], holdMult: [1, 3] };

  // ---------------- 숏 신호용 뒤집힌 차트 ----------------
  // 가격을 1/가격으로 뒤집으면 하락이 상승처럼 보임 → 같은 롱 전략을 그대로 숏 신호로 사용
  function mirror(c) {
    return { ts: c.ts, open: c.open.map(v => 1 / v), high: c.low.map(v => 1 / v), low: c.high.map(v => 1 / v),
             close: c.close.map(v => 1 / v), volume: c.volume,
             ...(c.takerBuy ? { takerBuy: c.takerBuy.map((v, i) => c.volume[i] - v) } : {}) };
  }

  // ---------------- 청산 ----------------
  // 한 봉에서 손절·익절 동시 도달 시 보수적으로 손절. 추적손절은 이전 봉까지의 최고(숏은 최저)가 기준.
  // 선물 포지션은 강제청산가(pos.liq)가 손절가보다 먼저 닿으면 강제청산.
  function checkExit(pos, high, low, close, barsHeld, signal, p) {
    // 손절선은 최초 진입가(pos.ref) 기준으로 고정 → 분할 매수로 평단이 바뀌어도 손절선은 그대로.
    // 분할 매도 후(pos.be)에는 손절선을 평단(본전)까지 올림. 익절·신호 청산은 평단 기준.
    // 러너: 분할 익절이 끝난 남은 물량은 익절선·신호 청산 없이 추적손절(runAtr)과 본전 손절로만, 보유 시간 3배
    const run = !!(p.runner && pos.partialDone);
    const d = pos.dir || 1, e = pos.entryPrice, a = pos.atr, mx = p.minExitPct || 0, sref = pos.ref ?? e;
    const trailK = run ? Math.max(p.trailAtr || 0, p.runAtr || 3) : p.trailAtr, hold = run ? p.maxHold * 3 : p.maxHold;
    if (run) signal = false;
    let r = null;
    if (d > 0) {
      let init = p.stopPct != null ? sref * (1 - p.stopPct) : sref - p.stopAtr * a;
      if (pos.be) init = Math.max(init, e);
      const stop = trailK > 0 ? Math.max(init, pos.highest - trailK * a) : init;
      const take = run ? Infinity : p.takePct != null ? e * (1 + p.takePct) : p.takeAtr > 0 ? e + p.takeAtr * a : Infinity;
      if (pos.liq != null && pos.liq > stop && low <= pos.liq) r = { reason: "liquidation", price: pos.liq };
      else if (low <= stop) r = { reason: stop > init ? "trail_stop" : pos.be && stop === e ? "breakeven" : "stop_loss", price: stop };
      else if (high >= take) r = { reason: "take_profit", price: take, maker: true };
      else if (signal && close >= e * (1 + mx)) r = { reason: "signal_exit", price: close };
      else if (barsHeld >= hold) r = { reason: "time_exit", price: close };
      if (!r) pos.highest = Math.max(pos.highest, high);
    } else {
      let init = p.stopPct != null ? sref * (1 + p.stopPct) : sref + p.stopAtr * a;
      if (pos.be) init = Math.min(init, e);
      const stop = trailK > 0 ? Math.min(init, pos.lowest + trailK * a) : init;
      const take = run ? -Infinity : p.takePct != null ? e * (1 - p.takePct) : p.takeAtr > 0 ? e - p.takeAtr * a : -Infinity;
      if (pos.liq != null && pos.liq < stop && high >= pos.liq) r = { reason: "liquidation", price: pos.liq };
      else if (high >= stop) r = { reason: stop < init ? "trail_stop" : pos.be && stop === e ? "breakeven" : "stop_loss", price: stop };
      else if (low <= take) r = { reason: "take_profit", price: take, maker: true };
      else if (signal && close <= e * (1 - mx)) r = { reason: "signal_exit", price: close };
      else if (barsHeld >= hold) r = { reason: "time_exit", price: close };
      if (!r) pos.lowest = Math.min(pos.lowest, low);
    }
    return r;
  }

  // ---------------- 분할 매수 · 분할 매도 ----------------
  // 분할 매수: 처음엔 siFrac만 진입하고 나머지는 예약.
  //   되돌림형 → 더 유리한 가격(최초가 −siAtr×ATR, 단 손절선까지 거리의 절반 안쪽)에서 추가 (평단 낮추기)
  //   추세형   → 맞는 방향으로 siAtr×ATR 가면 추가 (불타기). 이때 손절 기준을 올려서 최악 손실이 처음 계획과 같게 유지.
  function scaleInStep(b, key, pos, high, low, p) {
    if (!p.scaleIn || pos.added || !(pos.reserve > 0)) return null;
    const d = pos.dir || 1, a = pos.atr, ref = pos.ref ?? pos.entryPrice;
    const stopDist = p.stopPct != null ? ref * p.stopPct : p.stopAtr * a;
    let lvl, hit;
    if (pos.kind === "revert") { lvl = ref - d * Math.min(p.siAtr * a, 0.5 * stopDist); hit = d > 0 ? low <= lvl : high >= lvl; }
    else { lvl = ref + d * p.siAtr * a; hit = d > 0 ? high >= lvl : low <= lvl; }
    if (!hit) return null;
    const amt = Math.min(pos.reserve, b.cash);
    pos.reserve = 0; pos.added = true;
    if (amt <= 0) return null;
    b.add(key, lvl, amt, pos.kind === "revert");
    if (pos.kind !== "revert") pos.ref = ref + d * (1 - p.siFrac) * p.siAtr * a;
    return { price: lvl };
  }
  // 분할 매도: 평단 대비 soAtr×ATR 수익에서 soFrac만큼 익절, 남은 물량은 손절선을 본전으로
  function scaleOutStep(b, key, pos, high, low, p, when) {
    if (!p.scaleOut || pos.partialDone) return null;
    const d = pos.dir || 1, lvl = pos.entryPrice + d * p.soAtr * pos.atr;
    if (!(d > 0 ? high >= lvl : low <= lvl)) return null;
    b.partial(key, p.soFrac, lvl, true);
    pos.partialDone = true; pos.be = true;
    return { price: lvl };
  }
  const exitAvg = (pos, price) => { const xq = pos.xQty || 0; return xq ? ((pos.xVal || 0) + pos.qty * price) / (xq + pos.qty) : price; };

  // ---------------- 현물 모의 브로커 (롱 전용) ----------------
  class PaperBroker {
    constructor(startingCash, feeRate, slippageBps, state, makerFee) {
      this.market = "spot"; this.feeRate = feeRate; this.slip = slippageBps / 10000; this.makerFee = makerFee ?? null;
      Object.assign(this, { startingCash, cash: startingCash, positions: {}, trades: [], nTrades: 0, nWins: 0, realizedPnl: 0 }, state || {});
    }
    toJSON() {
      const { market, startingCash, cash, positions, nTrades, nWins, realizedPnl } = this;
      return { market, startingCash, cash, positions, trades: this.trades.slice(-500), nTrades, nWins, realizedPnl };
    }
    buy(symbol, price, quote, candleTs, when, extra = {}) {
      quote = Math.min(quote, this.cash);
      const mk = this.mk(extra.maker), fill = price * (1 + (mk ? 0 : this.slip)), fee = quote * (mk ? this.makerFee : this.feeRate), qty = (quote - fee) / fill;
      this.cash -= quote;
      const pos = { dir: 1, lev: 1, qty, entryPrice: fill, rawEntry: price, cost: quote, costTotal: quote, entryTime: when, entryCandleTs: candleTs, highest: fill, ...extra };
      if (pos.ref == null) pos.ref = fill;
      this.positions[symbol] = pos;
      return pos;
    }
    add(symbol, price, quote, maker) {
      const pos = this.positions[symbol];
      quote = Math.min(quote, this.cash);
      const fill = price * (1 + (this.mk(maker) ? 0 : this.slip)), q = (quote - quote * (this.mk(maker) ? this.makerFee : this.feeRate)) / fill;
      this.cash -= quote;
      pos.entryPrice = (pos.qty * pos.entryPrice + q * fill) / (pos.qty + q);
      pos.rawEntry = (pos.qty * pos.rawEntry + q * price) / (pos.qty + q);
      pos.qty += q; pos.cost += quote; pos.costTotal = (pos.costTotal ?? 0) + quote;
    }
    partial(symbol, frac, price, maker) {
      const pos = this.positions[symbol], q = pos.qty * frac, fill = price * (1 - (this.mk(maker) ? 0 : this.slip));
      const proceeds = q * fill * (1 - (this.mk(maker) ? this.makerFee : this.feeRate)), basis = pos.cost * frac;
      this.cash += proceeds;
      pos.qty -= q; pos.cost -= basis; pos.pnlAcc = (pos.pnlAcc || 0) + proceeds - basis;
      pos.xQty = (pos.xQty || 0) + q; pos.xVal = (pos.xVal || 0) + q * price;
    }
    sell(symbol, price, reason, when, maker) {
      const pos = this.positions[symbol]; delete this.positions[symbol];
      const fill = price * (1 - (this.mk(maker) ? 0 : this.slip)), gross = pos.qty * fill, proceeds = gross - gross * (this.mk(maker) ? this.makerFee : this.feeRate);
      this.cash += proceeds;
      const pnl = proceeds - pos.cost + (pos.pnlAcc || 0), base = pos.costTotal ?? pos.cost;
      this.nTrades++; if (pnl > 0) this.nWins++; this.realizedPnl += pnl;
      const t = { symbol, dir: 1, lev: 1, entryTime: pos.entryTime, exitTime: when, entryPrice: pos.entryPrice, exitPrice: fill,
                  qty: pos.qty, cost: base, proceeds, pnl, pnlPct: pnl / base, reason,
                  grossPct: pos.rawEntry ? exitAvg(pos, price) / pos.rawEntry - 1 : NaN, sym: pos.symbol, slotName: pos.slotName, rmult: pos.riskAmt ? pnl / pos.riskAmt : undefined,
                  scaled: (pos.added ? "+" : "") + (pos.partialDone ? "½" : "") };
      this.trades.push(t);
      return t;
    }
    mk(m) { return !!m && this.makerFee != null; }
    equityOne(key, px) { const pos = this.positions[key]; return pos ? this.cash + pos.qty * px : this.cash; }
    open(symbol, dir, price, amount, candleTs, when, extra) { return this.buy(symbol, price, amount, candleTs, when, extra); }
    close(symbol, price, reason, when, maker) { return this.sell(symbol, price, reason, when, maker); }
    fund() {}
    equity(prices) {
      let v = this.cash;
      for (const [s, pos] of Object.entries(this.positions)) v += pos.qty * (prices[pos.symbol ?? s] ?? pos.entryPrice);
      return v;
    }
  }

  // ---------------- 선물 모의 브로커 (격리 마진, 롱·숏, 레버리지) ----------------
  // 증거금(margin) × 레버리지 = 포지션 크기. 수수료는 포지션 크기에 부과.
  // 강제청산가에 닿으면 증거금 전액 손실. 펀딩비: 양수면 롱이 내고 숏이 받음.
  class FuturesBroker {
    constructor(startingCash, feeRate, slippageBps, mmr = 0.005, state, makerFee) {
      this.market = "futures"; this.feeRate = feeRate; this.slip = slippageBps / 10000; this.mmr = mmr; this.makerFee = makerFee ?? null;
      Object.assign(this, { startingCash, cash: startingCash, positions: {}, trades: [], nTrades: 0, nWins: 0, realizedPnl: 0, nLiq: 0 }, state || {});
    }
    toJSON() {
      const { market, startingCash, cash, positions, nTrades, nWins, realizedPnl, nLiq } = this;
      return { market, startingCash, cash, positions, trades: this.trades.slice(-500), nTrades, nWins, realizedPnl, nLiq };
    }
    mk(m) { return !!m && this.makerFee != null; }
    equityOne(key, px) {
      const pos = this.positions[key];
      return pos ? this.cash + Math.max(0, pos.margin + pos.dir * pos.qty * (px - pos.entryPrice) - pos.funding) : this.cash;
    }
    liqOf(pos) { return pos.lev > 1 ? (pos.dir > 0 ? pos.entryPrice * (1 - 1 / pos.lev + this.mmr) : pos.entryPrice * (1 + 1 / pos.lev - this.mmr)) : null; }
    open(symbol, dir, price, margin, candleTs, when, extra = {}) {
      const lev = Math.max(1, extra.lev || 1), mk = this.mk(extra.maker), fr = mk ? this.makerFee : this.feeRate;
      margin = Math.min(margin, this.cash / (1 + lev * fr));
      const fill = price * (1 + dir * (mk ? 0 : this.slip)), notional = margin * lev, qty = notional / fill, fee = notional * fr;
      this.cash -= margin + fee;
      const pos = { ...extra, dir, lev, qty, entryPrice: fill, rawEntry: price, margin, notional, cost: margin, costTotal: margin, openFee: fee, funding: 0,
                    entryTime: when, entryCandleTs: candleTs, highest: fill, lowest: fill };
      if (pos.ref == null) pos.ref = fill;
      pos.liq = this.liqOf(pos);
      this.positions[symbol] = pos;
      return pos;
    }
    add(symbol, price, margin, maker) {
      const pos = this.positions[symbol], lev = pos.lev, fr = this.mk(maker) ? this.makerFee : this.feeRate;
      margin = Math.min(margin, this.cash / (1 + lev * fr));
      const fill = price * (1 + pos.dir * (this.mk(maker) ? 0 : this.slip)), notional = margin * lev, q = notional / fill, fee = notional * fr;
      this.cash -= margin + fee;
      pos.entryPrice = (pos.qty * pos.entryPrice + q * fill) / (pos.qty + q);
      pos.rawEntry = (pos.qty * pos.rawEntry + q * price) / (pos.qty + q);
      pos.qty += q; pos.margin += margin; pos.notional += notional; pos.openFee += fee; pos.cost = pos.margin; pos.costTotal = (pos.costTotal ?? 0) + margin;
      pos.liq = this.liqOf(pos);
    }
    partial(symbol, frac, price, maker) {
      const pos = this.positions[symbol], q = pos.qty * frac, fill = price * (1 - pos.dir * (this.mk(maker) ? 0 : this.slip));
      const gross = pos.dir * q * (fill - pos.entryPrice), fee = q * fill * (this.mk(maker) ? this.makerFee : this.feeRate);
      const mPart = pos.margin * frac, fPart = pos.funding * frac, ofPart = pos.openFee * frac;
      this.cash += mPart + gross - fee - fPart;
      pos.pnlAcc = (pos.pnlAcc || 0) + gross - fee - ofPart - fPart;
      pos.qty -= q; pos.margin -= mPart; pos.notional *= 1 - frac; pos.funding -= fPart; pos.openFee -= ofPart; pos.cost = pos.margin;
      pos.xQty = (pos.xQty || 0) + q; pos.xVal = (pos.xVal || 0) + q * price;
    }
    fund(symbol, price, rate) {
      const pos = this.positions[symbol];
      if (pos) pos.funding += pos.dir * rate * pos.qty * price;
    }
    close(symbol, price, reason, when, maker) {
      const pos = this.positions[symbol]; delete this.positions[symbol];
      let fill, pnl, closeFee = 0;
      if (reason === "liquidation") {
        fill = price; pnl = -pos.margin - pos.openFee - pos.funding + (pos.pnlAcc || 0); this.nLiq++;
      } else {
        fill = price * (1 - pos.dir * (this.mk(maker) ? 0 : this.slip));
        const gross = pos.dir * pos.qty * (fill - pos.entryPrice);
        closeFee = pos.qty * fill * (this.mk(maker) ? this.makerFee : this.feeRate);
        this.cash += pos.margin + gross - closeFee - pos.funding;
        pnl = gross - closeFee - pos.openFee - pos.funding + (pos.pnlAcc || 0);
      }
      const base = pos.costTotal ?? pos.margin;
      this.nTrades++; if (pnl > 0) this.nWins++; this.realizedPnl += pnl;
      const t = { symbol, dir: pos.dir, lev: pos.lev, entryTime: pos.entryTime, exitTime: when, entryPrice: pos.entryPrice, exitPrice: fill,
                  qty: pos.qty, cost: base, pnl, pnlPct: pnl / base, reason, funding: pos.funding,
                  grossPct: pos.dir * (exitAvg(pos, price) / pos.rawEntry - 1), sym: pos.symbol, slotName: pos.slotName, rmult: pos.riskAmt ? pnl / pos.riskAmt : undefined,
                  scaled: (pos.added ? "+" : "") + (pos.partialDone ? "½" : "") };
      this.trades.push(t);
      return t;
    }
    equity(prices) {
      let v = this.cash;
      for (const [s, pos] of Object.entries(this.positions)) {
        const px = prices[pos.symbol ?? s] ?? pos.entryPrice;
        v += Math.max(0, pos.margin + pos.dir * pos.qty * (px - pos.entryPrice) - pos.funding);
      }
      return v;
    }
  }
  const makeBroker = (o, state) => o.market === "futures"
    ? new FuturesBroker(o.startingCash, o.feeRate, o.slippageBps, o.mmr ?? 0.005, state, o.makerFee)
    : new PaperBroker(o.startingCash, o.feeRate, o.slippageBps, state, o.makerFee);

  // ---------------- 백테스트 ----------------
  // o.from/o.to로 구간만 매매 (지표는 전체 데이터로 계산 → 워밍업 확보, 미래 데이터 미사용)
  // o.market: "spot" | "futures", o.dir: "long" | "short" | "both", o.leverage, o.fundingRate(8시간당)
  const FUNDING_MS = 8 * 3600e3;
  // 포지션 크기: 고정(자산 × 비중) 또는 위험 기준(손절에 걸리면 자산의 riskPct만 잃도록 역산, 고정 비중이 상한)
  // 켈리 기준: 최근 거래의 승률 W와 평균 이익/평균 손실 비율 R(손절 위험 대비 배수)로 f* = W − (1−W)/R.
  // 추정 오차가 크므로 kellyFrac(기본 1/4)만 쓰고 riskMin~riskMax로 제한. 거래가 10개 미만이면 기본 위험 사용.
  function kellyRisk(hist, p, base, dir) {
    const all = (hist || []).filter(t => t.reason !== "end_of_data");
    const same = dir ? all.filter(t => (t.dir || 1) === dir) : all;
    const useDir = !!dir && same.length >= 10;
    const h = (useDir ? same : all).slice(-(p.kellyN || 30));
    if (h.length < 10) return { risk: base, f: null, n: h.length };
    const r = h.map(t => ok(t.rmult) ? t.rmult : t.pnlPct), wins = r.filter(x => x > 0), losses = r.filter(x => x <= 0);
    const W = wins.length / r.length;
    if (!losses.length) return { risk: p.riskMax, f: Infinity, n: h.length, W, byDir: useDir };
    const R = (wins.reduce((a, x) => a + x, 0) / Math.max(1, wins.length)) / (-losses.reduce((a, x) => a + x, 0) / losses.length || 1e-9);
    const f = W - (1 - W) / Math.max(R, 1e-9);
    return { risk: Math.min(p.riskMax, Math.max(p.riskMin, p.kellyFrac * f)), f, n: h.length, W, R, byDir: useDir };
  }
  // 포지션 크기 계획: 고정(자산 × 비중) / 위험 기준(손절 시 자산의 risk%) / 켈리(위험%를 최근 성적으로 조절).
  // autoLev면 필요한 포지션을 증거금 상한 안에 담을 수 있는 최소 레버리지(maxLev 이하)를 자동 선택.
  function sizePlan(equity, cash, price, atr, p, o, lev, hist, share = 1, dir) {
    const capMargin = Math.min(equity * o.positionPct * share, cash);
    if (o.sizing !== "risk" && !p.kelly) return { amount: capMargin, lev, risk: null };
    const k = p.kelly ? kellyRisk(hist, p, o.riskPct ?? 0.01, dir) : null;
    const risk = (k ? k.risk : o.riskPct ?? 0.01) * share;
    const stopFrac = Math.max(p.stopPct != null ? p.stopPct : (p.stopAtr * atr) / price, 1e-4);
    const notional = (equity * risk) / stopFrac;
    let L = Math.max(1, lev);
    if (o.autoLev) L = Math.min(Math.max(1, Math.ceil(notional / Math.max(capMargin, 1e-9) - 1e-9)), Math.max(1, o.maxLev || 3));
    const amount = Math.min(notional / L, capMargin);
    return { amount, lev: L, risk, riskAmt: amount * L * stopFrac, kelly: k };
  }
  function sizeFor(equity, cash, price, atr, p, o, lev, share = 1, hist) {
    return sizePlan(equity, cash, price, atr, p, o, lev, hist, share).amount;
  }
  function openPos(b, key, side, price, size, candleTs, when, extra, p, kind) {
    const first = p.scaleIn ? size * p.siFrac : size;
    const pos = b.open(key, side, price, first, candleTs, when, extra);
    pos.kind = kind === "revert" ? "revert" : "trend";
    if (p.scaleIn) pos.reserve = size - first;
    return pos;
  }
  // 진입 신호는 익절·손절·분할 설정과 무관 → 데이터·전략·진입 설정별로 한 번만 계산해서 재사용
  const EXIT_KEYS = new Set(["stopAtr", "takeAtr", "trailAtr", "maxHold", "minExitPct", "stopPct", "takePct",
    "scaleIn", "siFrac", "siAtr", "scaleOut", "soFrac", "soAtr"]);
  const entryKey = (strat, p) => strat.id + ":" + Object.keys(p).filter(k => !EXIT_KEYS.has(k)).sort().map(k => k + "=" + p[k]).join(",");
  function entrySignals(strat, c, d, I, p) {
    return I.memo("sig|" + entryKey(strat, p), () => {
      const n = c.ts.length, a = new Uint8Array(n);
      for (let i = 0; i < n; i++) { try { a[i] = entryOk(strat, c, d, I, i, p) ? 1 : 0; } catch { a[i] = 0; } }
      return a;
    });
  }
  function simulate(c, strat, p, o) {
    const sym = o.symbol || "SYM", I = o.I || makeI(c), at = I.atr(14), n = c.close.length;
    const fut = o.market === "futures", longOn = !fut || o.dir !== "short", shortOn = fut && (o.dir === "short" || o.dir === "both");
    const dL = longOn ? strat.prepare(c, p, I) : null;
    const cm = shortOn ? (o.cm || mirror(c)) : null, Im = shortOn ? (o.Im || makeI(cm)) : null, dS = shortOn ? strat.prepare(cm, p, Im) : null;
    const sigL = longOn ? entrySignals(strat, c, dL, I, p) : null, sigS = shortOn ? entrySignals(strat, cm, dS, Im, p) : null;
    const from = Math.max(o.from ?? 0, warmupOf(strat, p, tfOf(c))), to = Math.min(o.to ?? n, n);
    const b = makeBroker(o), lev = fut ? Math.max(1, o.leverage || 1) : 1, fr = fut ? (o.fundingRate ?? 0.0001) : 0;
    let entryI = null, lastExitI = -1e9, pend = null;
    const equity = [];
    for (let i = from; i < to; i++) {
      // 지정가 대기 주문: 신호 봉 종가보다 limOff×ATR 좋은 가격. 시가가 이미 넘어섰으면 시가 체결, limBars 안에 안 닿으면 취소
      if (pend && entryI === null) {
        const lv = pend.side > 0 ? Math.min(pend.lvl, c.open[i]) : Math.max(pend.lvl, c.open[i]);
        if (pend.side > 0 ? c.low[i] <= pend.lvl : c.high[i] >= pend.lvl) {
          const pl = sizePlan(b.equityOne(sym, lv), b.cash, lv, pend.atr, p, o, lev, o.kellySeed ? o.kellySeed.concat(b.trades) : b.trades, 1, pend.side);
          if (pl.amount >= (o.minOrder ?? 10)) { openPos(b, sym, pend.side, lv, pl.amount, pend.ts, c.ts[i], { atr: pend.atr, lev: pl.lev, maker: true, riskAmt: pl.riskAmt }, p, pend.kind); entryI = i; }
          pend = null;
        } else if (i >= pend.expire) pend = null;
      }
      if (entryI === null && !pend && i - lastExitI > o.cooldownBars && ok(at[i - 1])) {
        const L = longOn && sigL[i - 1] === 1, S = shortOn && sigS[i - 1] === 1;
        if (L !== S) {
          const side = L ? 1 : -1, kind = L ? kindOf(strat, c, dL, i - 1, p) : kindOf(strat, cm, dS, i - 1, p);
          if (p.limitEntry) {
            pend = { side, lvl: c.close[i - 1] - side * p.limOff * at[i - 1], expire: i - 1 + p.limBars, atr: at[i - 1], ts: c.ts[i - 1], kind };
            i--; continue;                                   // 같은 봉에서 바로 체결 여부 확인
          }
          const pl = sizePlan(b.equityOne(sym, c.open[i]), b.cash, c.open[i], at[i - 1], p, o, lev, o.kellySeed ? o.kellySeed.concat(b.trades) : b.trades, 1, side);
          if (pl.amount >= (o.minOrder ?? 10)) {
            openPos(b, sym, side, c.open[i], pl.amount, c.ts[i - 1], c.ts[i], { atr: at[i - 1], lev: pl.lev, riskAmt: pl.riskAmt }, p, kind);
            entryI = i;
          }
        }
      }
      if (entryI !== null) {
        const pos = b.positions[sym];
        if (fr && i > entryI && c.ts[i] % FUNDING_MS === 0) b.fund(sym, c.open[i], fr);
        scaleInStep(b, sym, pos, c.high[i], c.low[i], p);
        const sig = !strat.exit ? false : pos.dir > 0 ? strat.exit(c, dL, i, p, pos) : strat.exit(cm, dS, i, p, pos);
        const r = checkExit(pos, c.high[i], c.low[i], c.close[i], i - entryI, sig, p);
        if (r) { b.close(sym, r.price, r.reason, c.ts[i], r.maker); entryI = null; lastExitI = i; }
        else scaleOutStep(b, sym, pos, c.high[i], c.low[i], p, c.ts[i]);
      }
      equity.push(b.equityOne(sym, c.close[i]));
    }
    if (entryI !== null) { b.close(sym, c.close[to - 1], "end_of_data", c.ts[to - 1]); equity[equity.length - 1] = b.equity({}); }
    const st = stats(b.trades, equity, o.startingCash, to > from ? c.close[to - 1] / c.close[from] - 1 : NaN);
    st.liquidations = b.nLiq || 0;
    return { stats: st, trades: b.trades, equity, start: from };
  }
  function stats(tr, equity, cash, bh) {
    const wins = tr.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0), losses = -tr.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
    let peak = -Infinity, mdd = 0;
    for (const e of equity) { peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1); }
    const g = tr.map(t => t.grossPct).filter(ok);
    return {
      trades: tr.length, winRate: tr.length ? tr.filter(t => t.pnl > 0).length / tr.length : 0,
      totalReturn: equity.length ? equity[equity.length - 1] / cash - 1 : 0, maxDrawdown: equity.length ? mdd : 0,
      profitFactor: losses > 0 ? wins / losses : wins > 0 ? Infinity : 0, wins, losses, buyHoldReturn: bh,
      grossSum: g.reduce((s, v) => s + v, 0), grossN: g.length,
      longs: tr.filter(t => t.dir > 0).length, shorts: tr.filter(t => t.dir < 0).length,
      longPnl: tr.filter(t => t.dir > 0).reduce((s, t) => s + t.pnl, 0) / cash, shortPnl: tr.filter(t => t.dir < 0).reduce((s, t) => s + t.pnl, 0) / cash,
      minEquity: equity.length ? Math.min(...equity) / cash - 1 : 0,
    };
  }

  // 5분봉 → 15분봉/1시간봉 (바이낸스와 같은 UTC 경계)
  function resample(c, fromMs, toMs) {
    const k = toMs / fromMs;
    if (k === 1) return c;
    const out = { ts: [], open: [], high: [], low: [], close: [], volume: [], ...(c.takerBuy ? { takerBuy: [] } : {}) };
    let cur = null, cnt = 0;
    const push = () => { if (cur && cnt === k) for (const f in out) out[f].push(cur[f]); };
    for (let i = 0; i < c.ts.length; i++) {
      const b = Math.floor(c.ts[i] / toMs) * toMs;
      if (!cur || cur.ts !== b) { push(); cur = { ts: b, open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i], volume: c.volume[i], takerBuy: c.takerBuy ? c.takerBuy[i] : 0 }; cnt = 1; }
      else { cur.high = Math.max(cur.high, c.high[i]); cur.low = Math.min(cur.low, c.low[i]); cur.close = c.close[i]; cur.volume += c.volume[i]; if (c.takerBuy) cur.takerBuy += c.takerBuy[i]; cnt++; }
    }
    push();
    return out;
  }

  const Core = { ema, rma, rsi, sma, bollinger, rollMax, rollMin, atr, macd, stochRsi, adx, vwap, makeI,
                 STRATEGIES, ACTIVE, byId, defaults, grid, gridValues, WIDE_GRID, regimeOk, flowOk, entryOk, kindOf, warmupOf, viewOf, KIND_REGIME, effRatio, dayInfo, seasonForecast, tfOf, DAY, HOUR, checkExit, scaleInStep, scaleOutStep, openPos, sizeFor, sizePlan, kellyRisk, biasOk, entrySignals, entryKey, PaperBroker, FuturesBroker, makeBroker, mirror, simulate, stats, resample, ok, FUNDING_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== "undefined" ? window : globalThis);
