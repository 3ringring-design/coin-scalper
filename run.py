"""봇 실행: python run.py  (또는 CoinScalper.exe 더블클릭)"""
import argparse
import logging
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import yaml  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

from scalper.app import app_root, ensure_config, pause_if_frozen  # noqa: E402
from scalper.bot import Bot  # noqa: E402

ROOT = app_root()


def setup_logging():
    (ROOT / "logs").mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(ROOT / "logs" / "bot.log", maxBytes=5_000_000,
                             backupCount=5, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    log = logging.getLogger("scalper")
    log.setLevel(logging.INFO)
    log.addHandler(fh)
    log.addHandler(sh)
    return log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    args = ap.parse_args()

    log = setup_logging()
    cfg_path = Path(args.config) if args.config else ensure_config(ROOT)
    if not cfg_path.exists():
        log.error("설정 파일을 찾을 수 없어요: %s", cfg_path)
        pause_if_frozen()
        sys.exit(1)

    load_dotenv(ROOT / ".env")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    if cfg.get("mode") != "paper":
        log.error("지금은 mode: paper 만 지원해요. (실거래는 모의 검증 후 추가 예정)")
        pause_if_frozen()
        sys.exit(1)

    log.info("끄려면 Ctrl + C 를 누르세요.")
    bot = None
    while True:  # 예상 못 한 오류가 나도 스스로 다시 시작
        try:
            bot = Bot(cfg, ROOT)
            bot.run()
        except KeyboardInterrupt:
            if bot:
                bot.broker.save()
                log.info("종료합니다.\n%s", bot.status())
            break
        except Exception:
            log.exception("예상치 못한 오류 — 30초 후 자동 재시작")
            try:
                time.sleep(30)
            except KeyboardInterrupt:
                break


if __name__ == "__main__":
    main()
