"""exe(PyInstaller)로 실행될 때와 파이썬으로 실행될 때 모두 동작하도록 경로를 맞춤."""
import shutil
import sys
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)


def app_root() -> Path:
    """설정·기록 파일이 놓일 폴더 (exe면 exe가 있는 폴더)."""
    if FROZEN:
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def bundle_dir() -> Path:
    """exe 안에 같이 묶인 기본 파일 위치."""
    return Path(getattr(sys, "_MEIPASS", app_root()))


def ensure_config(root: Path) -> Path:
    """config.yaml이 없으면 기본 설정을 만들어 줌."""
    cfg = root / "config.yaml"
    if not cfg.exists():
        src = bundle_dir() / "config.yaml"
        if src.exists():
            shutil.copy(src, cfg)
    return cfg


def pause_if_frozen(msg="엔터를 누르면 창이 닫혀요..."):
    """더블클릭 실행 시 창이 바로 닫혀서 메시지를 못 보는 것 방지."""
    if FROZEN:
        try:
            input(msg)
        except EOFError:
            pass
