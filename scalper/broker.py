"""모의매매 브로커. 실제 주문 없이 수수료·슬리피지를 반영해 체결을 흉내냄.
상태(잔고·포지션)는 JSON으로 저장돼서 PC를 껐다 켜도 이어서 진행됨."""
import csv
import json
import os
from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


TRADE_FIELDS = [
    "symbol", "entry_time", "exit_time", "entry_price", "exit_price",
    "qty", "cost", "proceeds", "pnl", "pnl_pct", "reason",
]


class PaperBroker:
    def __init__(self, starting_cash, fee_rate=0.001, slippage_bps=5,
                 state_path=None, trades_path=None):
        self.starting_cash = float(starting_cash)
        self.fee_rate = float(fee_rate)
        self.slip = float(slippage_bps) / 10_000
        self.state_path = state_path
        self.trades_path = trades_path

        self.cash = self.starting_cash
        self.positions = {}
        self.trades = []
        self.n_trades = 0
        self.n_wins = 0
        self.realized_pnl = 0.0
        self._load()

    # ---------- 저장/복구 ----------
    def _load(self):
        if not self.state_path or not os.path.exists(self.state_path):
            return
        with open(self.state_path, encoding="utf-8") as f:
            s = json.load(f)
        self.cash = s["cash"]
        self.positions = s["positions"]
        self.n_trades = s.get("n_trades", 0)
        self.n_wins = s.get("n_wins", 0)
        self.realized_pnl = s.get("realized_pnl", 0.0)
        self.starting_cash = s.get("starting_cash", self.starting_cash)

    def save(self):
        if not self.state_path:
            return
        os.makedirs(os.path.dirname(self.state_path) or ".", exist_ok=True)
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({
                "starting_cash": self.starting_cash, "cash": self.cash,
                "positions": self.positions, "n_trades": self.n_trades,
                "n_wins": self.n_wins, "realized_pnl": self.realized_pnl,
                "updated": _now(),
            }, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.state_path)

    def _log_trade(self, t):
        self.trades.append(t)
        if not self.trades_path:
            return
        os.makedirs(os.path.dirname(self.trades_path) or ".", exist_ok=True)
        new = not os.path.exists(self.trades_path)
        with open(self.trades_path, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=TRADE_FIELDS)
            if new:
                w.writeheader()
            w.writerow(t)

    # ---------- 매매 ----------
    def buy(self, symbol, price, quote_amount, candle_ts, when=None):
        quote_amount = min(float(quote_amount), self.cash)
        fill = price * (1 + self.slip)
        fee = quote_amount * self.fee_rate
        qty = (quote_amount - fee) / fill
        self.cash -= quote_amount
        pos = {
            "qty": qty, "entry_price": fill, "cost": quote_amount,
            "entry_time": when or _now(), "entry_candle_ts": int(candle_ts),
        }
        self.positions[symbol] = pos
        self.save()
        return pos

    def sell(self, symbol, price, reason, when=None):
        pos = self.positions.pop(symbol)
        fill = price * (1 - self.slip)
        gross = pos["qty"] * fill
        proceeds = gross - gross * self.fee_rate
        self.cash += proceeds
        pnl = proceeds - pos["cost"]
        self.n_trades += 1
        self.n_wins += pnl > 0
        self.realized_pnl += pnl
        t = {
            "symbol": symbol, "entry_time": pos["entry_time"],
            "exit_time": when or _now(), "entry_price": pos["entry_price"],
            "exit_price": fill, "qty": pos["qty"], "cost": pos["cost"],
            "proceeds": proceeds, "pnl": pnl, "pnl_pct": pnl / pos["cost"],
            "reason": reason,
        }
        self._log_trade(t)
        self.save()
        return t

    def equity(self, prices):
        val = self.cash
        for sym, pos in self.positions.items():
            val += pos["qty"] * prices.get(sym, pos["entry_price"])
        return val
