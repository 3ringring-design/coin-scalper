"""매매 전략: 상승추세 속 눌림목 평균회귀 (롱 전용).

진입 (직전에 '마감된' 캔들 기준, 세 조건 모두 충족):
  1. 종가 > EMA(200)          → 큰 흐름이 상승추세일 때만
  2. 종가 < 볼린저 하단        → 단기적으로 과하게 빠졌을 때
  3. RSI(14) < rsi_entry      → 과매도 확인

청산 (먼저 걸리는 것):
  - 손절: 진입가 대비 -stop_loss_pct
  - 익절: 진입가 대비 +take_profit_pct
  - 중심선 복귀: 가격이 볼린저 중심선 위로 + 최소 수익(mid_exit_min_pct) 이상
  - 시간 청산: max_hold_bars 캔들이 지나도 안 풀리면 정리
"""
from dataclasses import dataclass

import pandas as pd

from .indicators import bollinger, ema, rsi


@dataclass
class StrategyParams:
    ema_trend: int = 200
    bb_period: int = 20
    bb_std: float = 2.0
    rsi_period: int = 14
    rsi_entry: float = 35.0
    take_profit_pct: float = 0.010
    stop_loss_pct: float = 0.006
    max_hold_bars: int = 24
    mid_exit: bool = True
    mid_exit_min_pct: float = 0.003

    @property
    def warmup(self) -> int:
        # EMA가 충분히 수렴하도록 넉넉히
        return max(self.ema_trend * 2, self.bb_period, self.rsi_period * 5)


def add_indicators(df: pd.DataFrame, p: StrategyParams) -> pd.DataFrame:
    out = df.copy()
    out["ema_trend"] = ema(out["close"], p.ema_trend)
    mid, up, low = bollinger(out["close"], p.bb_period, p.bb_std)
    out["bb_mid"], out["bb_up"], out["bb_low"] = mid, up, low
    out["rsi"] = rsi(out["close"], p.rsi_period)
    return out


def entry_signal(row, p: StrategyParams) -> bool:
    vals = (row["close"], row["ema_trend"], row["bb_low"], row["rsi"])
    if any(pd.isna(v) for v in vals):
        return False
    return (
        row["close"] > row["ema_trend"]
        and row["close"] < row["bb_low"]
        and row["rsi"] < p.rsi_entry
    )


def exit_signal(entry_price, bars_held, high, low, close, bb_mid, p: StrategyParams):
    """청산 사유와 기준 가격을 돌려줌. 청산 아니면 None.
    한 캔들 안에서 손절·익절이 동시에 닿으면 보수적으로 손절로 처리."""
    sl = entry_price * (1 - p.stop_loss_pct)
    tp = entry_price * (1 + p.take_profit_pct)
    if low <= sl:
        return "stop_loss", sl
    if high >= tp:
        return "take_profit", tp
    if (
        p.mid_exit
        and not pd.isna(bb_mid)
        and close >= bb_mid
        and close >= entry_price * (1 + p.mid_exit_min_pct)
    ):
        return "mid_band", close
    if bars_held >= p.max_hold_bars:
        return "time_exit", close
    return None
