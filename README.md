# SeatLock — 좌석 선점형 공연 예매 시스템

> 인기 공연 오픈 순간 수백 명이 같은 좌석에 몰려도 **초과판매 0건**을 보장하는 예매 API.
> 동시성 문제를 **일부러 재현하고 → 4가지 방법으로 해결해 비교하고 → 테스트·부하로 수치 검증**하는 전 과정을 담았습니다.
> 같은 도메인을 **NestJS로 완성한 뒤 Java 17 / Spring Boot 3로 포팅**하여, 프레임워크가 바뀌어도 유지되는 것(도메인 규칙·SQL·트랜잭션 경계)과 바뀌는 것(DI·ORM·미들웨어)을 비교합니다.

## 핵심 숫자

| 검증 항목 | 결과 |
|-----------|------|
| 동시 100명이 같은 좌석 선점 | **성공 정확히 1건, 초과판매 0** (통합 테스트로 강제) |
| **1,000 VU × 좌석 10** | **성공 정확히 10, 409 990, 5xx 0** — [k6](docs/perf/k6.md) |
| 락 전략 4종 부하 비교 (k6) | 조건부 UPDATE p95 **34ms** vs 비관적 락 52ms·컨보이 929ms — [분석](docs/lock-benchmark.md) |
| 좌석맵 200 RPS | 캐시 HIT p95 **7.2ms** / Redis 다운 폴백 **31ms** (기능 유지) |
| 결제 멱등 동시 50 | 실행 **1건**, `payments` 행 1, 나머지 409/200 |
| 결제 멱등성 (테스트) | 같은 키 연타 → 결제 1건 (10개 시나리오: 재생·422·동시 409·PG 타임아웃 복구·보상) |
| 통합 테스트 | Spring 44개 + Nest e2e 전체 — 실 PostgreSQL 16·Redis 7 (Testcontainers) |

## 빠른 실행

```bash
docker compose up -d --build   # postgres + redis + backend(Spring) + frontend(nginx)
scripts/seed-demo.sh           # 데모 데이터 (관리자·공연 3편·좌석 96석)
open http://localhost:8090     # 좌석맵 SPA — 창 2개로 같은 좌석을 동시에 잡아보세요
```

Swagger: <http://localhost:18080/docs> · 관리자 `admin@seatlock.io` / `password1234`

## 무엇을 해결했나 (문제 → 해결 → 증거)

| 문제 | 해결 | 증거 (PR) |
|------|------|-----------|
| 같은 좌석이 두 명에게 팔림 (check-then-act race) | `WHERE status='AVAILABLE'` **조건부 UPDATE 한 문장**으로 검사+변경 원자화 | [#2](../../pull/2) 재현 테스트 → 해결 |
| 선점 후 이탈한 유령 좌석 | **3중 방어** — 조회 시 lazy 판정 + 선점 시 인수 + 30초 스위퍼 | [#3](../../pull/3) |
| 결제 이중 처리 | `Idempotency-Key` **DB UNIQUE 선점** + 요청 해시 검증 + PG 타임아웃 상태 조회 복구 | [#4](../../pull/4), Spring 포팅 [#9](../../pull/9) |
| Refresh 토큰 탈취 | **Rotation + 재사용 탐지** — 소모된 토큰 재사용 시 로그인 단위(family) 전체 폐기 | [#5](../../pull/5) |
| 오픈 순간 조회 폭주 | 좌석맵 Redis 캐시(TTL 5s) + **커밋 후 무효화**, pg_trgm 검색, 통계 캐시 | [#6](../../pull/6) |
| "다른 락이면 어땠을까" | 비관적·낙관적·Redis 분산락을 **전부 구현해 k6로 측정** — 채택 근거를 수치로 | [#9](../../pull/9) · [docs/lock-benchmark.md](docs/lock-benchmark.md) |
| 오픈 순간 1,000명이 10석에 몰림 · Redis 다운 · 풀 고갈 | k6로 초과판매 0 증명, 캐시 폴백 200, Hikari 3초 타임아웃 후 503 | [k6](docs/perf/k6.md) · [incident](docs/incident/) |

## 락 전략 비교 — 이 프로젝트의 중심 실험

같은 `hold` API를 4가지 동시성 제어로 구현하고 동일 부하(k6)로 측정했다. **실험 브랜치는 머지하지 않고 보존한다.**

| 전략 | 브랜치 | 정상상태 p95 | 특징 |
|------|--------|-------------:|------|
| 조건부 UPDATE (**채택**) | `main` | **34ms** | 대기 없음, 인프라 추가 없음, 정합성에 전제 조건 없음 |
| 비관적 락 (`FOR UPDATE`) | [`experiment/pessimistic-lock`](../../tree/experiment/pessimistic-lock) | 52ms | 잠금 보유 구간 최장 — 컨보이 929ms, 처리량 -23% |
| 낙관적 락 (`@Version`) | [`experiment/optimistic-lock`](../../tree/experiment/optimistic-lock) | 34ms | 충돌이 기본값인 티케팅과 전제 불일치 (재시도 증폭) |
| Redis 분산락 (Redisson) | [`experiment/redis-lock`](../../tree/experiment/redis-lock) | 38ms | 패자를 DB 앞에서 차단 (극단 경합 카드), 승자 +8ms |

방법론·원본 데이터·전략별 분석: [docs/lock-benchmark.md](docs/lock-benchmark.md)

## 저장소 구조

```text
seatlock/
├── backend/        # Spring Boot 3 구현 (v3~, 최종형)
├── backend-nest/   # NestJS 구현 (v1~v2) — Spring 포팅 완료 시점에 커밋 동결, 비교용 보존
├── frontend/       # 좌석맵 SPA (Vite + React + TS strict) — 시연용
├── bench/          # k6 부하 시나리오 + 측정 원본 데이터 (bench/out)
├── scripts/        # 데모 시드
└── docs/           # 기획서 · 아키텍처 · 락 벤치마크
```

## 문서

| 문서 | 내용 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | ERD, 좌석 상태 기계, 결제 시퀀스와 트랜잭션 경계, 3중 만료 방어, Spring↔Nest 모듈 맵 |
| [docs/lock-benchmark.md](docs/lock-benchmark.md) | 락 4종 벤치마크 — 방법론(한계 포함), 결과, 전략별 분석, 채택 근거 |
| [docs/perf/k6.md](docs/perf/k6.md) | 기획서 §8 k6 3종 — 초과판매 0, 좌석맵 캐시, 결제 멱등 + 풀 고갈 |
| [docs/incident/redis-down.md](docs/incident/redis-down.md) | Redis 다운 카오스 — 좌석맵 200·선점 201 |
| [docs/incident/connection-pool.md](docs/incident/connection-pool.md) | Hikari 풀 고갈 → 503, timeout 3초 근거 |
| [docs/기획서.md](docs/기획서.md) | 전체 기획 — 문제 정의, 설계 판단 기록, 로드맵 |

## 개발

```bash
# 개발 인프라 (postgres :55432, redis :63790)
cd backend-nest && docker compose -f docker-compose.dev.yml up -d

# Spring (학습의 본체)
cd backend && ./gradlew test          # 통합 테스트 44개 (Testcontainers 자체 기동)
cd backend && ./gradlew bootRun       # :8080, Swagger /docs

# NestJS (동결 — 참고용)
cd backend-nest && npm ci && npm run test:e2e

# 프론트 (백엔드 기동 상태에서)
cd frontend && npm ci && npm run dev  # :5173, /api → :8080 프록시

# 락 벤치마크 재현
bench/run.sh conditional-update       # 브랜치 체크아웃 후 라벨만 바꿔 반복
./bench/run-v4.sh                     # 기획서 §8 k6 3종 + Redis 카오스 + 풀 고갈
```

기여 규칙: 핵심 문제 1개 = 브랜치 1개 = PR 1개, **CI 초록 없이 머지 금지**, 백엔드 커밋은 1커밋 = 1개념.
