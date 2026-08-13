package com.seatlock.show;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
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

    /** 선점 대상 검증·응답용 — 좌석 정보까지 fetch join (선점 자체는 SeatStateRepository) */
    @Query("""
            SELECT ss FROM ShowSeat ss
              JOIN FETCH ss.seat
             WHERE ss.id IN :ids AND ss.showId = :showId
            """)
    List<ShowSeat> findAllWithSeat(@Param("ids") Collection<Long> ids, @Param("showId") Long showId);

    /**
     * 1인 보유 상한 검사용 — 아직 유효한 HELD만 센다 (만료분은 곧 회수될 좌석).
     * status를 JPQL 열거형 리터럴로 쓰면 Hibernate가 'HELD'::SeatStatus처럼
     * 따옴표 없는 캐스트를 만들어 PG의 대소문자 구분 타입("SeatStatus")을 못 찾는다 —
     * 파라미터 바인딩은 컬럼 타입으로 해석되므로 캐스트 자체가 필요 없다.
     */
    @Query("""
            SELECT count(ss) FROM ShowSeat ss
             WHERE ss.showId = :showId AND ss.holdUserId = :userId
               AND ss.status = :status
               AND ss.holdExpiresAt > :now
            """)
    long countByUserActiveHolds(
            @Param("showId") Long showId,
            @Param("userId") Long userId,
            @Param("status") SeatStatus status,
            @Param("now") Instant now);

    default long countActiveHolds(Long showId, Long userId, Instant now) {
        return countByUserActiveHolds(showId, userId, SeatStatus.HELD, now);
    }

    List<ShowSeat> findByHoldGroupIdAndHoldUserIdAndStatus(UUID holdGroupId, Long holdUserId, SeatStatus status);

    /** 결제 전 선점 생존 검사용 — 그룹의 미만료 HELD 좌석 수 (최종 판정은 confirmByGroup) */
    @Query("""
            SELECT count(ss) FROM ShowSeat ss
             WHERE ss.holdGroupId = :groupId AND ss.holdUserId = :userId
               AND ss.status = :status
               AND ss.holdExpiresAt > :now
            """)
    long countByGroupAliveHolds(
            @Param("groupId") UUID holdGroupId,
            @Param("userId") Long userId,
            @Param("status") SeatStatus status,
            @Param("now") Instant now);

    default long countAliveInGroup(UUID holdGroupId, Long userId, Instant now) {
        return countByGroupAliveHolds(holdGroupId, userId, SeatStatus.HELD, now);
    }

    /** PENDING 예매의 좌석 표시용 — 선점 그룹 일괄 조회 (행마다 조회하면 N+1) */
    @Query("""
            SELECT ss FROM ShowSeat ss
              JOIN FETCH ss.seat
             WHERE ss.holdGroupId IN :groupIds
            """)
    List<ShowSeat> findAllWithSeatByHoldGroupIdIn(@Param("groupIds") Collection<UUID> groupIds);
}
