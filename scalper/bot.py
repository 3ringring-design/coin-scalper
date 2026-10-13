"""24시간 메인 루프. 바이낸스 공개 시세(API 키 불필요)로 모의매매."""
import logging
import time
from datetime import datetime, timezone

import ccxt
import pandas as pd

from .broker import PaperBroker
from .notifier import Notifier
from .strategy import StrategyParams, add_indicators, entry_signal, exit_signal

log = logging.getLogger("scalper")

REASON_KO = {
    "stop_loss": "손절", "take_profit": "익절",
    "mid_band": "중심선 복귀", "time_exit": "시간 청산",
}


class Bot:
    def __init__(self, cfg, root):
        self.cfg = cfg
        self.p = StrategyParams(**cfg.get("strategy", {}))
        self.symbols = cfg["symbols"]
        self.tf = cfg["timeframe"]
        self.tf_ms = ccxt.Exchange.parse_timeframe(self.tf) * 1000
        self.poll = cfg.get("poll_seconds", 15)
        self.candles_limit = cfg.get("candles_limit", 500)
        self.risk = cfg["risk"]

        self.exchange = ccxt.binance({
            "enableRateLimit": True,
            "options": {"defaultType": "spot"},
        })
        paper = cfg["paper"]
        self.broker = PaperBroker(
            starting_cash=paper["starting_cash"],
            fee_rate=paper["fee_rate"],
            slippage_bps=paper["slippage_bps"],
            state_path=str(root / "state" / "paper_state.json"),
            trades_path=str(root / "state" / "paper_trades.csv"),
        )
        self.notifier = Notifier.from_env()
        self.prices = {}
        self.last_eval = {}
        self.last_exit = {}

    # ---------- 데이터 ----------
    def fetch(self, symbol):
        raw = self.exchange.fetch_ohlcv(symbol, self.tf, limit=self.candles_limit)
        return pd.DataFrame(raw, columns=["ts", "open", "high", "low", "close", "volume"])

    # ---------- 한 종목 처리 ----------
    def step(self, symbol):
        df = self.fetch(symbol)
        if len(df) < self.p.warmup + 1:
            log.warning("%s 캔들 부족 (%d개)", symbol, len(df))
            return

        price = float(df["close"].iloc[-1])  # 진행 중 캔들의 현재가
        self.prices[symbol] = price
        closed = add_indicators(df.iloc[:-1], self.p)  # 마감된 캔들만 신호에 사용
        last = closed.iloc[-1]
        last_ts = int(last["ts"])

        pos = self.broker.positions.get(symbol)
        if pos:
            bars_held = (last_ts - pos["entry_candle_ts"]) // self.tf_ms
            res = exit_signal(pos["entry_price"], bars_held, price, price, price,
                              last["bb_mid"], self.p)
            if res:
                reason, _ = res
                t = self.broker.sell(symbol, price, reason)
                self.last_exit[symbol] = last_ts
                msg = (f"[모의] 매도 {symbol} {REASON_KO.get(reason, reason)} "
                       f"@ {t['exit_price']:.4f} | 손익 {t['pnl']:+.2f} USDT "
                       f"({t['pnl_pct']*100:+.2f}%)")
                log.info(msg)
                self.notifier.send(msg)
            return

        # 진입 판단은 캔들 하나당 한 번만
        if self.last_eval.get(symbol) == last_ts:
            return
        self.last_eval[symbol] = last_ts

        le = self.last_exit.get(symbol)
        if le is not None and (last_ts - le) // self.tf_ms < self.risk["cooldown_bars"]:
            return
        if not entry_signal(last, self.p):
            return
        if len(self.broker.positions) >= self.risk["max_positions"]:
            log.info("%s 신호 발생했지만 최대 포지션 수 도달", symbol)
            return

        equity = self.broker.equity(self.prices)
        size = min(equity * self.risk["position_pct"], self.broker.cash)
        if size < self.risk["min_order_usdt"]:
            log.info("%s 신호 발생했지만 잔고 부족", symbol)
            return

        pos = self.broker.buy(symbol, price, size, last_ts)
        msg = (f"[모의] 매수 {symbol} @ {pos['entry_price']:.4f} | "
               f"{size:.2f} USDT (RSI {last['rsi']:.1f})")
        log.info(msg)
        self.notifier.send(msg)

    # ---------- 상태 출력 ----------
    def status(self):
        b = self.broker
        eq = b.equity(self.prices)
        ret = (eq / b.starting_cash - 1) * 100
        wr = (b.n_wins / b.n_trades * 100) if b.n_trades else 0
        lines = [f"자산 {eq:.2f} USDT ({ret:+.2f}%) | 현금 {b.cash:.2f} | "
                 f"거래 {b.n_trades}회 승률 {wr:.0f}%"]
        for sym, pos in b.positions.items():
            px = self.prices.get(sym, pos["entry_price"])
            lines.append(f"  보유 {sym} 진입 {pos['entry_price']:.4f} → 현재 {px:.4f} "
                         f"({(px / pos['entry_price'] - 1) * 100:+.2f}%)")
        return "\n".join(lines)

    # ---------- 무한 루프 ----------
    def run(self):
        log.info("모의매매 시작: %s / %s / %d초 간격", ", ".join(self.symbols), self.tf, self.poll)
        self.notifier.send("🤖 모의매매 봇 시작")
        status_every = self.cfg.get("status_every_minutes", 30) * 60
        last_status = 0.0
        while True:
            t0 = time.time()
            for s in self.symbols:
                try:
                    self.step(s)
                except ccxt.NetworkError as e:
                    log.warning("%s 네트워크 오류 (다음 루프에서 재시도): %s", s, e)
                except ccxt.BaseError as e:
                    log.error("%s 거래소 오류: %s", s, e)
                except Exception:
                    log.exception("%s 처리 중 예외", s)
            if time.time() - last_status >= status_every:
                log.info(self.status())
                last_status = time.time()
            time.sleep(max(1.0, self.poll - (time.time() - t0)))
