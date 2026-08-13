-- SeatLock 스키마 베이스라인 (Spring 포팅 시점 스냅샷)
--
-- 스키마의 원본 소유자는 backend-nest의 Prisma 마이그레이션이다. 포팅의 원칙이
-- "도메인·SQL은 유지, 프레임워크만 교체"(기획서 §14 3주차)이므로 Spring도 같은
-- 스키마를 그대로 쓴다. Prisma 마이그레이션 전체를 시간순으로 결합해 이 파일
-- 하나로 고정했고, 이후 스키마 변경은 두 구현에 같은 SQL로 반영한다.
-- (JPA ddl-auto는 validate — 엔티티가 이 스키마와 다르면 부팅이 실패한다)

-- ─────────────────────────────────────────────────────────────
-- 원본: prisma/migrations/20260813104707_init
-- ─────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('AVAILABLE', 'HELD', 'RESERVED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELED');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "address" VARCHAR(255) NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seats" (
    "id" BIGSERIAL NOT NULL,
    "venue_id" BIGINT NOT NULL,
    "section" VARCHAR(20) NOT NULL,
    "row_no" VARCHAR(10) NOT NULL,
    "seat_no" INTEGER NOT NULL,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performances" (
    "id" BIGSERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "poster_url" VARCHAR(500),
    "venue_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shows" (
    "id" BIGSERIAL NOT NULL,
    "performance_id" BIGINT NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ticket_open_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "show_seats" (
    "id" BIGSERIAL NOT NULL,
    "show_id" BIGINT NOT NULL,
    "seat_id" BIGINT NOT NULL,
    "price" INTEGER NOT NULL,
    "status" "SeatStatus" NOT NULL DEFAULT 'AVAILABLE',
    "hold_user_id" BIGINT,
    "hold_group_id" UUID,
    "hold_expires_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "show_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "show_id" BIGINT NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "total_price" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_seats" (
    "id" BIGSERIAL NOT NULL,
    "reservation_id" BIGINT NOT NULL,
    "show_seat_id" BIGINT NOT NULL,
    "canceled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "reservation_seats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "seats_venue_id_section_row_no_seat_no_key" ON "seats"("venue_id", "section", "row_no", "seat_no");

-- CreateIndex
CREATE INDEX "shows_performance_id_idx" ON "shows"("performance_id");

-- CreateIndex
CREATE INDEX "show_seats_hold_group_id_idx" ON "show_seats"("hold_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "show_seats_show_id_seat_id_key" ON "show_seats"("show_id", "seat_id");

-- CreateIndex
CREATE INDEX "reservations_user_id_created_at_idx" ON "reservations"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reservation_seats_reservation_id_idx" ON "reservation_seats"("reservation_id");

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performances" ADD CONSTRAINT "performances_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shows" ADD CONSTRAINT "shows_performance_id_fkey" FOREIGN KEY ("performance_id") REFERENCES "performances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "show_seats" ADD CONSTRAINT "show_seats_show_id_fkey" FOREIGN KEY ("show_id") REFERENCES "shows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "show_seats" ADD CONSTRAINT "show_seats_seat_id_fkey" FOREIGN KEY ("seat_id") REFERENCES "seats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_show_id_fkey" FOREIGN KEY ("show_id") REFERENCES "shows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_show_seat_id_fkey" FOREIGN KEY ("show_seat_id") REFERENCES "show_seats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- 원본: prisma/migrations/20260813110200_reservation_seats_active_unique
-- ─────────────────────────────────────────────────────────────
-- 이중 판매의 DB 레벨 최후 방어선.
-- 애플리케이션의 조건부 UPDATE가 버그로 뚫리더라도, "유효한(취소되지 않은) 예매 좌석"은
-- 좌석당 1행만 존재할 수 있다는 불변식을 DB가 강제한다.
-- 일반 UNIQUE가 아닌 부분(partial) 유니크 인덱스인 이유: 취소된 예매(canceled=true)는
-- 같은 좌석에 여러 번 쌓일 수 있어야 하기 때문(취소 후 재판매).
-- Prisma 스키마 문법은 부분 인덱스를 표현하지 못해 SQL 마이그레이션으로 직접 관리한다.
CREATE UNIQUE INDEX "reservation_seats_active_unique"
    ON "reservation_seats" ("show_seat_id")
    WHERE "canceled" = false;

-- ─────────────────────────────────────────────────────────────
-- 원본: prisma/migrations/20260813114616_payments_and_pending_reservation
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 원본: prisma/migrations/20260813121822_refresh_tokens
-- ─────────────────────────────────────────────────────────────
-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- 원본: prisma/migrations/20260813123834_performance_search_trgm
-- ─────────────────────────────────────────────────────────────
-- 검색 인프라: pg_trgm 확장 + 결합 검색 컬럼 + GIN 인덱스 (기획서 §5, §9)
--
-- 왜 pg_trgm인가: `title ILIKE '%검색어%'`의 선행 와일드카드는 B-Tree 인덱스를
-- 못 타서 풀스캔이 된다. pg_trgm은 문자열을 3글자 조각(trigram)으로 쪼개
-- GIN 인덱스에 넣으므로 중간 일치 검색도 인덱스 스캔이 가능하다.
-- (Elasticsearch를 안 쓰는 이유: 이 규모의 부분 일치 검색은 pg_trgm으로 충분하다)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 손으로 작성한 3단계 추가(add nullable → backfill → not null):
-- Prisma가 생성한 `ADD COLUMN ... NOT NULL`은 기존 행이 있는 테이블에서 실패한다.
ALTER TABLE "performances" ADD COLUMN "search_text" TEXT;

UPDATE "performances"
   SET "search_text" = "title" || ' ' || coalesce("description", '');

ALTER TABLE "performances" ALTER COLUMN "search_text" SET NOT NULL;

-- gin_trgm_ops: trigram 연산자 클래스. ILIKE '%q%'가 이 인덱스를 탄다.
CREATE INDEX "performances_search_text_trgm_idx"
    ON "performances" USING GIN ("search_text" gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────
-- 원본: prisma/migrations/20260813150000_show_seats_expired_hold_scan_idx
-- ─────────────────────────────────────────────────────────────
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
