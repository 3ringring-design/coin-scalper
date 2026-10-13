"""텔레그램 알림 (선택). .env에 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID가 있으면 켜짐."""
import logging
import os

import requests

log = logging.getLogger("scalper")


class Notifier:
    def __init__(self, token=None, chat_id=None):
        self.token = token
        self.chat_id = chat_id

    @classmethod
    def from_env(cls):
        return cls(os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID"))

    @property
    def enabled(self):
        return bool(self.token and self.chat_id)

    def send(self, text):
        if not self.enabled:
            return
        try:
            requests.post(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                json={"chat_id": self.chat_id, "text": text},
                timeout=10,
            )
        except Exception as e:  # 알림 실패가 봇을 멈추면 안 됨
            log.warning("텔레그램 전송 실패: %s", e)
