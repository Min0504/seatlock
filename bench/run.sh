#!/usr/bin/env bash
# 락 전략 벤치마크 러너 — 현재 체크아웃된 브랜치의 hold 구현을 측정한다.
#
# 사용법:  bench/run.sh <label>
#   예)    git checkout experiment/pessimistic-lock && bench/run.sh pessimistic-lock
#
# 하는 일: 벤치 전용 DB 재생성 → 앱 빌드·기동 → 시드(회차 1개·좌석 500·사용자 100)
#          → k6 실행 → bench/out/<label>-summary.json 저장 → 앱 종료.
# 전제:    dev postgres 컨테이너(backend-nest/docker-compose.dev.yml)와 k6, jq.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="${1:?사용법: bench/run.sh <label> (예: conditional-update)}"
PORT="${PORT:-8087}"
BASE_URL="http://localhost:${PORT}"
PG_CONTAINER="${PG_CONTAINER:-seatlock-dev-postgres}"
DB_NAME=seatlock_bench
PASSWORD=password1234

echo "── 1/5 벤치 DB 재생성 ($DB_NAME)"
docker exec "$PG_CONTAINER" psql -U seatlock -d postgres -qc "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null
docker exec "$PG_CONTAINER" psql -U seatlock -d postgres -qc "CREATE DATABASE $DB_NAME" >/dev/null

echo "── 2/5 앱 빌드·기동 (:$PORT)"
(cd backend && ./gradlew -q bootJar)
DATABASE_URL="jdbc:postgresql://localhost:55432/$DB_NAME" \
JWT_ACCESS_SECRET="bench-access-secret-must-be-32-bytes!" \
JWT_REFRESH_SECRET="bench-refresh-secret-must-be-32-byte!" \
PORT="$PORT" \
java -jar backend/build/libs/seatlock-*.jar >/tmp/seatlock-bench.log 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -sf "$BASE_URL/actuator/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$BASE_URL/actuator/health" >/dev/null || { echo "앱 기동 실패 — /tmp/seatlock-bench.log 확인"; exit 1; }

echo "── 3/5 시드 (admin·좌석 500·사용자 100 — bcrypt 때문에 1분쯤 걸린다)"
mkdir -p bench/out
json() { curl -sf -X "$1" "$BASE_URL$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} -d "$4"; }

json POST /auth/signup '' "{\"email\":\"admin@bench.io\",\"password\":\"$PASSWORD\"}" >/dev/null
docker exec "$PG_CONTAINER" psql -U seatlock -d "$DB_NAME" -qc \
  "UPDATE users SET role='ADMIN' WHERE email='admin@bench.io'" >/dev/null
ADMIN=$(json POST /auth/login '' "{\"email\":\"admin@bench.io\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken)

SEATS=$(jq -n '[range(1; 501) | {section: "A", rowNo: "1", seatNo: .}]')
VENUE_ID=$(json POST /admin/venues "$ADMIN" "{\"name\":\"벤치홀\",\"address\":\"서울\",\"seats\":$SEATS}" | jq -r .id)
PERF_ID=$(json POST /admin/performances "$ADMIN" "{\"title\":\"락 벤치마크\",\"venueId\":$VENUE_ID}" | jq -r .id)
STARTS_AT=$(date -u -v+30d +%Y-%m-%dT%H:%M:%SZ)
OPEN_AT=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)
SHOW_ID=$(json POST /admin/shows "$ADMIN" \
  "{\"performanceId\":$PERF_ID,\"startsAt\":\"$STARTS_AT\",\"ticketOpenAt\":\"$OPEN_AT\"}" | jq -r .id)
json POST "/admin/shows/$SHOW_ID/seats" "$ADMIN" '{"prices":[{"section":"A","price":100000}]}' >/dev/null

TOKENS=$(for i in $(seq 1 100); do
  json POST /auth/signup '' "{\"email\":\"u$i@bench.io\",\"password\":\"$PASSWORD\"}" >/dev/null
  json POST /auth/login '' "{\"email\":\"u$i@bench.io\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken
done | jq -R . | jq -s .)

SEAT_IDS=$(curl -sf "$BASE_URL/shows/$SHOW_ID/seats" | jq '[.seats[].id]')
jq -n --arg baseUrl "$BASE_URL" --argjson showId "$SHOW_ID" \
      --argjson seatIds "$SEAT_IDS" --argjson tokens "$TOKENS" \
      '{baseUrl: $baseUrl, showId: $showId, seatIds: $seatIds, tokens: $tokens}' > bench/out/ctx.json

echo "── 4/5 k6 실행"
k6 run bench/hold-contention.js \
  --summary-export "bench/out/${LABEL}-summary.json" | tee "bench/out/${LABEL}.txt"

echo "── 5/5 완료 — bench/out/${LABEL}-summary.json"
