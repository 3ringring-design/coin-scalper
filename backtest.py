"""과거 데이터로 전략 성과 확인.
예) python backtest.py --days 30
    python backtest.py --symbol ETH/USDT --days 60
"""
import argparse
import sys
from pathlib import Path

import ccxt
import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scalper.app import app_root, ensure_config, pause_if_frozen  # noqa: E402
from scalper.backtest_engine import simulate  # noqa: E402
from scalper.strategy import StrategyParams  # noqa: E402

ROOT = app_root()


def fetch_history(ex, symbol, tf, days):
    tf_ms = ex.parse_timeframe(tf) * 1000
    now = ex.milliseconds()
    since = now - days * 86_400_000
    rows = []
    while since < now:
        batch = ex.fetch_ohlcv(symbol, tf, since=since, limit=1000)
        if not batch:
            break
        rows += batch
        since = batch[-1][0] + tf_ms
        if len(batch) < 1000:
            break
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    return df.drop_duplicates("ts").iloc[:-1].reset_index(drop=True)  # 진행 중 캔들 제외


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--symbol", help="한 종목만 (기본: config의 전체 종목)")
    ap.add_argument("--days", type=int, default=30)
    args = ap.parse_args()

    cfg_path = Path(args.config) if args.config else ensure_config(ROOT)
    with open(cfg_path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    print("과거 시세를 받아오는 중이에요. 잠시만 기다려 주세요...")
    p = StrategyParams(**cfg.get("strategy", {}))
    ex = ccxt.binance({"enableRateLimit": True})
    out_dir = ROOT / "backtest_results"
    out_dir.mkdir(exist_ok=True)

    symbols = [args.symbol] if args.symbol else cfg["symbols"]
    for sym in symbols:
        print(f"\n=== {sym} / {cfg['timeframe']} / 최근 {args.days}일 ===")
        df = fetch_history(ex, sym, cfg["timeframe"], args.days)
        stats, trades, _ = simulate(
            df, p, symbol=sym,
            starting_cash=cfg["paper"]["starting_cash"],
            fee_rate=cfg["paper"]["fee_rate"],
            slippage_bps=cfg["paper"]["slippage_bps"],
            position_pct=1.0,  # 단일 종목 테스트라 전액 기준으로 수익률 계산
            cooldown_bars=cfg["risk"]["cooldown_bars"],
        )
        print(f"캔들 {len(df)}개 | 거래 {stats['trades']}회 | 승률 {stats['win_rate']*100:.1f}%")
        print(f"전략 수익률 {stats['total_return']*100:+.2f}% | 최대낙폭 {stats['max_drawdown']*100:.2f}% "
              f"| 손익비 {stats['profit_factor']:.2f}")
        print(f"(비교) 그냥 보유했을 때 {stats['buy_hold_return']*100:+.2f}%")
        if len(trades):
            print("청산 사유:", trades["reason"].value_counts().to_dict())
            path = out_dir / f"{sym.replace('/', '_')}_trades.csv"
            trades.to_csv(path, index=False)
            print(f"거래내역 → {path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n오류가 났어요: {e!r}")
    pause_if_frozen("\n끝났어요. 엔터를 누르면 창이 닫혀요...")
