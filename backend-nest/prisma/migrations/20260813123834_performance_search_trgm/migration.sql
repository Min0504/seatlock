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
