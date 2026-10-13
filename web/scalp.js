// 1분봉 스캘핑 엔진 (브라우저 window.Scalp / node require)
// - 한 계좌에서 여러 종목을 동시에 (현금·위험 공유), 레버리지는 손절 거리로 계산한 포지션 크기에 맞춰 자동
// - 지정가(메이커)는 가격이 주문가를 '뚫고' 지나가야 체결된 것으로 봄 (닿기만 하면 미체결 · 보수적)
// - 같은 1분봉 안에서 손절과 익절이 둘 다 가능하면 손절로 봄 (보수적)
(function (root) {
  "use strict";
  const H = 3600e3, M = 60e3;
  const ok = v => typeof v === "number" && Number.isFinite(v);

  // ---------- 지표 (모두 O(n)) ----------
  function atr(c, n = 14) {
    const L = c.close.length, out = new Float64Array(L).fill(NaN); let a = NaN;
    for (let i = 1; i < L; i++) {
      const tr = Math.max(c.high[i] - c.low[i], Math.abs(c.high[i] - c.close[i - 1]), Math.abs(c.low[i] - c.close[i - 1]));
      a = i < n ? (i === 1 ? tr : a + tr) : i === n ? (a + tr) / n : (a * (n - 1) + tr) / n;
      if (i >= n) out[i] = a;
    }
    return out;
  }
  function rollMeanSd(x, n) {
    const L = x.length, m = new Float64Array(L).fill(NaN), sd = new Float64Array(L).fill(NaN); let s = 0, q = 0;
    for (let i = 0; i < L; i++) {
      s += x[i]; q += x[i] * x[i];
      if (i >= n) { s -= x[i - n]; q -= x[i - n] * x[i - n]; }
      if (i >= n - 1) { const mu = s / n; m[i] = mu; sd[i] = Math.sqrt(Math.max(0, q / n - mu * mu)); }
    }
    return { m, sd };
  }
  // 직전 n개 봉(현재 봉 제외)의 최고가/최저가
  function priorMax(x, n) {
    const L = x.length, out = new Float64Array(L).fill(NaN), dq = new Int32Array(L); let h = 0, t = 0;
    for (let i = 0; i < L; i++) {
      while (t > h && dq[h] < i - n) h++;
      if (i >= n) out[i] = x[dq[h]];
      while (t > h && x[dq[t - 1]] <= x[i]) t--;
      dq[t++] = i;
    }
    return out;
  }
  const neg = x => Float64Array.from(x, v => -v);
  function priorMin(x, n) { return neg(priorMax(neg(x), n)); }
  function rollSum(x, n) {
    const L = x.length, out = new Float64Array(L).fill(NaN); let s = 0;
    for (let i = 0; i < L; i++) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) out[i] = s; }
    return out;
  }
  // 1시간봉 큰 흐름: 직전에 끝난 1시간봉 기준 (미래 정보 없음)
  //  dir = +1 (EMA 위 · EMA 상승 · 효율비율 ≥ thr), −1 (반대), 0 (그 외)
  //  er  = 효율비율 (0 = 지그재그 횡보, 1 = 한 방향)
  function htf(c, emaN, erLen) {
    const L = c.ts.length, hc = [], hIdx = new Int32Array(L);
    let cur = -1;
    for (let i = 0; i < L; i++) {
      const h = Math.floor(c.ts[i] / H);
      if (h !== cur) { hc.push(c.close[i]); cur = h; } else hc[hc.length - 1] = c.close[i];
      hIdx[i] = hc.length - 2;                        // 직전에 끝난 1시간봉
    }
    const n = hc.length, ema = new Float64Array(n), er = new Float64Array(n).fill(NaN), k = 2 / (emaN + 1);
    for (let j = 0; j < n; j++) ema[j] = j ? ema[j - 1] + k * (hc[j] - ema[j - 1]) : hc[j];
    for (let j = erLen; j < n; j++) { let p = 0; for (let q = j - erLen + 1; q <= j; q++) p += Math.abs(hc[q] - hc[q - 1]); er[j] = p > 0 ? Math.abs(hc[j] - hc[j - erLen]) / p : 0; }
    return { hc, ema, er, hIdx, warm: emaN * 3 };
  }

  function features(c) {
    const memo = new Map(), get = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
    return {
      c, n: c.ts.length,
      atr: () => get("atr", () => atr(c, 14)),
      bb: n => get("bb" + n, () => rollMeanSd(c.close, n)),
      hi: n => get("hi" + n, () => priorMax(c.high, n)),
      lo: n => get("lo" + n, () => priorMin(c.low, n)),
      volAvg: n => get("va" + n, () => { const s = rollSum(c.volume, n); return s.map(v => v / n); }),
      flow: n => get("fl" + n, () => { const tb = rollSum(c.takerBuy, n), v = rollSum(c.volume, n); return tb.map((x, i) => v[i] > 0 ? x / v[i] : 0.5); }),
      htf: (emaN, erLen) => get(`htf${emaN}|${erLen}`, () => htf(c, emaN, erLen)),
      memo: get,
    };
  }
  // 큰 흐름 방향 (i번째 1분봉에서 쓸 수 있는 것만)
  function trendAt(F, p, i) {
    const h = F.htf(p.htfN, p.erLen), j = h.hIdx[i];
    if (j < h.warm || j < 3) return { dir: 0, er: NaN };
    const er = h.er[j], up = h.hc[j] > h.ema[j] && h.ema[j] > h.ema[j - 3], dn = h.hc[j] < h.ema[j] && h.ema[j] < h.ema[j - 3];
    return { dir: er >= p.erThr ? (up ? 1 : dn ? -1 : 0) : 0, er };
  }
  // 분봉마다 큰 흐름 방향·효율비율을 미리 펼쳐 둠 (빠른 반복용)
  function trendArrays(F, p) {
    return F.memo(`tr${p.htfN}|${p.erLen}|${p.erThr}`, () => {
      const n = F.n, dir = new Int8Array(n), er = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) { const t = trendAt(F, p, i); dir[i] = t.dir; er[i] = t.er; }
      return { dir, er };
    });
  }

  // ---------- 전략: i번째 봉이 끝난 시점에 판단 → 다음 봉부터 주문 ----------
  //  pull : 큰 흐름 방향으로 현재가보다 k×ATR 유리한 곳에 지정가를 걸어둠 (눌림 매수 / 반등 매도). 익절도 지정가
  //  brk  : 직전 N분 고점(저점) 돌파 + 체결강도 + 거래량 급증 → 시장가. 익절은 지정가
  //  rev  : 횡보장(효율비율 낮음)에서 볼린저 밴드 끝에 지정가, 밴드 중심에서 지정가 익절
  const STRATS = {
    pull: {
      name: "추세 눌림 지정가", desc: "1시간봉 큰 흐름이 뚜렷할 때만, 그 방향으로 현재가보다 조금 유리한 가격에 지정가를 걸어 눌림을 받아요. 진입·익절 모두 지정가라 수수료가 싸요.",
      make(F, p) {
        const tr = trendArrays(F, p).dir, A = F.atr(), C = F.c.close;
        return i => {
          const d = tr[i], a = A[i];
          if (!d || !(a > 0) || (p.longOnly && d < 0)) return null;
          return { dir: d, limit: C[i] - d * p.k * a, atr: a, exp: i + p.exp };
        };
      },
      grid: { k: [0.5, 1, 2], m: [1, 2, 4], s: [2, 4], T: [30, 240], longOnly: [0, 1] },
      defaults: { htfN: 50, erLen: 24, erThr: 0.2, exp: 10, k: 1, m: 2, s: 3, T: 120, longOnly: 0 },
    },
    brk: {
      name: "1분 모멘텀 돌파", desc: "직전 N분 고점(저점)을 강한 시장가 매수(매도)와 거래량 급증이 같이 뚫을 때 바로 따라 들어가요. 1시간봉 큰 흐름과 같은 방향만.",
      make(F, p) {
        const c = F.c, A = F.atr(), HI = F.hi(p.N), LO = F.lo(p.N), FL = F.flow(5), VA = F.volAvg(30), tr = p.useHtf ? trendArrays(F, p).dir : null;
        return i => {
          const a = A[i], hi = HI[i], va = VA[i];
          if (!(a > 0) || !(hi > 0) || !(va > 0)) return null;
          const cl = c.close[i];
          if (cl <= hi && cl >= LO[i]) return null;
          const volOk = !p.vm || c.volume[i] >= p.vm * va, t = tr ? tr[i] : 0, fl = FL[i];
          if (cl > hi && volOk && fl >= p.flowThr && (!tr || t > 0)) return { dir: 1, market: true, atr: a };
          if (!p.longOnly && cl < LO[i] && volOk && fl <= 1 - p.flowThr && (!tr || t < 0)) return { dir: -1, market: true, atr: a };
          return null;
        };
      },
      grid: { N: [30, 120], flowThr: [0.5, 0.6], vm: [0, 2], m: [1.5, 3], s: [2, 4], T: [30, 240], useHtf: [0, 1] },
      defaults: { htfN: 50, erLen: 24, erThr: 0.2, N: 60, flowThr: 0.55, vm: 2, m: 2, s: 3, T: 120, useHtf: 1, longOnly: 0 },
    },
    rev: {
      name: "횡보 밴드 되돌림 지정가", desc: "1시간봉이 지그재그(횡보)일 때만, 1분 볼린저 밴드 끝에 지정가를 걸고 밴드 중심에서 지정가로 익절해요.",
      make(F, p) {
        const ER = trendArrays(F, p).er, A = F.atr(), { m, sd } = F.bb(p.bbN), C = F.c.close;
        return i => {
          const a = A[i], er = ER[i], mi = m[i];
          if (!(a > 0) || !(mi > 0) || !(er < p.erMax)) return null;
          const below = C[i] < mi;
          if (p.longOnly && !below) return null;
          const dir = below ? 1 : -1;
          return { dir, limit: mi - dir * p.bbK * sd[i], take: mi, atr: a, exp: i + p.exp };
        };
      },
      grid: { bbK: [2, 2.5, 3], erMax: [0.15, 0.3], s: [2, 4], T: [30, 120], longOnly: [0, 1] },
      defaults: { htfN: 50, erLen: 24, erThr: 0.2, bbN: 20, bbK: 2.5, erMax: 0.2, exp: 5, s: 3, T: 60, longOnly: 0, m: 0 },
    },
  };
  function gridOf(id, extra) {
    const s = STRATS[id], g = { ...s.grid, ...(extra || {}) }, keys = Object.keys(g);
    let out = [{ ...s.defaults }];
    for (const k of keys) out = out.flatMap(p => g[k].map(v => ({ ...p, [k]: v })));
    return out;
  }

  // ---------- 시뮬레이션 ----------
  // sets: [{ sym, F }] (F = features(c)), master: 기준 시간축 = sets[0]
  // o: { startingCash, takerFee, makerFee, slip(비율), through(지정가 체결에 필요한 관통 비율), riskPct, maxLev, cooldown, from, to, ddCut, ddMult, curve, trades }
  function align(sets) {
    const T = sets[0].F.c.ts, n = T.length;
    return sets.map(s => {
      const ts = s.F.c.ts, idx = new Int32Array(n).fill(-1); let j = 0;
      for (let t = 0; t < n; t++) { while (j < ts.length && ts[j] < T[t]) j++; if (j < ts.length && ts[j] === T[t]) idx[t] = j; }
      return idx;
    });
  }
  function simulate(sets, idx, id, p, o) {
    const S = STRATS[id], nS = sets.length, T = sets[0].F.c.ts;
    const from = o.from ?? 0, to = Math.min(o.to ?? T.length, T.length), slip = o.slip ?? 0, th = o.through ?? 0;
    const st = sets.map(() => ({ pos: null, pend: null, mkt: null, last: -1e9, px: NaN })), sig = sets.map(x => S.make(x.F, p));
    let cash = o.startingCash, eq = cash, peak = cash, mdd = 0, nTr = 0, wins = 0, gross = 0, fees = 0, makerN = 0, fills = 0;
    const curve = o.curve ? [] : null, trades = o.trades ? [] : null, cd = o.cooldown ?? 1;
    const open = (s, k, dir, price, atrV, maker, i, take) => {
      let risk = o.riskPct;
      if (o.ddCut && eq / peak - 1 < -o.ddCut) risk *= o.ddMult ?? 0.5;
      const stopD = p.s * atrV, qty0 = (eq * risk) / stopD, cap = (eq * o.maxLev) / nS;
      const qty = Math.min(qty0, cap / price);
      if (!(qty > 0)) return;
      const notional = qty * price, fee = notional * (maker ? o.makerFee : o.takerFee);
      cash -= fee; fees += fee; if (maker) makerN++;
      s.pos = { dir, entry: price, qty, i0: i, stop: price - dir * stopD, take: take ?? (p.m > 0 ? price + dir * p.m * atrV : NaN), fee, maker, risk: qty * stopD, t0: T[0] };
    };
    const close = (s, k, price, maker, why, t) => {
      const ps = s.pos, notional = ps.qty * price, fee = notional * (maker ? o.makerFee : o.takerFee), g = ps.dir * ps.qty * (price - ps.entry);
      cash += g - fee; fees += fee; if (maker) makerN++;
      const pnl = g - fee - ps.fee; nTr++; if (pnl > 0) wins++; gross += ps.dir * (price / ps.entry - 1);
      if (trades) trades.push({ sym: sets[k].sym, dir: ps.dir, pnl, r: pnl / ps.risk, why, gross: ps.dir * (price / ps.entry - 1), lev: notional / Math.max(eq, 1e-9), t });
      s.pos = null;
    };
    for (let t = from; t < to; t++) {
      for (let k = 0; k < nS; k++) {
        const i = idx[k][t]; if (i < 1) continue;
        const s = st[k], c = sets[k].F.c;
        if (s.mkt) { if (!s.pos) { const px = c.open[i] * (1 + s.mkt.dir * slip); open(s, k, s.mkt.dir, px, s.mkt.atr, false, i); fills++; } s.mkt = null; }
        if (s.pend && !s.pos) {
          const L = s.pend.limit, d = s.pend.dir;
          if (d > 0 ? c.low[i] < L * (1 - th) : c.high[i] > L * (1 + th)) { open(s, k, d, L, s.pend.atr, true, i, s.pend.take); fills++; s.pend = null; }
          else if (i >= s.pend.exp) s.pend = null;
        }
        const ps = s.pos;
        if (ps) {
          const d = ps.dir;
          if (d > 0 ? c.low[i] <= ps.stop : c.high[i] >= ps.stop) {
            const gap = i > ps.i0 && (d > 0 ? c.open[i] < ps.stop : c.open[i] > ps.stop), px = (gap ? c.open[i] : ps.stop) * (1 - d * slip);
            close(s, k, px, false, "stop", T[t]); s.last = i;
          } else if (i > ps.i0 && ok(ps.take) && (d > 0 ? c.high[i] > ps.take * (1 + th) : c.low[i] < ps.take * (1 - th)) && (d > 0 ? ps.take > ps.entry : ps.take < ps.entry)) {
            close(s, k, ps.take, true, "take", T[t]); s.last = i;
          } else if (i - ps.i0 >= p.T) { close(s, k, c.close[i] * (1 - d * slip), false, "time", T[t]); s.last = i; }
        }
        s.px = c.close[i];
        if (!s.pos && !s.pend && !s.mkt && i - s.last > cd) {
          const sg = sig[k](i);
          if (sg) { if (sg.market) s.mkt = sg; else s.pend = sg; }
        }
      }
      let u = 0; for (let k = 0; k < nS; k++) { const ps = st[k].pos; if (ps) u += ps.dir * ps.qty * (st[k].px - ps.entry); }
      eq = cash + u; if (eq > peak) peak = eq; const dd = eq / peak - 1; if (dd < mdd) mdd = dd;
      if (curve && (t % 15 === 0)) curve.push(eq);
      if (eq <= 0) { eq = 0; break; }
    }
    for (let k = 0; k < nS; k++) if (st[k].pos) close(st[k], k, st[k].px, false, "end", T[to - 1]);
    eq = cash;
    return { ret: eq / o.startingCash - 1, mdd, trades: nTr, win: nTr ? wins / nTr : 0, edge: nTr ? gross / nTr : 0, fees: fees / o.startingCash, makerShare: makerN / Math.max(1, 2 * nTr), curve, list: trades };
  }

  // 실시간용: 한 종목의 상태를 한 봉씩 진행 (백테스트와 같은 규칙). 마지막 완성 봉 i에서 호출
  function liveDecide(F, id, p, i) { return STRATS[id].make(F, p)(i); }

  const Scalp = { STRATS, gridOf, features, align, simulate, liveDecide, trendAt, atr, H, M };
  if (typeof module !== "undefined" && module.exports) module.exports = Scalp;
  else root.Scalp = Scalp;
})(typeof window !== "undefined" ? window : globalThis);
