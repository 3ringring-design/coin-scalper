import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scalper.backtest_engine import simulate  # noqa: E402
from scalper.broker import PaperBroker  # noqa: E402
from scalper.indicators import bollinger, rsi  # noqa: E402
from scalper.strategy import StrategyParams, exit_signal  # noqa: E402


def synthetic(n=3000, seed=0):
    rng = np.random.default_rng(seed)
    ret = rng.normal(0.0002, 0.004, n)
    close = 100 * np.exp(np.cumsum(ret))
    open_ = np.r_[close[0], close[:-1]]
    high = np.maximum(open_, close) * (1 + rng.uniform(0, 0.002, n))
    low = np.minimum(open_, close) * (1 - rng.uniform(0, 0.002, n))
    ts = np.arange(n) * 300_000
    return pd.DataFrame({"ts": ts, "open": open_, "high": high, "low": low,
                         "close": close, "volume": 1.0})


def test_indicators_range():
    df = synthetic()
    r = rsi(df["close"]).dropna()
    assert ((r >= 0) & (r <= 100)).all()
    mid, up, low = bollinger(df["close"])
    assert (up.dropna() >= low.dropna()).all()


def test_exit_priority():
    p = StrategyParams()
    # 같은 캔들에서 손절·익절 둘 다 닿으면 손절
    assert exit_signal(100, 0, 102, 99, 100, 100, p)[0] == "stop_loss"
    assert exit_signal(100, 0, 101.5, 99.9, 100, 105, p)[0] == "take_profit"
    assert exit_signal(100, 0, 100.5, 99.9, 100.4, 100.2, p)[0] == "mid_band"
    assert exit_signal(100, 24, 100.1, 99.9, 100.0, 101, p)[0] == "time_exit"
    assert exit_signal(100, 3, 100.1, 99.9, 100.0, 101, p) is None


def test_broker_fees():
    b = PaperBroker(1000, fee_rate=0.001, slippage_bps=0)
    b.buy("X", 100, 1000, 0)
    t = b.sell("X", 100, "test")
    assert abs(t["pnl"] - (-1.999)) < 1e-6  # 왕복 수수료만큼 손실
    assert abs(b.cash - 998.001) < 1e-6


def test_simulate_runs():
    stats, trades, eq = simulate(synthetic(), StrategyParams(), position_pct=1.0)
    assert stats["trades"] > 0
    assert len(eq) > 0
    assert set(trades["reason"]) <= {"stop_loss", "take_profit", "mid_band", "time_exit", "end_of_data"}
