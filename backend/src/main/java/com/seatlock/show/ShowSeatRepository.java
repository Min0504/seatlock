package com.seatlock.show;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ShowSeatRepository extends JpaRepository<ShowSeat, Long> {

    /**
     * 좌석맵 조회 — seat를 fetch join으로 한 번에 (좌석 수천 건의 지연 로딩 N+1 방지).
     * 정렬은 물리 좌석 좌표 기준: 클라이언트가 받은 순서 그대로 그리면 좌석 배치도가 된다.
     */
    @Query("""
            SELECT ss FROM ShowSeat ss
              JOIN FETCH ss.seat s
             WHERE ss.showId = :showId
             ORDER BY s.section ASC, s.rowNo ASC, s.seatNo ASC
            """)
    List<ShowSeat> findSeatMapByShowId(@Param("showId") Long showId);

    boolean existsByShowId(Long showId);
}
