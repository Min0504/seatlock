package com.seatlock.reservation;

import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ReservationSeatRepository extends JpaRepository<ReservationSeat, Long> {

    /** 확정(CONFIRMED) 예매들의 좌석 일괄 조회 — 페이지 단위 배치로 N+1 방지 */
    @Query("""
            SELECT rs FROM ReservationSeat rs
              JOIN FETCH rs.showSeat ss
              JOIN FETCH ss.seat
             WHERE rs.reservationId IN :reservationIds
            """)
    List<ReservationSeat> findAllWithSeatByReservationIdIn(
            @Param("reservationIds") Collection<Long> reservationIds);
}
