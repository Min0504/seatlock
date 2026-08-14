# Incident: Redis 전면 다운

**날짜:** 2026-08-14  
**환경:** 로컬 docker compose (`seatlock-dev-redis`) + Spring Boot `:8087`  
**가설:** 캐시는 보조 수단이다. Redis가 죽어도 좌석맵은 DB 직행으로 200, 선점은 조건부 UPDATE로 201이어야 한다.

## 재현

```bash
./bench/run-v4.sh          # 시드 후 자동 호출
# 또는 시드된 상태에서
LEAVE_DOWN=1 docs/chaos/redis-kill.sh
```

스크립트 순서:

1. 정상 좌석맵 조회 (대조군)
2. `docker stop seatlock-dev-redis`
3. 좌석맵 — **200이 아니면 실패**
4. 선점 POST — **201이 아니면 실패**
5. Redis를 내린 채로 두거나(`LEAVE_DOWN=1`) 다시 기동

## 결과

| 단계 | HTTP | 의미 |
|---|---|---|
| 다운 전 좌석맵 | 200 | 캐시 HIT 가능 |
| 다운 중 좌석맵 | **200** (500석) | CacheClient가 예외를 삼키고 DB 직행 |
| 다운 중 선점 | **201** | 정합성은 Redis와 무관 |

k6 200 RPS: HIT p95 **18.4ms** → 다운 중 p95 **688ms**, 200 비율 100%. 지연은 늘고 기능은 유지. 구성은 `tryGet` 실패 300ms + DB + `trySet` 실패 300ms.

## 원인

`CacheClient`의 모든 Redis 연산이 `try/catch`로 비어 있다. 좌석 상태의 진실은 `show_seats`의 조건부 UPDATE다. 캐시 키 삭제 유실은 TTL 5초 안전망이 상한을 보장한다.

## 조치 / 재발 방지

- 조치 없음 — 설계된 폴백이다. Redis를 다시 올리면 다음 조회가 캐시를 채운다.
- `connect-timeout`/`timeout` 300ms: Redis가 느릴 때 API가 같이 느려지지 않게 짧게 끊는다.
- 컨테이너 stop은 DNS가 사라질 수 있다. Lettuce는 명령 실패 후 빠르게 예외를 내고, 앱 재기동은 필요 없었다.

## 한계

이 카오스는 **캐시 계층**만 다룬다. DB 다운은 전면 장애이며 선점·결제가 모두 실패한다.
