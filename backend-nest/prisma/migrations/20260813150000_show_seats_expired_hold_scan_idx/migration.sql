-- 만료 선점 스캔용 부분 인덱스 (스위퍼 전용)
--
-- 스위퍼는 30초마다 "HELD이면서 만료시각이 지난 행"을 찾는다:
--   UPDATE show_seats SET ... WHERE status='HELD' AND hold_expires_at < now();
--
-- 전체 컬럼 인덱스 대신 WHERE status='HELD' 부분 인덱스를 쓰는 이유:
-- show_seats는 회차×좌석만큼 쌓이는 큰 테이블이지만 "지금 선점 중"인 행은
-- 극히 일부다. 부분 인덱스는 그 일부만 담으므로 크기·유지 비용이 작고,
-- AVAILABLE/RESERVED 행의 쓰기에는 인덱스 갱신 부담을 주지 않는다.
CREATE INDEX "show_seats_expired_hold_scan_idx"
    ON "show_seats" ("hold_expires_at")
 WHERE "status" = 'HELD'::"SeatStatus";
