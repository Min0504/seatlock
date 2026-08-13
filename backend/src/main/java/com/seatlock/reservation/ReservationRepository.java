package com.seatlock.reservation;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ReservationRepository extends JpaRepository<Reservation, Long> {

    /** 부분 유니크 충돌 시 기존 PENDING 예매 반환용 (생성의 멱등화) */
    Optional<Reservation> findFirstByHoldGroupIdAndUserIdAndStatus(
            UUID holdGroupId, Long userId, ReservationStatus status);

    /**
     * 내 예매 목록 첫 페이지 — show·performance를 fetch join으로 한 왕복에.
     * x-to-one 조인이라 행 수가 늘지 않으므로 LIMIT(Limit 파라미터)이 안전하다.
     * 커서 조건은 JPQL의 null 분기 대신 메서드를 나눴다 — 실행 계획이 단순해진다.
     */
    @Query("""
            SELECT r FROM Reservation r
              JOIN FETCH r.show s
              JOIN FETCH s.performance
             WHERE r.userId = :userId
             ORDER BY r.id DESC
            """)
    List<Reservation> findPage(@Param("userId") Long userId, Limit limit);

    @Query("""
            SELECT r FROM Reservation r
              JOIN FETCH r.show s
              JOIN FETCH s.performance
             WHERE r.userId = :userId AND r.id < :cursor
             ORDER BY r.id DESC
            """)
    List<Reservation> findPageAfter(@Param("userId") Long userId, @Param("cursor") Long cursor, Limit limit);
}
