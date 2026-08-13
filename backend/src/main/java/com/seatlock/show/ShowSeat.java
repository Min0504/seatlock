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
import jakarta.persistence.Version;
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

    // [실험 브랜치] @Version 활성화 — JPA가 이 엔티티의 모든 UPDATE에
    // "WHERE version = 읽은값"을 덧붙이고 version을 +1 한다. 갱신 0건이면
    // 다른 트랜잭션이 먼저 커밋한 것 — OptimisticLockException으로 드러난다.
    //
    // 한계(정직하게): 이 브랜치에서도 해제·스위퍼·결제 확정은 본선의 원시 SQL
    // 경로라 version을 증가시키지 않는다. 낙관적 보호 범위는 "hold 경로끼리의
    // 경합"으로 한정된다 — 전 경로 낙관적 전환은 원시 SQL 전부를 엔티티 갱신으로
    // 바꿔야 하며, 그 비용 자체가 이 전략의 단점 목록에 들어간다.
    @Version
    @Column(nullable = false)
    private int version;

    /** 조회 응답용 상태 판정 — 만료됐지만 아직 회수되지 않은 HELD는 AVAILABLE로 보여준다 */
    public SeatStatus displayStatus(Instant now) {
        boolean expiredHold = status == SeatStatus.HELD
                && holdExpiresAt != null
                && !holdExpiresAt.isAfter(now);
        return expiredHold ? SeatStatus.AVAILABLE : status;
    }

    /** [실험 브랜치 전용] 이 좌석을 지금 선점할 수 있는가 — 빈 좌석 또는 만료된 선점 */
    public boolean holdable(Instant now) {
        return status == SeatStatus.AVAILABLE
                || (status == SeatStatus.HELD && holdExpiresAt != null && !holdExpiresAt.isAfter(now));
    }

    /**
     * [실험 브랜치 전용] 엔티티 변경 감지(dirty checking) 경로의 선점 상태 전이.
     * 커밋 시 flush되는 UPDATE에 @Version 검사가 자동으로 붙는다 —
     * "읽은 뒤 아무도 안 건드렸다"가 성립할 때만 성공한다.
     */
    public void applyHold(long userId, UUID groupId, Instant expiresAt) {
        this.status = SeatStatus.HELD;
        this.holdUserId = userId;
        this.holdGroupId = groupId;
        this.holdExpiresAt = expiresAt;
    }
}
