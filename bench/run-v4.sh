#!/usr/bin/env bash
# 기획서 v4 k6 3종 + Redis 카오스 + 커넥션 풀 고갈.
#
#   bench/run-v4.sh
#
# 전제: backend-nest/docker-compose.dev.yml (postgres :55432, redis :63790), k6, jq, python3.
set -euo pipefail
ulimit -n 4096 2>/dev/null || true
cd "$(dirname "$0")/.."

PORT="${PORT:-8087}"
BASE_URL="http://localhost:${PORT}"
PG_CONTAINER="${PG_CONTAINER:-seatlock-dev-postgres}"
DB_NAME=seatlock_bench
PASSWORD=password1234
JWT_ACCESS_SECRET="bench-access-secret-must-be-32-bytes!"
JWT_REFRESH_SECRET="bench-refresh-secret-must-be-32-byte!"
APP_LOG=/tmp/seatlock-v4.log
APP_PID=""

json() { curl -sf -X "$1" "$BASE_URL$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} -d "$4"; }

wait_health() {
  for _ in $(seq 1 90); do
    curl -sf "$BASE_URL/actuator/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "앱 기동 실패 — $APP_LOG" >&2
  tail -n 80 "$APP_LOG" >&2 || true
  return 1
}

stop_app() {
  if [[ -n "${APP_PID}" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  APP_PID=""
  local leftover
  leftover="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [[ -n "$leftover" ]]; then
    kill $leftover 2>/dev/null || true
    sleep 1
  fi
}

start_app() {
  stop_app
  local jar
  jar="$(ls -1 backend/build/libs/seatlock-*.jar | grep -v plain | head -n 1)"
  echo "starting $jar (pool=${HIKARI_MAX_POOL:-10} timeout=${HIKARI_CONNECTION_TIMEOUT_MS:-3000}ms)"
  DATABASE_URL="jdbc:postgresql://localhost:55432/$DB_NAME" \
  JWT_ACCESS_SECRET="$JWT_ACCESS_SECRET" \
  JWT_REFRESH_SECRET="$JWT_REFRESH_SECRET" \
  JWT_ACCESS_TTL_SEC=7200 \
  PORT="$PORT" \
  HIKARI_MAX_POOL="${HIKARI_MAX_POOL:-10}" \
  HIKARI_CONNECTION_TIMEOUT_MS="${HIKARI_CONNECTION_TIMEOUT_MS:-3000}" \
  java -jar "$jar" >"$APP_LOG" 2>&1 &
  APP_PID=$!
  wait_health
}

trap 'stop_app; docker start seatlock-dev-redis >/dev/null 2>&1 || true' EXIT

echo "── 0/7 인프라"
docker compose -f backend-nest/docker-compose.dev.yml up -d
for _ in $(seq 1 30); do
  docker exec "$PG_CONTAINER" pg_isready -U seatlock >/dev/null 2>&1 && break
  sleep 1
done

echo "── 1/7 벤치 DB 재생성"
docker exec "$PG_CONTAINER" psql -U seatlock -d postgres -qc "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null
docker exec "$PG_CONTAINER" psql -U seatlock -d postgres -qc "CREATE DATABASE $DB_NAME" >/dev/null

echo "── 2/7 앱 빌드·기동 (:$PORT, pool=10 timeout=3s)"
(cd backend && ./gradlew -q bootJar)
start_app

echo "── 3/7 시드 (admin·좌석 500·사용자 1000 SQL+JWT)"
json POST /auth/signup '' "{\"email\":\"admin@bench.io\",\"password\":\"$PASSWORD\"}" >/dev/null
docker exec "$PG_CONTAINER" psql -U seatlock -d "$DB_NAME" -qc \
  "UPDATE users SET role='ADMIN' WHERE email='admin@bench.io'" >/dev/null
ADMIN=$(json POST /auth/login '' "{\"email\":\"admin@bench.io\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken)

SEATS=$(jq -n '[range(1; 501) | {section: "A", rowNo: "1", seatNo: .}]')
VENUE_ID=$(json POST /admin/venues "$ADMIN" "{\"name\":\"v4홀\",\"address\":\"서울\",\"seats\":$SEATS}" | jq -r .id)
PERF_ID=$(json POST /admin/performances "$ADMIN" "{\"title\":\"v4 부하\",\"venueId\":$VENUE_ID}" | jq -r .id)
STARTS_AT=$(date -u -v+30d +%Y-%m-%dT%H:%M:%SZ)
OPEN_AT=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)
SHOW_ID=$(json POST /admin/shows "$ADMIN" \
  "{\"performanceId\":$PERF_ID,\"startsAt\":\"$STARTS_AT\",\"ticketOpenAt\":\"$OPEN_AT\"}" | jq -r .id)
json POST "/admin/shows/$SHOW_ID/seats" "$ADMIN" '{"prices":[{"section":"A","price":100000}]}' >/dev/null

docker exec "$PG_CONTAINER" psql -U seatlock -d "$DB_NAME" -qc "
INSERT INTO users (email, password_hash, role, created_at, updated_at)
SELECT 'k6u' || g || '@bench.io', 'k6-unused', 'USER', now(), now()
FROM generate_series(1, 1000) g;" >/dev/null

USER_IDS=$(docker exec "$PG_CONTAINER" psql -U seatlock -d "$DB_NAME" -tA -c \
  "SELECT id FROM users WHERE email LIKE 'k6u%@bench.io' ORDER BY id")
TOKENS=$(echo "$USER_IDS" | python3 bench/jwt_mint.py --secret "$JWT_ACCESS_SECRET" | jq -R . | jq -s .)
SEAT_IDS=$(curl -sf "$BASE_URL/shows/$SHOW_ID/seats" | jq '[.seats[].id]')
HOT=$(echo "$SEAT_IDS" | jq '.[0:10]')
PAY_SEAT=$(echo "$SEAT_IDS" | jq '.[10]')
PROBE_SEAT=$(echo "$SEAT_IDS" | jq '.[11]')
POOL_SEATS=$(echo "$SEAT_IDS" | jq '.[20:100]')
PAY_TOKEN=$(echo "$TOKENS" | jq -r '.[0]')
PROBE_TOKEN=$(echo "$TOKENS" | jq -r '.[1]')

echo "── 결제 시드 (좌석 11번)"
HOLD=$(json POST "/shows/$SHOW_ID/holds" "$PAY_TOKEN" "{\"seatIds\":[$PAY_SEAT]}")
GID=$(echo "$HOLD" | jq -r .holdGroupId)
RES=$(json POST /reservations "$PAY_TOKEN" "{\"holdGroupId\":\"$GID\"}")
RID=$(echo "$RES" | jq -r .id)
IDEM=$(python3 -c 'import uuid; print(uuid.uuid4())')

mkdir -p bench/out
jq -n --arg baseUrl "$BASE_URL" --argjson showId "$SHOW_ID" \
      --argjson hotSeatIds "$HOT" --argjson seatIds "$SEAT_IDS" \
      --argjson tokens "$TOKENS" --argjson poolSeats "$POOL_SEATS" \
      --arg payToken "$PAY_TOKEN" --argjson reservationId "$RID" --arg idem "$IDEM" \
      '{baseUrl:$baseUrl, showId:$showId, hotSeatIds:$hotSeatIds, seatIds:$seatIds, tokens:$tokens,
        poolSeats:$poolSeats,
        payment:{token:$payToken, reservationId:$reservationId, idempotencyKey:$idem}}' \
  > bench/out/v4-ctx.json

cat > bench/out/v4.env <<EOF
BASE_URL=$BASE_URL
SHOW_ID=$SHOW_ID
PROBE_TOKEN=$PROBE_TOKEN
PROBE_SEAT_ID=$PROBE_SEAT
PG_CONTAINER=$PG_CONTAINER
DB_NAME=$DB_NAME
EOF

echo "── 4/7 k6 ③ 결제 멱등 50 VU"
k6 run bench/payment-idem.js --summary-export bench/out/v4-payment-summary.json | tee bench/out/v4-payment.txt || true
PAY_N=$(docker exec "$PG_CONTAINER" psql -U seatlock -d "$DB_NAME" -tA -c \
  "SELECT count(*) FROM payments WHERE reservation_id=$RID")
echo "payments rows=$PAY_N (expect 1)"
[[ "$PAY_N" == "1" ]]

echo "── 5/7 k6 ① 1000 VU × 좌석 10"
k6 run bench/oversell.js --summary-export bench/out/v4-oversell-summary.json | tee bench/out/v4-oversell.txt || true
HELD=$(docker exec "$PG_CONTAINER" psql -U seatlock -d "$DB_NAME" -tA -c \
  "SELECT count(*) FROM show_seats WHERE id = ANY(ARRAY[$(echo "$HOT" | jq -r 'join(",")')]) AND status='HELD'")
echo "hot seats HELD=$HELD (expect 10)"
[[ "$HELD" == "10" ]]

echo "── 6/7 k6 ② 좌석맵 캐시 on / Redis 다운 후 off"
k6 run -e RPS=200 -e DURATION=15s bench/seatmap.js \
  --summary-export bench/out/v4-seatmap-on-summary.json | tee bench/out/v4-seatmap-on.txt || true

chmod +x docs/chaos/redis-kill.sh
LEAVE_DOWN=1 docs/chaos/redis-kill.sh

k6 run -e RPS=200 -e DURATION=15s bench/seatmap.js \
  --summary-export bench/out/v4-seatmap-off-summary.json | tee bench/out/v4-seatmap-off.txt || true
docker start seatlock-dev-redis >/dev/null
sleep 2

echo "── 7/7 커넥션 풀 고갈 (pool=2 timeout=500ms — pool=1은 Flyway 부팅이 안 됨)"
HIKARI_MAX_POOL=2 HIKARI_CONNECTION_TIMEOUT_MS=500 start_app
k6 run bench/pool-exhaust.js --summary-export bench/out/v4-pool-summary.json | tee bench/out/v4-pool.txt || true

echo "완료 — bench/out/v4-*-summary.json"
