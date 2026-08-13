package com.seatlock.performance;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface PerformanceRepository extends JpaRepository<Performance, Long> {

    /** 네이티브 프로젝션 — 별칭(스네이크 제거 후)과 게터 이름이 대소문자 무시로 매칭된다 */
    interface ListRow {
        Long getId();

        String getTitle();

        String getPosterUrl();

        String getVenueName();
    }

    /**
     * 공연 목록/검색 (Nest PerformancesService.list 포팅).
     *
     * 네이티브 SQL을 쓰는 이유: JPQL에는 ILIKE가 없고 lower() LIKE로 바꾸면
     * search_text의 GIN(gin_trgm_ops) 인덱스를 타지 못한다 — ILIKE는 trgm 연산자로
     * 처리되지만 lower() 식은 별도의 함수 인덱스를 요구하기 때문. 파라미터는 전부
     * 바인딩이라 SQL Injection 표면은 없다(기획서 §10 — 검색어도 바인딩 강제).
     *
     * CAST(:param AS 타입)이 붙는 이유: null 바인딩 시 PostgreSQL이 파라미터 타입을
     * 추론하지 못해 "could not determine data type" 오류가 난다.
     *
     * 커서 기반 페이지네이션: offset은 뒤 페이지로 갈수록 스캔량이 늘고
     * 페이지 사이 삽입 시 중복/누락이 생긴다 — id 내림차순 커서로 고정.
     */
    @Query(value = """
            SELECT p.id AS id, p.title AS title, p.poster_url AS posterUrl, v.name AS venueName
              FROM performances p
              JOIN venues v ON v.id = p.venue_id
             WHERE (CAST(:q AS text) IS NULL OR p.search_text ILIKE ('%' || CAST(:q AS text) || '%'))
               AND (CAST(:cursor AS bigint) IS NULL OR p.id < CAST(:cursor AS bigint))
               AND (CAST(:dayStart AS timestamptz) IS NULL OR EXISTS (
                     SELECT 1 FROM shows s
                      WHERE s.performance_id = p.id
                        AND s.starts_at >= CAST(:dayStart AS timestamptz)
                        AND s.starts_at < CAST(:dayEnd AS timestamptz)))
             ORDER BY p.id DESC
             LIMIT :limit
            """, nativeQuery = true)
    List<ListRow> search(
            @Param("q") String q,
            @Param("cursor") Long cursor,
            @Param("dayStart") Instant dayStart,
            @Param("dayEnd") Instant dayEnd,
            @Param("limit") int limit);

    /**
     * 상세 조회 — venue와 shows를 fetch join 한 번에 가져온다.
     * 지연 로딩에 맡기면 상세 1건에 SELECT 3회(N+1의 축소판)가 나간다.
     * Prisma의 include와 같은 문제를 JPA에선 fetch join으로 푼다 (기획서 §9 비교 포인트).
     */
    @Query("""
            SELECT DISTINCT p FROM Performance p
              JOIN FETCH p.venue
              LEFT JOIN FETCH p.shows s
             WHERE p.id = :id
             ORDER BY s.startsAt ASC
            """)
    Optional<Performance> findDetailById(@Param("id") Long id);
}
