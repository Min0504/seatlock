package com.seatlock.payment;

import java.util.Collection;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface PaymentRepository extends JpaRepository<Payment, Long> {

    Optional<Payment> findByIdempotencyKey(UUID idempotencyKey);

    /** 같은 예매의 유효 결제(PENDING/APPROVED) 조회 — 부분 유니크 충돌의 원인 식별용 */
    Optional<Payment> findFirstByReservationIdAndStatusIn(Long reservationId, Collection<PaymentStatus> statuses);

    /**
     * PENDING→FAILED 조건부 전이. 반환 1 = 이 요청이 실패 확정의 소유자다.
     *
     * 저장소 메서드에 직접 @Transactional을 붙여 즉시 커밋한다(REQUIRES_NEW가 아니라
     * 기본 전파 — 호출부가 전부 트랜잭션 밖의 오케스트레이션 코드다). 실패 기록이
     * 호출부 예외로 함께 롤백되면 "같은 키는 같은 실패를 재현한다"는 계약이 깨진다.
     */
    @Transactional
    @Modifying
    @Query("""
            UPDATE Payment p SET p.status = :to, p.updatedAt = CURRENT_TIMESTAMP
             WHERE p.id = :id AND p.status = :from
            """)
    int transition(@Param("id") Long id, @Param("from") PaymentStatus from, @Param("to") PaymentStatus to);

    /** 승인 확정 — pg_tx_id를 함께 기록한다. 확정 트랜잭션 내부에서만 호출한다. */
    @Modifying
    @Query("""
            UPDATE Payment p SET p.status = :to, p.pgTxId = :pgTxId, p.updatedAt = CURRENT_TIMESTAMP
             WHERE p.id = :id
            """)
    int approve(@Param("id") Long id, @Param("to") PaymentStatus to, @Param("pgTxId") String pgTxId);
}
