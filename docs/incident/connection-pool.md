# Incident: DB 커넥션 풀 고갈

**날짜:** 2026-08-14  
**환경:** 로컬 Spring Boot, HikariCP  
**가설:** 풀이 비면 요청이 무한 대기하면 안 된다. timeout 안에 못 받으면 503으로 거절해 호출자가 백오프한다.

## 왜 기본값을 바꿨나

Hikari 기본 `connection-timeout`은 30초다. 오픈 순간 선점 요청이 풀을 채우면 **관계없는 조회·결제까지 30초를 기다린다.** 기획서 §10 장애 3의 조치가 "짧게 끊고 503"인 이유다.

운영 기본 (`application.yml`):

| 변수 | 값 | 이유 |
|---|---|---|
| `HIKARI_MAX_POOL` | 10 | 벤치마크·단일 인스턴스 실측과 동일. 키우려면 아래 재현으로 근거를 남긴다 |
| `HIKARI_CONNECTION_TIMEOUT_MS` | 3000 | 3초 안에 못 받으면 503. Hikari 하한은 250ms |

예외는 `GlobalExceptionHandler`가 `SQLTransientConnectionException` / `CannotGetJdbcConnectionException`(원인 포함)을 `SERVICE_UNAVAILABLE`로 번역한다. 기본 500 INTERNAL_ERROR로 두면 클라이언트가 재시도 여부를 못 가른다.

## 재현

```bash
# run-v4.sh 7단계와 동일
HIKARI_MAX_POOL=2 HIKARI_CONNECTION_TIMEOUT_MS=500 PORT=8087 ... bootRun
k6 run bench/pool-exhaust.js   # 300 VU 동시 선점
```

| 결과 | 건수 |
|---|---:|
| 처리됨 (201 선점 / 409 충돌) | 238 |
| **503 SERVICE_UNAVAILABLE** | **62** |
| p95 | 905 ms |

500ms 안에 커넥션을 받은 요청만 일을 하고, 나머지는 기다리지 않고 거절됐다.

## 같이 얻은 부수 사실

**`HIKARI_MAX_POOL=1` 로는 부팅이 실패한다.** Flyway 마이그레이션이 풀에서 커넥션을 하나 붙잡은 채로 또 하나를 요청하기 때문이다 (`total=1, active=1, waiting=0`, timeout 후 기동 중단). 풀 크기의 실측 하한은 "마이그레이션과 헬스체크가 동시에 살아 있으려면 2"다. 1로 줄여 고갈을 재현하려다 앱이 안 뜨는 함정.

## 조치

- 운영 기본 timeout 3초 + 503 계약을 코드에 고정했다.
- 풀을 키우는 조건: 503이 **정상 부하**(오픈 피크)에서 반복될 때. 이번 재현은 풀 2칸에 300명이라는 의도적 압박이라 운영 기본 10을 당장 올릴 근거는 못 된다.
- 오픈 피크의 진짜 병목은 풀보다 핫 좌석 행 락이다 — 1,000 VU / 10석에서도 5xx는 0, 지연만 늘었다 ([k6.md](../perf/k6.md)).

## 재발 방지

- 커넥션 타임아웃을 다시 30초로 되돌리지 않는다.
- 풀 크기 변경은 이 스크립트로 전후 p95·503 비율을 남긴다.
