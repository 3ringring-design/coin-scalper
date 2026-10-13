"""백테스트 엔진: 실전 봇과 같은 전략·브로커 코드로 과거 캔들을 재생."""
from datetime import datetime, timezone

import pandas as pd

from .broker import PaperBroker
from .strategy import StrategyParams, add_indicators, entry_signal, exit_signal


def _iso(ts):
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(timespec="minutes")


def simulate(df, p: StrategyParams, symbol="SYM", starting_cash=1000.0, fee_rate=0.001,
             slippage_bps=5, position_pct=0.25, cooldown_bars=3, min_order=10.0):
    ind = add_indicators(df.reset_index(drop=True), p)
    rows = ind.to_dict("records")
    broker = PaperBroker(starting_cash, fee_rate, slippage_bps)
    entry_i, last_exit_i = None, -10**9
    equity = []

    for i in range(p.warmup, len(rows)):
        r = rows[i]
        # 진입: 직전 마감 캔들 신호 → 이번 캔들 시가에 매수
        if entry_i is None and i - last_exit_i > cooldown_bars and entry_signal(rows[i - 1], p):
            size = min(broker.equity({symbol: r["open"]}) * position_pct, broker.cash)
            if size >= min_order:
                broker.buy(symbol, r["open"], size, rows[i - 1]["ts"], when=_iso(r["ts"]))
                entry_i = i
        # 청산: 이번 캔들의 고가/저가로 손절·익절 판정
        if entry_i is not None:
            pos = broker.positions[symbol]
            res = exit_signal(pos["entry_price"], i - entry_i, r["high"], r["low"],
                              r["close"], r["bb_mid"], p)
            if res:
                reason, px = res
                broker.sell(symbol, px, reason, when=_iso(r["ts"]))
                entry_i, last_exit_i = None, i
        equity.append(broker.equity({symbol: r["close"]}))

    if entry_i is not None:
        broker.sell(symbol, rows[-1]["close"], "end_of_data", when=_iso(rows[-1]["ts"]))
        equity[-1] = broker.equity({})

    eq = pd.Series(equity, dtype=float)
    trades = pd.DataFrame(broker.trades)
    wins = trades[trades["pnl"] > 0]["pnl"].sum() if len(trades) else 0.0
    losses = -trades[trades["pnl"] <= 0]["pnl"].sum() if len(trades) else 0.0
    start_px = rows[p.warmup]["close"] if len(rows) > p.warmup else float("nan")
    stats = {
        "trades": len(trades),
        "win_rate": float((trades["pnl"] > 0).mean()) if len(trades) else 0.0,
        "total_return": (eq.iloc[-1] / starting_cash - 1) if len(eq) else 0.0,
        "max_drawdown": float((eq / eq.cummax() - 1).min()) if len(eq) else 0.0,
        "profit_factor": (wins / losses) if losses > 0 else float("inf"),
        "buy_hold_return": rows[-1]["close"] / start_px - 1,
    }
    return stats, trades, eq
