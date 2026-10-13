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
      id: "v1", name: "기존 전략 (v1)",
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
      id: "pullback", name: "눌림목 반등 (ATR)",
      desc: "v1과 같은 눌림목 매수지만, 익절·손절을 변동성(ATR)에 맞춰 조절. 변동성이 클 땐 넓게, 작을 땐 좁게.",
      params: [X("emaTrend", "추세 EMA", 200), X("bbPeriod", "볼린저 기간", 20), X("bbStd", "볼린저 배수", 2, [2, 2.5]),
        X("rsiEntry", "RSI 진입 (미만)", 35, [30, 38]), ...exitParams({ stop: [1.5, 2.5], take: [2, 3], hold: 36 })],
      warmup: p => Math.max(p.emaTrend * 2, p.bbPeriod, 70),
      prepare: (c, p, I) => ({ ema: I.ema(p.emaTrend), bb: I.bb(p.bbPeriod, p.bbStd), rsi: I.rsi(14) }),
      entry: (c, d, i, p) => ok(d.ema[i]) && ok(d.bb.low[i]) && ok(d.rsi[i]) &&
        c.close[i] > d.ema[i] && c.close[i] < d.bb.low[i] && d.rsi[i] < p.rsiEntry,
      exit: (c, d, i) => ok(d.bb.mid[i]) && c.close[i] >= d.bb.mid[i],
      view: (c, d, i, p) => ({ info: `RSI ${f1(d.rsi[i])}`, conds: [c3("추세↑", c.close[i] > d.ema[i]),
        c3("볼린저 하단 이탈", c.close[i] < d.bb.low[i]), c3(`RSI<${p.rsiEntry}`, d.rsi[i] < p.rsiEntry)] }),
    },
    {
      id: "squeeze", name: "스퀴즈 돌파",
      desc: "볼린저밴드가 최근 가장 좁아진(에너지 응축) 직후, 거래량을 동반해 상단을 뚫으면 매수. 추적손절로 추세를 길게 탐.",
      params: [X("emaTrend", "추세 EMA", 200), X("bbPeriod", "볼린저 기간", 20), X("bbStd", "볼린저 배수", 2),
        X("sqLookback", "스퀴즈 비교 기간 (봉)", 120, [60, 120]), X("volMult", "거래량 배수", 1.5, [1.5, 2]),
        ...exitParams({ stop: [1.5, 2.5], trail: [2, 3], hold: 72 })],
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
      id: "donchian", name: "채널 돌파 + ADX",
      desc: "최근 N봉 최고가를 돌파하고 ADX로 추세 강도가 확인될 때 매수(터틀 트레이딩 방식). 채널 하단 이탈이나 추적손절로 청산.",
      params: [X("emaTrend", "추세 EMA", 200), X("chN", "채널 기간 (봉)", 20, [20, 48]), X("adxMin", "ADX 최소", 20, [20, 25]),
        ...exitParams({ stop: [1.5, 2.5], trail: [2, 3], hold: 96 })],
      warmup: p => Math.max(p.emaTrend * 2, p.chN + 1, 70),
      prepare: (c, p, I) => ({ hh: I.hh(p.chN), ll: I.ll(Math.max(2, Math.floor(p.chN / 2))), adx: I.adx(14), ema: I.ema(p.emaTrend) }),
      entry: (c, d, i, p) => ok(d.hh[i]) && ok(d.adx.adx[i]) && c.close[i] > d.hh[i] && d.adx.adx[i] > p.adxMin &&
        d.adx.pdi[i] > d.adx.mdi[i] && c.close[i] > d.ema[i],
      exit: (c, d, i) => ok(d.ll[i]) && c.close[i] < d.ll[i],
      view: (c, d, i, p) => ({ info: `ADX ${f1(d.adx.adx[i])}`, conds: [c3("추세↑", c.close[i] > d.ema[i]),
        c3("채널 상단 돌파", c.close[i] > d.hh[i]), c3(`ADX>${p.adxMin}`, d.adx.adx[i] > p.adxMin), c3("+DI>−DI", d.adx.pdi[i] > d.adx.mdi[i])] }),
    },
    {
      id: "stochrsi", name: "정배열 + StochRSI 반전",
      desc: "단기·장기 이동평균이 정배열인 상승장에서, StochRSI가 과매도 구간에서 위로 꺾일 때 매수. 과매수 도달 시 청산.",
      params: [X("emaFast", "단기 EMA", 50, [50, 100]), X("emaTrend", "장기 EMA", 200), X("lvl", "과매도 기준", 20, [20, 30]),
        X("exitLvl", "과매수 청산 기준", 80), ...exitParams({ stop: [1.5, 2], take: [2, 3], hold: 48, min: 0.004 })],
      warmup: p => Math.max(p.emaTrend * 2, 60),
      prepare: (c, p, I) => ({ st: I.stoch(14, 14, 3, 3), ef: I.ema(p.emaFast), et: I.ema(p.emaTrend) }),
      entry: (c, d, i, p) => i > 0 && ok(d.st.d[i - 1]) && ok(d.st.d[i]) && d.ef[i] > d.et[i] && c.close[i] > d.et[i] &&
        d.st.k[i - 1] <= d.st.d[i - 1] && d.st.k[i] > d.st.d[i] && d.st.k[i - 1] < p.lvl,
      exit: (c, d, i, p) => d.st.k[i] > p.exitLvl,
      view: (c, d, i, p) => ({ info: `K ${f1(d.st.k[i])} / D ${f1(d.st.d[i])}`, conds: [c3("정배열", d.ef[i] > d.et[i] && c.close[i] > d.et[i]),
        c3(`K<${p.lvl}`, d.st.k[i - 1] < p.lvl), c3("K↗D 교차", d.st.k[i - 1] <= d.st.d[i - 1] && d.st.k[i] > d.st.d[i])] }),
    },
    {
      id: "vwap", name: "VWAP 회귀",
      desc: "거래량 가중 평균가(VWAP)보다 ATR 몇 배 이상 과하게 빠진 뒤 RSI가 반등을 시작하면 매수. VWAP 복귀 시 청산.",
      params: [X("vwapN", "VWAP 기간 (봉)", 288, [144, 288]), X("dev", "이탈 폭 (ATR 배수)", 2, [1.5, 2.5]), X("rsiLvl", "RSI 과매도", 30, [30, 35]),
        ...exitParams({ stop: [1.5, 2.5], hold: 48, min: 0.004 })],
      warmup: p => Math.max(p.vwapN + 1, 70),
      prepare: (c, p, I) => ({ vw: I.vwap(p.vwapN), atr: I.atr(14), rsi: I.rsi(14) }),
      entry: (c, d, i, p) => i > 0 && ok(d.vw[i]) && ok(d.rsi[i - 1]) && c.close[i] < d.vw[i] - p.dev * d.atr[i] &&
        d.rsi[i - 1] < p.rsiLvl && d.rsi[i] > d.rsi[i - 1],
      exit: (c, d, i) => ok(d.vw[i]) && c.close[i] >= d.vw[i],
      view: (c, d, i, p) => ({ info: `VWAP 대비 ${ok(d.vw[i]) ? ((c.close[i] / d.vw[i] - 1) * 100).toFixed(2) + "%" : "–"}`,
        conds: [c3(`VWAP−${p.dev}ATR 이탈`, c.close[i] < d.vw[i] - p.dev * d.atr[i]), c3(`RSI<${p.rsiLvl}`, d.rsi[i - 1] < p.rsiLvl), c3("RSI 반등", d.rsi[i] > d.rsi[i - 1])] }),
    },
    {
      id: "macd", name: "MACD 반전 + 거래량",
      desc: "상승추세 중 MACD가 0선 아래로 눌렸다가 히스토그램이 양으로 돌아서고 거래량이 붙을 때 매수. 히스토그램이 다시 음수면 청산.",
      params: [X("emaTrend", "추세 EMA", 200, [100, 200]), X("volMult", "거래량 배수", 1.5, [1.2, 1.8]),
        ...exitParams({ stop: [1.5, 2], take: [2.5, 4], hold: 48, min: 0.004 })],
      warmup: p => Math.max(p.emaTrend * 2, 90),
      prepare: (c, p, I) => ({ m: I.macd(12, 26, 9), vs: I.volSma(20), et: I.ema(p.emaTrend) }),
      entry: (c, d, i, p) => i > 0 && ok(d.vs[i]) && c.close[i] > d.et[i] && d.m.line[i] < 0 &&
        d.m.hist[i - 1] <= 0 && d.m.hist[i] > 0 && c.volume[i] > p.volMult * d.vs[i],
      exit: (c, d, i) => d.m.hist[i] < 0,
      view: (c, d, i, p) => ({ info: `히스토 ${d.m.hist[i] >= 0 ? "+" : "−"}`, conds: [c3("추세↑", c.close[i] > d.et[i]),
        c3("MACD 0선 아래", d.m.line[i] < 0), c3("히스토 양전환", d.m.hist[i - 1] <= 0 && d.m.hist[i] > 0), c3("거래량", c.volume[i] > p.volMult * d.vs[i])] }),
    },
    {
      id: "capitulation", name: "투매 반등",
      desc: "음봉이 연달아 나오며 ATR 몇 배만큼 급락하고 거래량이 터진 뒤, 첫 양봉이 나오면 짧게 반등을 노림. EMA20 회복 시 청산.",
      params: [X("reds", "연속 음봉 수", 3, [3, 4]), X("dropAtr", "급락 폭 (ATR 배수)", 2, [2, 3]), X("volMult", "거래량 배수", 1.5),
        ...exitParams({ stop: [1, 1.5], take: [1.5, 2.5], hold: 24, min: 0.004 })],
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
  ];
  const byId = id => STRATEGIES.find(s => s.id === id) || STRATEGIES[0];
  const defaults = s => Object.fromEntries(s.params.map(x => [x.k, x.def]));
  function grid(s) {
    let combos = [defaults(s)];
    for (const x of s.params) if (x.grid) combos = combos.flatMap(c => x.grid.map(v => ({ ...c, [x.k]: v })));
    return combos;
  }

  // ---------------- 숏 신호용 뒤집힌 차트 ----------------
  // 가격을 1/가격으로 뒤집으면 하락이 상승처럼 보임 → 같은 롱 전략을 그대로 숏 신호로 사용
  function mirror(c) {
    return { ts: c.ts, open: c.open.map(v => 1 / v), high: c.low.map(v => 1 / v), low: c.high.map(v => 1 / v),
             close: c.close.map(v => 1 / v), volume: c.volume };
  }

  // ---------------- 청산 ----------------
  // 한 봉에서 손절·익절 동시 도달 시 보수적으로 손절. 추적손절은 이전 봉까지의 최고(숏은 최저)가 기준.
  // 선물 포지션은 강제청산가(pos.liq)가 손절가보다 먼저 닿으면 강제청산.
  function checkExit(pos, high, low, close, barsHeld, signal, p) {
    const d = pos.dir || 1, e = pos.entryPrice, a = pos.atr, mx = p.minExitPct || 0;
    let r = null;
    if (d > 0) {
      const init = p.stopPct != null ? e * (1 - p.stopPct) : e - p.stopAtr * a;
      const stop = p.trailAtr > 0 ? Math.max(init, pos.highest - p.trailAtr * a) : init;
      const take = p.takePct != null ? e * (1 + p.takePct) : p.takeAtr > 0 ? e + p.takeAtr * a : Infinity;
      if (pos.liq != null && pos.liq > stop && low <= pos.liq) r = { reason: "liquidation", price: pos.liq };
      else if (low <= stop) r = { reason: stop > init ? "trail_stop" : "stop_loss", price: stop };
      else if (high >= take) r = { reason: "take_profit", price: take };
      else if (signal && close >= e * (1 + mx)) r = { reason: "signal_exit", price: close };
      else if (barsHeld >= p.maxHold) r = { reason: "time_exit", price: close };
      if (!r) pos.highest = Math.max(pos.highest, high);
    } else {
      const init = p.stopPct != null ? e * (1 + p.stopPct) : e + p.stopAtr * a;
      const stop = p.trailAtr > 0 ? Math.min(init, pos.lowest + p.trailAtr * a) : init;
      const take = p.takePct != null ? e * (1 - p.takePct) : p.takeAtr > 0 ? e - p.takeAtr * a : -Infinity;
      if (pos.liq != null && pos.liq < stop && high >= pos.liq) r = { reason: "liquidation", price: pos.liq };
      else if (high >= stop) r = { reason: stop < init ? "trail_stop" : "stop_loss", price: stop };
      else if (low <= take) r = { reason: "take_profit", price: take };
      else if (signal && close <= e * (1 - mx)) r = { reason: "signal_exit", price: close };
      else if (barsHeld >= p.maxHold) r = { reason: "time_exit", price: close };
      if (!r) pos.lowest = Math.min(pos.lowest, low);
    }
    return r;
  }

  // ---------------- 현물 모의 브로커 (롱 전용) ----------------
  class PaperBroker {
    constructor(startingCash, feeRate, slippageBps, state) {
      this.market = "spot"; this.feeRate = feeRate; this.slip = slippageBps / 10000;
      Object.assign(this, { startingCash, cash: startingCash, positions: {}, trades: [], nTrades: 0, nWins: 0, realizedPnl: 0 }, state || {});
    }
    toJSON() {
      const { market, startingCash, cash, positions, nTrades, nWins, realizedPnl } = this;
      return { market, startingCash, cash, positions, trades: this.trades.slice(-500), nTrades, nWins, realizedPnl };
    }
    buy(symbol, price, quote, candleTs, when, extra) {
      quote = Math.min(quote, this.cash);
      const fill = price * (1 + this.slip), fee = quote * this.feeRate, qty = (quote - fee) / fill;
      this.cash -= quote;
      const pos = { dir: 1, lev: 1, qty, entryPrice: fill, rawEntry: price, cost: quote, entryTime: when, entryCandleTs: candleTs, highest: fill, ...extra };
      this.positions[symbol] = pos;
      return pos;
    }
    sell(symbol, price, reason, when) {
      const pos = this.positions[symbol]; delete this.positions[symbol];
      const fill = price * (1 - this.slip), gross = pos.qty * fill, proceeds = gross - gross * this.feeRate;
      this.cash += proceeds;
      const pnl = proceeds - pos.cost;
      this.nTrades++; if (pnl > 0) this.nWins++; this.realizedPnl += pnl;
      const t = { symbol, dir: 1, lev: 1, entryTime: pos.entryTime, exitTime: when, entryPrice: pos.entryPrice, exitPrice: fill,
                  qty: pos.qty, cost: pos.cost, proceeds, pnl, pnlPct: pnl / pos.cost, reason,
                  grossPct: pos.rawEntry ? price / pos.rawEntry - 1 : NaN };
      this.trades.push(t);
      return t;
    }
    open(symbol, dir, price, amount, candleTs, when, extra) { return this.buy(symbol, price, amount, candleTs, when, extra); }
    close(symbol, price, reason, when) { return this.sell(symbol, price, reason, when); }
    fund() {}
    equity(prices) {
      let v = this.cash;
      for (const [s, pos] of Object.entries(this.positions)) v += pos.qty * (prices[s] ?? pos.entryPrice);
      return v;
    }
  }

  // ---------------- 선물 모의 브로커 (격리 마진, 롱·숏, 레버리지) ----------------
  // 증거금(margin) × 레버리지 = 포지션 크기. 수수료는 포지션 크기에 부과.
  // 강제청산가에 닿으면 증거금 전액 손실. 펀딩비: 양수면 롱이 내고 숏이 받음.
  class FuturesBroker {
    constructor(startingCash, feeRate, slippageBps, mmr = 0.005, state) {
      this.market = "futures"; this.feeRate = feeRate; this.slip = slippageBps / 10000; this.mmr = mmr;
      Object.assign(this, { startingCash, cash: startingCash, positions: {}, trades: [], nTrades: 0, nWins: 0, realizedPnl: 0, nLiq: 0 }, state || {});
    }
    toJSON() {
      const { market, startingCash, cash, positions, nTrades, nWins, realizedPnl, nLiq } = this;
      return { market, startingCash, cash, positions, trades: this.trades.slice(-500), nTrades, nWins, realizedPnl, nLiq };
    }
    open(symbol, dir, price, margin, candleTs, when, extra = {}) {
      const lev = Math.max(1, extra.lev || 1);
      margin = Math.min(margin, this.cash / (1 + lev * this.feeRate));
      const fill = price * (1 + dir * this.slip), notional = margin * lev, qty = notional / fill, fee = notional * this.feeRate;
      this.cash -= margin + fee;
      const liq = dir > 0 ? fill * (1 - 1 / lev + this.mmr) : fill * (1 + 1 / lev - this.mmr);
      const pos = { ...extra, dir, lev, qty, entryPrice: fill, rawEntry: price, margin, notional, cost: margin, openFee: fee, funding: 0,
                    liq: lev > 1 ? liq : null, entryTime: when, entryCandleTs: candleTs, highest: fill, lowest: fill };
      this.positions[symbol] = pos;
      return pos;
    }
    fund(symbol, price, rate) {
      const pos = this.positions[symbol];
      if (pos) pos.funding += pos.dir * rate * pos.qty * price;
    }
    close(symbol, price, reason, when) {
      const pos = this.positions[symbol]; delete this.positions[symbol];
      let fill, pnl, closeFee = 0;
      if (reason === "liquidation") {
        fill = price; pnl = -pos.margin - pos.openFee - pos.funding; this.nLiq++;
      } else {
        fill = price * (1 - pos.dir * this.slip);
        const gross = pos.dir * pos.qty * (fill - pos.entryPrice);
        closeFee = pos.qty * fill * this.feeRate;
        this.cash += pos.margin + gross - closeFee - pos.funding;
        pnl = gross - closeFee - pos.openFee - pos.funding;
      }
      this.nTrades++; if (pnl > 0) this.nWins++; this.realizedPnl += pnl;
      const t = { symbol, dir: pos.dir, lev: pos.lev, entryTime: pos.entryTime, exitTime: when, entryPrice: pos.entryPrice, exitPrice: fill,
                  qty: pos.qty, cost: pos.margin, pnl, pnlPct: pnl / pos.margin, reason, funding: pos.funding,
                  grossPct: pos.dir * (price / pos.rawEntry - 1) };
      this.trades.push(t);
      return t;
    }
    equity(prices) {
      let v = this.cash;
      for (const [s, pos] of Object.entries(this.positions)) {
        const px = prices[s] ?? pos.entryPrice;
        v += Math.max(0, pos.margin + pos.dir * pos.qty * (px - pos.entryPrice) - pos.funding);
      }
      return v;
    }
  }
  const makeBroker = (o, state) => o.market === "futures"
    ? new FuturesBroker(o.startingCash, o.feeRate, o.slippageBps, o.mmr ?? 0.005, state)
    : new PaperBroker(o.startingCash, o.feeRate, o.slippageBps, state);

  // ---------------- 백테스트 ----------------
  // o.from/o.to로 구간만 매매 (지표는 전체 데이터로 계산 → 워밍업 확보, 미래 데이터 미사용)
  // o.market: "spot" | "futures", o.dir: "long" | "short" | "both", o.leverage, o.fundingRate(8시간당)
  const FUNDING_MS = 8 * 3600e3;
  function simulate(c, strat, p, o) {
    const sym = o.symbol || "SYM", I = o.I || makeI(c), at = I.atr(14), n = c.close.length;
    const fut = o.market === "futures", longOn = !fut || o.dir !== "short", shortOn = fut && (o.dir === "short" || o.dir === "both");
    const dL = longOn ? strat.prepare(c, p, I) : null;
    const cm = shortOn ? (o.cm || mirror(c)) : null, dS = shortOn ? strat.prepare(cm, p, o.Im || makeI(cm)) : null;
    const from = Math.max(o.from ?? 0, strat.warmup(p), 1), to = Math.min(o.to ?? n, n);
    const b = makeBroker(o), lev = fut ? Math.max(1, o.leverage || 1) : 1, fr = fut ? (o.fundingRate ?? 0.0001) : 0;
    let entryI = null, lastExitI = -1e9;
    const equity = [];
    for (let i = from; i < to; i++) {
      if (entryI === null && i - lastExitI > o.cooldownBars && ok(at[i - 1])) {
        const L = longOn && strat.entry(c, dL, i - 1, p), S = shortOn && strat.entry(cm, dS, i - 1, p);
        if (L !== S) {
          const size = Math.min(b.equity({ [sym]: c.open[i] }) * o.positionPct, b.cash);
          if (size >= (o.minOrder ?? 10)) { b.open(sym, L ? 1 : -1, c.open[i], size, c.ts[i - 1], c.ts[i], { atr: at[i - 1], lev }); entryI = i; }
        }
      }
      if (entryI !== null) {
        const pos = b.positions[sym];
        if (fr && i > entryI && c.ts[i] % FUNDING_MS === 0) b.fund(sym, c.open[i], fr);
        const sig = !strat.exit ? false : pos.dir > 0 ? strat.exit(c, dL, i, p, pos) : strat.exit(cm, dS, i, p, pos);
        const r = checkExit(pos, c.high[i], c.low[i], c.close[i], i - entryI, sig, p);
        if (r) { b.close(sym, r.price, r.reason, c.ts[i]); entryI = null; lastExitI = i; }
      }
      equity.push(b.equity({ [sym]: c.close[i] }));
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
      minEquity: equity.length ? Math.min(...equity) / cash - 1 : 0,
    };
  }

  // 5분봉 → 15분봉/1시간봉 (바이낸스와 같은 UTC 경계)
  function resample(c, fromMs, toMs) {
    const k = toMs / fromMs;
    if (k === 1) return c;
    const out = { ts: [], open: [], high: [], low: [], close: [], volume: [] };
    let cur = null, cnt = 0;
    const push = () => { if (cur && cnt === k) for (const f in out) out[f].push(cur[f]); };
    for (let i = 0; i < c.ts.length; i++) {
      const b = Math.floor(c.ts[i] / toMs) * toMs;
      if (!cur || cur.ts !== b) { push(); cur = { ts: b, open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i], volume: c.volume[i] }; cnt = 1; }
      else { cur.high = Math.max(cur.high, c.high[i]); cur.low = Math.min(cur.low, c.low[i]); cur.close = c.close[i]; cur.volume += c.volume[i]; cnt++; }
    }
    push();
    return out;
  }

  const Core = { ema, rma, rsi, sma, bollinger, rollMax, rollMin, atr, macd, stochRsi, adx, vwap, makeI,
                 STRATEGIES, byId, defaults, grid, checkExit, PaperBroker, FuturesBroker, makeBroker, mirror, simulate, stats, resample, ok, FUNDING_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== "undefined" ? window : globalThis);
