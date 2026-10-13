#!/usr/bin/env bash
# 맥/리눅스용: 봇이 오류로 꺼져도 10초 뒤 자동으로 다시 켭니다.
cd "$(dirname "$0")/.."
[ -f .venv/bin/activate ] && source .venv/bin/activate
# 맥이면 실행 중 잠자기 방지
if command -v caffeinate >/dev/null 2>&1; then CAF="caffeinate -i"; else CAF=""; fi
while true; do
  $CAF python run.py
  echo "봇이 종료됨. 10초 뒤 재시작... (완전히 끄려면 Ctrl+C 두 번)"
  sleep 10
done
