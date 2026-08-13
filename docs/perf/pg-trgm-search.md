# 공연 검색 인덱스 — pg_trgm 적용 전/후 EXPLAIN ANALYZE

기획서 §9의 "인덱스 추가 전/후 EXPLAIN ANALYZE 결과를 문서로 남긴다"에 대한 기록.

## 문제

공연 검색은 `ILIKE '%검색어%'` 형태의 **중간 일치**다. B-Tree 인덱스는 문자열의
왼쪽 접두사부터 정렬하므로 선행 와일드카드(`%`)가 붙는 순간 무용지물이 되고,
쿼리는 테이블 전체를 읽는 순차 스캔으로 떨어진다.

pg_trgm은 문자열을 3글자 조각(trigram)으로 분해해 GIN 인덱스에 넣는다.
검색어도 같은 방식으로 분해되므로 중간 일치·대소문자 무시(ILIKE) 검색이
인덱스 스캔으로 처리된다.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX performances_search_text_trgm_idx
    ON performances USING GIN (search_text gin_trgm_ops);
```

`search_text`는 제목+설명(출연진)을 결합한 검색 전용 컬럼이다. 컬럼을 나눠
인덱스 2개를 만들지 않고 하나로 합쳐 인덱스 유지 비용을 절반으로 줄였다.

## 측정 환경

- PostgreSQL 16 (Docker, 로컬), `performances` 200,000행 시드
- 행 구성: 실제와 유사하게 뮤지컬 제목 10종 + 고유 번호 + 출연진 문자열 결합
- 쿼리: 서비스가 실제로 실행하는 형태 그대로 (검색 + id 내림차순 + LIMIT 21)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title FROM performances
 WHERE search_text ILIKE '%배우777%'
 ORDER BY id DESC LIMIT 21;
```

## 인덱스 없음 — Parallel Seq Scan, 59.9ms

```text
Limit  (cost=5450.81..5452.19 rows=12 width=19) (actual time=58.178..59.779 rows=21 loops=1)
  Buffers: shared hit=3016
  ->  Gather Merge  (...)
        ->  Sort  (Sort Method: top-N heapsort)
              ->  Parallel Seq Scan on performances  (actual time=0.298..56.941 rows=100 loops=2)
                    Filter: (search_text ~~* '%배우777%'::text)
                    Rows Removed by Filter: 99900
                    Buffers: shared hit=2980
Planning Time: 0.379 ms
Execution Time: 59.867 ms
```

행 20만 개를 전부 읽고(워커 2개가 나눠 스캔) 99.9%를 버린다.
버퍼 3,016페이지(약 24MB) 접근.

## GIN(gin_trgm_ops) — Bitmap Index Scan, 2.5ms

```text
Limit  (cost=1606.38..1606.43 rows=20 width=19) (actual time=2.345..2.348 rows=21 loops=1)
  Buffers: shared hit=569
  ->  Sort  (Sort Method: top-N heapsort)
        ->  Bitmap Heap Scan on performances  (actual time=1.857..2.306 rows=200 loops=1)
              Recheck Cond: (search_text ~~* '%배우777%'::text)
              Rows Removed by Index Recheck: 180
              Heap Blocks: exact=203
              ->  Bitmap Index Scan on performances_search_text_trgm_idx
                    (actual time=1.833..1.834 rows=380 loops=1)
                    Index Cond: (search_text ~~* '%배우777%'::text)
Planning Time: 0.409 ms
Execution Time: 2.543 ms
```

인덱스가 후보 380행을 추리고, 본문 재검증(Recheck)으로 180행을 걸러 200행만
힙에서 읽는다. 버퍼 접근은 569페이지로 1/5 수준.

## 결과 요약

| | 실행 시간 | 버퍼 접근 | 스캔 방식 |
|---|---|---|---|
| 인덱스 없음 | 59.9ms | 3,016 pages | Parallel Seq Scan (전체 20만 행) |
| pg_trgm GIN | **2.5ms** | **569 pages** | Bitmap Index Scan (후보 380행) |

**약 24배 개선.** 데이터가 늘수록 순차 스캔은 선형으로 느려지지만 trgm 인덱스는
후보 행 수에만 비례하므로 격차는 더 벌어진다.

### 참고 — Recheck가 있는 이유

trigram 인덱스는 근사 자료구조다. "검색어의 trigram을 모두 포함"하는 행을
돌려주지만 그것이 곧 부분 문자열 일치는 아니므로(조각이 흩어져 있을 수 있다),
PostgreSQL이 힙에서 원문을 다시 확인한다. 위 계획의 `Rows Removed by Index
Recheck: 180`이 그 비용이고, 그래도 전체 스캔 대비 압도적으로 싸다.

### 참고 — 왜 Elasticsearch가 아닌가 (기획서 §3)

이 규모(수천~수만 공연)의 부분 일치 검색은 pg_trgm으로 충분하다. 형태소 분석·
랭킹·오타 교정이 필요해지는 시점에 도입해도 늦지 않고, 그때까지는 운영해야 할
시스템 하나(클러스터·동기화 파이프라인)를 줄이는 쪽이 옳다고 판단했다.

## 재현 방법

```bash
# 스크래치 DB 생성 후 마이그레이션 적용
docker exec seatlock-dev-postgres psql -U seatlock -d postgres -c "CREATE DATABASE explain_demo"
DATABASE_URL="postgresql://seatlock:seatlock@localhost:55432/explain_demo?schema=public" npx prisma migrate deploy

# 200,000행 시드
docker exec seatlock-dev-postgres psql -U seatlock -d explain_demo -c "
INSERT INTO venues(name, address) VALUES ('demo', 'demo');
INSERT INTO performances (title, description, venue_id, search_text)
SELECT 'perf-' || g, 'desc', 1,
  (ARRAY['오페라의 유령','레미제라블','캣츠','위키드','시카고','헤드윅','팬텀','노트르담 드 파리','지킬 앤 하이드','맘마미아'])[1 + (g % 10)]
    || ' 공연 ' || g || ' 출연: 배우' || (g % 1000)
FROM generate_series(1, 200000) g;
ANALYZE performances;"

# 전(트랜잭션 안에서 인덱스 제거 후 측정, 롤백) / 후 비교
docker exec seatlock-dev-postgres psql -U seatlock -d explain_demo -c "
BEGIN;
DROP INDEX performances_search_text_trgm_idx;
EXPLAIN (ANALYZE, BUFFERS) SELECT id, title FROM performances WHERE search_text ILIKE '%배우777%' ORDER BY id DESC LIMIT 21;
ROLLBACK;" -c "
EXPLAIN (ANALYZE, BUFFERS) SELECT id, title FROM performances WHERE search_text ILIKE '%배우777%' ORDER BY id DESC LIMIT 21;"
```
