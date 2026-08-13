package com.seatlock.reservation;

import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 예매·확정 좌석 연결의 상태 전이 전담 저장소 — SeatStateRepository와 같은 원칙.
 *
 * 예매 상태 전이는 결제 승인과 취소가 경합하는 지점이라(기획서 장애 시나리오 5)
 * "WHERE가 곧 판정"인 조건부 UPDATE로만 수행한다. 정확히 한 트랜잭션만 1건 갱신에
 * 성공하고, 패자는 0건으로 즉시 드러난다 — 엔티티 dirty checking으로는 이 판정을
 * 원자화할 수 없다.
 */
@Repository
@RequiredArgsConstructor
public class ReservationStateRepository {

    private final NamedParameterJdbcTemplate jdbc;

    /** 상태 전이 시도. true = 이 트랜잭션이 전이의 승자다 (경합 판정을 겸한다) */
    public boolean transition(long reservationId, ReservationStatus from, ReservationStatus to) {
        int updated = jdbc.update("""
                UPDATE reservations
                   SET status = CAST(:to AS "ReservationStatus"), updated_at = now()
                 WHERE id = :id AND status = CAST(:from AS "ReservationStatus")
                """,
                new MapSqlParameterSource()
                        .addValue("id", reservationId)
                        .addValue("from", from.name())
                        .addValue("to", to.name()));
        return updated == 1;
    }

    /**
     * 확정 좌석 연결 생성 — 이중 판매의 최종 방어선(부분 유니크 인덱스
     * reservation_seats_active_unique, WHERE canceled=false)이 지키는 행이 여기서 생긴다.
     */
    public void insertSeatLinks(long reservationId, List<Long> showSeatIds) {
        jdbc.getJdbcTemplate().batchUpdate(
                "INSERT INTO reservation_seats (reservation_id, show_seat_id) VALUES (?, ?)",
                showSeatIds,
                showSeatIds.size(),
                (ps, seatId) -> {
                    ps.setLong(1, reservationId);
                    ps.setLong(2, seatId);
                });
    }

    /**
     * 확정 연결의 취소 이력화 — 행 삭제가 아니라 canceled=true 표식.
     * 부분 유니크 인덱스(WHERE canceled=false)에서 빠지며 좌석 재판매가 열리고,
     * "언제 어떤 좌석이 취소됐나"가 원장으로 남는다. 반환된 show_seat_id로 좌석 원복을 잇는다.
     */
    public List<Long> cancelSeatLinks(long reservationId) {
        return jdbc.queryForList("""
                UPDATE reservation_seats
                   SET canceled = true
                 WHERE reservation_id = :reservationId AND canceled = false
                 RETURNING show_seat_id
                """,
                new MapSqlParameterSource().addValue("reservationId", reservationId),
                Long.class);
    }
}
