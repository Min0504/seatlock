#!/usr/bin/env bash
# 데모 데이터 시드 — compose 스택 기동 후 1회 실행한다.
#   docker compose up -d --build && scripts/seed-demo.sh
# 생성: 관리자 1, 공연장 1(96석), 공연 3, 회차 3(오픈 2·오픈 전 1), 구역별 가격.
set -euo pipefail

B="${API_URL:-http://localhost:18080}"
ADMIN_EMAIL=admin@seatlock.io
ADMIN_PASSWORD=password1234

json() { curl -sf -X "$1" "$B$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} -d "$4"; }

echo "── 관리자 계정"
json POST /auth/signup '' "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" >/dev/null 2>&1 || true
# 롤 승격은 운영 API가 없으므로(의도적 — 시드/운영 전용 작업) DB에서 직접
docker compose exec -T postgres psql -U seatlock -d seatlock -qc \
  "UPDATE users SET role='ADMIN' WHERE email='$ADMIN_EMAIL'"
ADMIN=$(json POST /auth/login '' "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r .accessToken)

echo "── 공연장 (A·B 구역 × 4열 × 12석 = 96석)"
SEATS=$(jq -n '[(["A","B"][] as $sec | range(1;5) as $row | range(1;13) as $no
                 | {section:$sec, rowNo:($row|tostring), seatNo:$no})]')
VENUE=$(json POST /admin/venues "$ADMIN" \
  "{\"name\":\"세종문화회관 대극장\",\"address\":\"서울 종로구 세종대로 175\",\"seats\":$SEATS}" | jq -r .id)

echo "── 공연 3편 + 회차"
if date -v+1d >/dev/null 2>&1; then  # BSD(macOS) / GNU date 분기
  STARTS=$(date -u -v+21d +%Y-%m-%dT10:00:00Z); STARTS2=$(date -u -v+22d +%Y-%m-%dT10:00:00Z)
  OPEN=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ);    FUTURE=$(date -u -v+7d +%Y-%m-%dT%H:%M:%SZ)
else
  STARTS=$(date -u -d '+21 days' +%Y-%m-%dT10:00:00Z); STARTS2=$(date -u -d '+22 days' +%Y-%m-%dT10:00:00Z)
  OPEN=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ);    FUTURE=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)
fi

seed_perf() { # title description → performance id
  json POST /admin/performances "$ADMIN" \
    "{\"title\":\"$1\",\"description\":\"$2\",\"venueId\":$VENUE}" | jq -r .id
}
P1=$(seed_perf "오페라의 유령" "뮤지컬의 전설, 다시 무대로")
P2=$(seed_perf "레미제라블" "프랑스 대혁명의 서사시")
P3=$(seed_perf "지킬 앤 하이드" "두 얼굴의 사나이")

seed_show() { # performanceId startsAt ticketOpenAt → show id
  json POST /admin/shows "$ADMIN" \
    "{\"performanceId\":$1,\"startsAt\":\"$2\",\"ticketOpenAt\":\"$3\"}" | jq -r .id
}
S1=$(seed_show "$P1" "$STARTS" "$OPEN")
S2=$(seed_show "$P1" "$STARTS2" "$FUTURE")   # 오픈 전 상태 시연용
S3=$(seed_show "$P2" "$STARTS" "$OPEN")

for s in "$S1" "$S3"; do
  json POST "/admin/shows/$s/seats" "$ADMIN" \
    '{"prices":[{"section":"A","price":150000},{"section":"B","price":90000}]}' >/dev/null
done

echo "완료 — http://localhost:8090 에서 확인 (관리자: $ADMIN_EMAIL / $ADMIN_PASSWORD)"
echo "미사용 공연($P3)은 검색 데모용, 회차 $S2 는 '오픈 전' 상태 시연용"
