package com.seatlock.reservation;

import com.seatlock.show.ShowSeat;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * 좌석-예매의 확정 연결 — 결제 승인 시점에만 생성된다 (다음 단계에서 결제와 함께).
 *
 * 이중 판매의 최종 방어선: 부분 유니크 인덱스 reservation_seats_active_unique
 * (show_seat_id WHERE canceled = false)가 "살아있는 확정 연결은 좌석당 1개"를
 * 스키마 수준에서 강제한다. 취소는 행 삭제가 아니라 canceled=true 표식이라
 * 이력이 남고, 인덱스에서 빠지며 재판매가 열린다.
 */
@Entity
@Table(name = "reservation_seats")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class ReservationSeat {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "reservation_id", nullable = false)
    private Long reservationId;

    // 확정 좌석 표시에 좌석 좌표·가격이 필요하다 — fetch join 대상
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "show_seat_id", nullable = false)
    private ShowSeat showSeat;

    @Column(nullable = false)
    private boolean canceled;
}
