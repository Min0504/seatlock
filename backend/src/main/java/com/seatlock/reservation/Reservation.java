package com.seatlock.reservation;

import com.seatlock.show.Show;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

/**
 * 예매 수명주기: PENDING(미결제) → CONFIRMED(결제 승인) / CANCELED.
 *
 * 좌석-예매의 확정 연결(reservation_seats)은 결제 승인 시점에 만든다.
 * PENDING 단계는 hold_group_id로 선점을 참조만 하므로, 선점이 만료돼 좌석이
 * 다른 사람에게 팔려도 죽은 참조가 될 뿐 어떤 제약과도 충돌하지 않는다.
 *
 * 상태 전이(PENDING→CONFIRMED/CANCELED)는 dirty checking이 아니라 조건부
 * UPDATE로만 수행한다 — 결제·취소의 경합 판정이 WHERE 절에 있어야 하기 때문.
 * 이 엔티티의 쓰기는 생성(INSERT) 한 곳뿐이다.
 */
@Entity
@Table(name = "reservations")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Reservation {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    // 목록 화면이 회차 시작시각·공연 제목까지 항상 요구한다 — fetch join 대상
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "show_id", nullable = false)
    private Show show;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.NAMED_ENUM)
    @Column(nullable = false, columnDefinition = "\"ReservationStatus\"")
    private ReservationStatus status;

    @Column(name = "total_price", nullable = false)
    private int totalPrice;

    @Column(name = "seat_count", nullable = false)
    private int seatCount;

    // 부분 유니크(WHERE status='PENDING')의 키 — 같은 선점으로 미결제 예매는 1건만
    @Column(name = "hold_group_id")
    private UUID holdGroupId;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Builder
    private Reservation(Long userId, Show show, ReservationStatus status,
                        int totalPrice, int seatCount, UUID holdGroupId) {
        this.userId = userId;
        this.show = show;
        this.status = status;
        this.totalPrice = totalPrice;
        this.seatCount = seatCount;
        this.holdGroupId = holdGroupId;
    }
}
