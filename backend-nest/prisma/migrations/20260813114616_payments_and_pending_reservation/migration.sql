-- 결제(payments) 도입 + 예매를 "미결제(PENDING) 단계"로 확장
--
-- 설계 요점:
-- 1) 좌석-예매의 확정 연결(reservation_seats)은 결제 승인 시점에 생성된다.
--    PENDING 예매는 hold_group_id로 선점만 참조하므로, 선점이 만료돼 좌석이
--    재판매되어도 부분 유니크 인덱스(reservation_seats_active_unique)와
--    충돌하지 않는다.
-- 2) 유니크 제약이 곧 동시성 제어다 — 애플리케이션 검사가 아니라 DB가 직렬화한다.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'FAILED', 'CANCELED');

-- AlterTable (seat_count NOT NULL: 이 시점에 reservations는 운영 데이터가 없다)
ALTER TABLE "reservations" ADD COLUMN     "hold_group_id" UUID,
ADD COLUMN     "seat_count" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "payments" (
    "id" BIGSERIAL NOT NULL,
    "reservation_id" BIGINT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "pg_tx_id" VARCHAR(100),
    "amount" INTEGER NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 이중 결제 차단의 핵심 — 같은 Idempotency-Key의 두 번째 INSERT는
-- DB가 23505로 거부하고, 애플리케이션은 기존 레코드의 결과를 재생한다.
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_reservation_id_idx" ON "payments"("reservation_id");

-- 부분 유니크: 예매 1건당 "유효한"(진행 중이거나 승인된) 결제는 1건.
-- 전체 UNIQUE(reservation_id)로 걸면 FAILED 후 새 키로 재시도하는 정상 경로가 막힌다.
CREATE UNIQUE INDEX "payments_active_reservation_unique"
    ON "payments" ("reservation_id")
 WHERE "status" IN ('PENDING'::"PaymentStatus", 'APPROVED'::"PaymentStatus");

-- 부분 유니크: 같은 선점 그룹으로 미결제 예매를 중복 생성할 수 없다.
-- (두 번째 요청은 기존 PENDING 예매를 그대로 돌려받는다 — 예매 생성의 멱등화)
CREATE UNIQUE INDEX "reservations_pending_hold_group_unique"
    ON "reservations" ("hold_group_id")
 WHERE "status" = 'PENDING'::"ReservationStatus";

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
