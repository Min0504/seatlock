-- 이중 판매의 DB 레벨 최후 방어선.
-- 애플리케이션의 조건부 UPDATE가 버그로 뚫리더라도, "유효한(취소되지 않은) 예매 좌석"은
-- 좌석당 1행만 존재할 수 있다는 불변식을 DB가 강제한다.
-- 일반 UNIQUE가 아닌 부분(partial) 유니크 인덱스인 이유: 취소된 예매(canceled=true)는
-- 같은 좌석에 여러 번 쌓일 수 있어야 하기 때문(취소 후 재판매).
-- Prisma 스키마 문법은 부분 인덱스를 표현하지 못해 SQL 마이그레이션으로 직접 관리한다.
CREATE UNIQUE INDEX "reservation_seats_active_unique"
    ON "reservation_seats" ("show_seat_id")
    WHERE "canceled" = false;
