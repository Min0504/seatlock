#!/usr/bin/env bash
# Redis 다운 — 좌석맵은 DB 폴백, 선점(정합성)은 캐시를 안 쓰므로 그대로 201.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
source bench/out/v4.env
BASE="${BASE_URL:?}"
TOKEN="${PROBE_TOKEN:?}"
SHOW="${SHOW_ID:?}"
SEAT="${PROBE_SEAT_ID:?}"

echo "== seatmap before kill"
curl -sf "$BASE/shows/$SHOW/seats" | jq '{showId, n: (.seats|length), sample: .seats[0].status}'

echo "== stopping redis"
docker stop seatlock-dev-redis >/dev/null
sleep 1

echo "== seatmap during outage (must be 200)"
code="$(curl -s -o /tmp/sl-seatmap-down.json -w '%{http_code}' "$BASE/shows/$SHOW/seats")"
echo "seatmap status=$code seats=$(jq '.seats|length' /tmp/sl-seatmap-down.json)"
if [[ "$code" != "200" ]]; then
  docker start seatlock-dev-redis >/dev/null
  echo "FAIL: seatmap should fail-open to DB" >&2
  exit 1
fi

echo "== hold during outage (must be 201 — 정합성은 DB)"
hold="$(curl -s -o /tmp/sl-hold-down.json -w '%{http_code}' -X POST "$BASE/shows/$SHOW/holds" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"seatIds\":[$SEAT]}")"
echo "hold status=$hold body=$(cat /tmp/sl-hold-down.json)"
if [[ "$hold" != "201" ]]; then
  docker start seatlock-dev-redis >/dev/null
  echo "FAIL: hold must succeed without Redis" >&2
  exit 1
fi

echo "== redis left down for cache-off 측정 (LEAVE_DOWN=1) 또는 복구"
if [[ "${LEAVE_DOWN:-0}" == "1" ]]; then
  echo "chaos redis-kill completed (redis still down)"
else
  docker start seatlock-dev-redis >/dev/null
  sleep 2
  echo "chaos redis-kill completed"
fi
