package com.seatlock.show;

import com.seatlock.performance.Seat;
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
import jakarta.persistence.UniqueConstraint;
import java.time.Instant;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * 회차별 좌석 인스턴스 — 이 프로젝트의 심장.
 *
 * 선점/예매의 상태 전이는 JPA 변경 감지(dirty checking)가 아니라 조건부 UPDATE로만
 * 수행한다(v3 동시성 포팅에서 구현). 엔티티를 읽어 setStatus 후 flush 하는 방식은
 * 두 트랜잭션이 같은 AVAILABLE을 읽는 틈(check-then-act race)이 생기기 때문이다.
 * 이 엔티티는 좌석맵 조회 매핑이 주 용도다.
 */
@Entity
@Table(name = "show_seats", uniqueConstraints = {
        // 같은 회차에 같은 물리 좌석이 중복 생성되는 것을 스키마 수준에서 차단
        @UniqueConstraint(columnNames = {"show_id", "seat_id"})
})
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class ShowSeat {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "show_id", nullable = false)
    private Long showId;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "seat_id", nullable = false)
    private Seat seat;

    @Column(nullable = false)
    private int price;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.NAMED_ENUM)
    @Column(nullable = false, columnDefinition = "\"SeatStatus\"")
    private SeatStatus status;

    @Column(name = "hold_user_id")
    private Long holdUserId;

    @Column(name = "hold_group_id")
    private UUID holdGroupId;

    @Column(name = "hold_expires_at")
    private Instant holdExpiresAt;

    // 낙관적 락 실험용 컬럼. 의도적으로 @Version을 붙이지 않았다 —
    // @Version은 이 엔티티의 모든 JPA UPDATE에 버전 검사를 강제하는데, 본선 설계는
    // 조건부 UPDATE(WHERE status='AVAILABLE')가 원자성을 책임진다.
    // @Version 활성화는 experiment/optimistic-lock 브랜치에서만 한다 (기획서 §7 문제 1).
    @Column(nullable = false)
    private int version;

    /** 조회 응답용 상태 판정 — 만료됐지만 아직 회수되지 않은 HELD는 AVAILABLE로 보여준다 */
    public SeatStatus displayStatus(Instant now) {
        boolean expiredHold = status == SeatStatus.HELD
                && holdExpiresAt != null
                && !holdExpiresAt.isAfter(now);
        return expiredHold ? SeatStatus.AVAILABLE : status;
    }
}
