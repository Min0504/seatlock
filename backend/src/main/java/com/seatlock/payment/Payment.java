package com.seatlock.payment;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
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
 * 결제 원장 (기획서 §7 문제 3 — 이중 결제 방지).
 *
 * idempotency_key UNIQUE 제약이 멱등성의 심장이다: "한 번만 실행"의 선점권을
 * 애플리케이션 메모리가 아니라 DB INSERT의 성패로 판정한다 — 서버가 2대가 돼도
 * 무너지지 않는 가장 값싼 직렬화 장치.
 *
 * 상태 전이(PENDING→APPROVED/FAILED, APPROVED→CANCELED)는 전부 조건부 UPDATE로만
 * 한다. 특히 PENDING→FAILED는 "실패 확정의 소유권" 판정을 겸하므로(보상 취소 참조)
 * dirty checking으로 대체할 수 없다. 이 엔티티의 쓰기는 생성(INSERT) 한 곳뿐이다.
 */
@Entity
@Table(name = "payments")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Payment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "reservation_id", nullable = false)
    private Long reservationId;

    @Column(name = "idempotency_key", nullable = false, unique = true)
    private UUID idempotencyKey;

    // 요청 바디의 SHA-256 지문 — 같은 키에 다른 바디가 오면 422로 거르는 근거
    @Column(name = "request_hash", nullable = false, length = 64)
    private String requestHash;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.NAMED_ENUM)
    @Column(nullable = false, columnDefinition = "\"PaymentStatus\"")
    private PaymentStatus status;

    @Column(name = "pg_tx_id", length = 100)
    private String pgTxId;

    // 서버가 예매에서 계산한 금액 — 클라이언트 전달 금액은 신뢰하지 않는다 (기획서 §보안)
    @Column(nullable = false)
    private int amount;

    @Column(nullable = false, length = 20)
    private String method;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    // 정체된 PENDING 판정(PAYMENT_STALE_MS)의 기준 시각
    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Builder
    private Payment(Long reservationId, UUID idempotencyKey, String requestHash,
                    PaymentStatus status, int amount, String method) {
        this.reservationId = reservationId;
        this.idempotencyKey = idempotencyKey;
        this.requestHash = requestHash;
        this.status = status;
        this.amount = amount;
        this.method = method;
    }
}
