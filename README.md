# 🪙 Coin Scalper

바이낸스 현물 5분봉 단타 봇. 지금은 **모의매매(paper) 전용**이라 실제 주문은 나가지 않습니다.
공개 시세만 쓰기 때문에 API 키 없이 바로 돌려볼 수 있어요.

## 🌐 웹으로 실행하기 (설치 없음)

👉 **https://3ringring-design.github.io/coin-scalper/**

- 크롬으로 열고 **▶ 시작**을 누르면 모의매매가 돌아가요. 탭을 열어두는 동안 계속 실행돼요.
- **백테스트** 탭에서 최근 N일 성과를 바로 확인할 수 있어요.
- 잔고·거래내역은 브라우저에 저장돼서 새로고침하거나 다시 열어도 이어서 진행돼요.
- **📋 상황 복사** 버튼을 누르고 Claude 채팅에 붙여넣으면 피드백하기 쉬워요.
- 시세는 `data-api.binance.vision`(바이낸스 공식 시세 전용 주소)을 먼저 쓰고, 막히면 다른 주소로 자동 전환해요.

`main`에 코드가 올라오면 1~2분 뒤 같은 주소에 자동 반영돼요(`.github/workflows/deploy-web.yml`).
웹 코드는 `web/index.html` 한 파일이고, 아래 파이썬 버전과 같은 전략 로직이에요(`tests/web_core.test.js`로 검증).

> 24시간 돌리려면 PC 절전 모드를 "안 함"으로 두고 탭을 닫지 마세요. 백그라운드 탭에서도 동작하지만, 화면 꺼짐 방지를 켜두면 더 안정적이에요.

---

아래는 파이썬으로 직접 돌리는 방법이에요 (선택).

## 전략 한눈에 보기

상승추세 속 **눌림목 평균회귀** (롱 전용)

| 구분 | 조건 |
|---|---|
| 진입 | 종가 > EMA200 **그리고** 종가 < 볼린저 하단(20, 2σ) **그리고** RSI(14) < 35 |
| 익절 | +1.0% |
| 손절 | −0.6% |
| 중심선 복귀 | 볼린저 중심선 회복 + 수익 0.3% 이상이면 정리 |
| 시간 청산 | 24캔들(2시간) 지나면 정리 |

모든 숫자는 `config.yaml`에서 바꿀 수 있어요. 수수료(0.1%×2)와 슬리피지를 반영해서 계산합니다.

## 설치 (처음 한 번)

Python 3.10 이상 필요.

```bash
cd coin-scalper
python -m venv .venv
# 윈도우: .venv\Scripts\activate    맥/리눅스: source .venv/bin/activate
pip install -r requirements.txt
```

## 1. 백테스트로 먼저 확인

```bash
python backtest.py --days 30              # config의 모든 종목
python backtest.py --symbol ETH/USDT --days 90
```

전략 수익률, 승률, 최대낙폭, 그냥 보유했을 때와 비교를 보여주고 거래내역을 `backtest_results/`에 저장해요.

## 2. 모의매매 실행

```bash
python run.py
```

- 로그: `logs/bot.log`
- 잔고·보유 포지션: `state/paper_state.json` (껐다 켜도 이어서 진행)
- 거래내역: `state/paper_trades.csv`
- 처음부터 다시 하려면 `state/` 폴더를 지우세요.

## 3. 집 PC에서 24시간 돌리기

- **윈도우**: `scripts\run_forever.bat` 더블클릭. 봇이 오류로 꺼져도 자동 재시작돼요.
  - 설정 → 시스템 → 전원 → **절전 모드: 안 함** 으로 바꿔두세요. PC가 잠들면 봇도 멈춰요.
  - 윈도우 업데이트 재부팅 대비: 작업 스케줄러에 "로그온 시 run_forever.bat 실행" 등록 추천.
- **맥/리눅스**: `bash scripts/run_forever.sh` (맥은 자동으로 잠자기 방지)

## 4. 텔레그램 알림 (선택)

1. 텔레그램에서 `@BotFather` → `/newbot` → 토큰 받기
2. 만든 봇에게 아무 메시지 보낸 뒤 `https://api.telegram.org/bot<토큰>/getUpdates` 에서 `chat.id` 확인
3. `.env.example`을 `.env`로 복사하고 두 값을 채우기

매수·매도할 때마다 휴대폰으로 알림이 와요.

## 5. 깃허브에 올리기

```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/<내아이디>/coin-scalper.git
git push -u origin main
```

`.env`, `state/`, `logs/`는 `.gitignore`에 들어 있어서 올라가지 않아요. **API 키는 절대 커밋하지 마세요.**
저장소는 Private으로 만드는 걸 추천해요.

## 테스트

```bash
pytest -q
```

## 폴더 구조

```
run.py               봇 실행
backtest.py          백테스트
config.yaml          모든 설정
scalper/
  indicators.py      EMA, RSI, 볼린저밴드
  strategy.py        진입/청산 규칙
  broker.py          모의 체결 (수수료·슬리피지 반영, 상태 저장)
  bot.py             24시간 루프
  backtest_engine.py 백테스트 엔진 (실전과 같은 전략 코드 사용)
  notifier.py        텔레그램 알림
scripts/             자동 재시작 실행 스크립트
tests/               단위 테스트
```

## 로드맵

- [x] 모의매매
- [ ] 1~2주 모의 결과 검토 → 파라미터 조정
- [ ] 실거래 모드 (바이낸스 API, 소액부터, 일일 손실 한도)

> ⚠️ 단타는 수수료 부담이 커서 백테스트에서 좋아 보여도 실전에선 손실이 날 수 있어요. 모의 결과가 충분히 쌓이기 전엔 실거래로 넘어가지 마세요.
