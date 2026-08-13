package com.seatlock.payment;

import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.hold.SeatStateRepository;
import com.seatlock.payment.MockPgClient.PgTimeoutException;
import com.seatlock.payment.dto.PaymentDtos.CreatePaymentRequest;
import com.seatlock.payment.dto.PaymentDtos.PaymentView;
import com.seatlock.reservation.Reservation;
import com.seatlock.reservation.ReservationRepository;
import com.seatlock.reservation.ReservationStateRepository;
import com.seatlock.reservation.ReservationStatus;
import com.seatlock.show.SeatMapCache;
import com.seatlock.show.ShowSeatRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 멱등 결제 (기획서 §7 문제 3) — Nest PaymentsService 포팅.
 *
 * "한 번만 실행"은 payments.idempotency_key UNIQUE 제약에 INSERT하는 것으로
 * 선점한다 — 애플리케이션 메모리 검사는 서버가 2대가 되는 순간 무너지지만,
 * 유니크 제약은 DB가 보장하는 가장 값싸고 확실한 직렬화 장치다.
 *
 * 이 클래스에 클래스 수준 @Transactional이 없는 것은 의도다: 흐름 한가운데에
 * 외부 PG 호출이 있어 전체를 한 트랜잭션으로 묶으면 PG가 느려질 때 커넥션·행 잠금을
 * 붙들게 된다(장애 격리 실패). 대신 각 단계가 독립적으로 커밋한다 —
 * INSERT(선점) → PG 승인(트랜잭션 밖) → 확정 트랜잭션(TransactionTemplate).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentService {

    /**
     * PENDING 결제를 "처리 중"으로 간주하는 시간. 이보다 오래된 PENDING은
     * PG 응답을 받지 못하고 죽은 요청(프로세스 크래시·타임아웃 후 미복구)으로 보고,
     * 같은 키의 재시도가 PG 상태조회로 진실을 확인해 마무리한다.
     * PG 왕복 상한보다 충분히 커야 살아있는 요청을 죽은 것으로 오판하지 않는다.
     */
    public static final long PAYMENT_STALE_MS = 30_000;

    private final PaymentRepository paymentRepository;
    private final ReservationRepository reservationRepository;
    private final ReservationStateRepository reservationStateRepository;
    private final SeatStateRepository seatStateRepository;
    private final ShowSeatRepository showSeatRepository;
    private final MockPgClient pg;
    private final SeatMapCache seatMapCache;
    private final TransactionTemplate transactionTemplate;

    /** replayed=true면 이번 요청은 결제를 재실행하지 않고 기존 결과를 재생했다 (HTTP 200) */
    public record PayResult(PaymentView payment, boolean replayed) {
    }

    public PayResult pay(long userId, UUID idempotencyKey, CreatePaymentRequest request) {
        String requestHash = hashRequest(request);

        Reservation reservation = reservationRepository.findById(request.reservationId()).orElse(null);
        // 남의 예매는 존재 자체를 숨긴다(404) — ID 순회로 예매 존재를 열거하는 것 차단
        if (reservation == null || !reservation.getUserId().equals(userId)) {
            throw new DomainException(ErrorCode.RESERVATION_NOT_FOUND);
        }

        // 재생 경로를 예매 상태 검사보다 먼저 태운다 — 결제 성공으로 예매가 CONFIRMED가
        // 된 뒤에 도착하는 재시도(더블클릭의 두 번째 클릭)가 멱등 계약의 본론이기 때문이다.
        // 상태 검사를 먼저 하면 그 재시도가 ALREADY_PAID(409)로 튕겨 계약이 깨진다.
        Payment existing = paymentRepository.findByIdempotencyKey(idempotencyKey).orElse(null);
        if (existing != null) {
            return replayExisting(existing, reservation, requestHash);
        }

        if (reservation.getStatus() == ReservationStatus.CONFIRMED) {
            throw new DomainException(ErrorCode.ALREADY_PAID);
        }
        if (reservation.getStatus() != ReservationStatus.PENDING) {
            throw new DomainException(ErrorCode.RESERVATION_NOT_PAYABLE);
        }

        // 선점이 이미 죽었으면 PG를 부르기 전에 끊는다 — 승인 후 보상 취소(환불)로
        // 가는 낭비 경로를 줄이는 UX 검사일 뿐, 최종 판정은 확정 트랜잭션의 조건부 UPDATE다.
        assertHoldAlive(reservation);

        Payment payment;
        try {
            payment = paymentRepository.save(Payment.builder()
                    .reservationId(reservation.getId())
                    .idempotencyKey(idempotencyKey)
                    .requestHash(requestHash)
                    .status(PaymentStatus.PENDING)
                    // 금액은 서버가 예매에서 읽는다 — 클라이언트 전달 금액은 신뢰하지 않는다
                    .amount(reservation.getTotalPrice())
                    .method(request.method().name())
                    .build());
        } catch (DataIntegrityViolationException e) {
            return resolveConflict(reservation, idempotencyKey, requestHash);
        }

        return executeApproval(payment, reservation);
    }

    /**
     * INSERT 유니크 충돌의 분기 — 어느 제약에 걸렸는지에 따라 의미가 다르다.
     * ① idempotency_key UNIQUE: 같은 키의 동시 재시도 → 기존 결제의 결과를 재현
     * ② 부분 유니크(reservation_id WHERE PENDING/APPROVED): 다른 키로 같은 예매 결제 시도
     */
    private PayResult resolveConflict(Reservation reservation, UUID idempotencyKey, String requestHash) {
        Payment existing = paymentRepository.findByIdempotencyKey(idempotencyKey).orElse(null);

        if (existing == null) {
            // 키는 처음인데 충돌 → 같은 예매에 유효 결제(PENDING/APPROVED)가 이미 있다
            Payment active = paymentRepository
                    .findFirstByReservationIdAndStatusIn(
                            reservation.getId(), List.of(PaymentStatus.PENDING, PaymentStatus.APPROVED))
                    .orElse(null);
            if (active != null && active.getStatus() == PaymentStatus.APPROVED) {
                throw new DomainException(ErrorCode.ALREADY_PAID);
            }
            throw new DomainException(ErrorCode.PAYMENT_IN_PROGRESS);
        }

        return replayExisting(existing, reservation, requestHash);
    }

    /** 같은 키로 이미 존재하는 결제의 결과를 재실행 없이 재현한다 */
    private PayResult replayExisting(Payment existing, Reservation reservation, String requestHash) {
        // 같은 키 + 다른 바디 = 키 재사용 실수. 조용히 캐시된 응답을 주면
        // 클라이언트는 "새 요청이 성공했다"고 오해한다 — 422로 명시적으로 거른다.
        if (!existing.getRequestHash().equals(requestHash)) {
            throw new DomainException(ErrorCode.IDEMPOTENCY_KEY_MISMATCH);
        }

        return switch (existing.getStatus()) {
            // 첫 요청의 결과(승인, 또는 승인 후 환불된 상태)를 재실행 없이 반환
            case APPROVED, CANCELED -> new PayResult(PaymentView.from(existing), true);
            // 실패도 "첫 요청의 결과"다 — 같은 키로는 영원히 같은 실패를 재현하고,
            // 재시도는 새 키로 하게 한다(키 = 시도 1회의 식별자)
            case FAILED -> throw new DomainException(ErrorCode.PAYMENT_FAILED);
            case PENDING -> {
                long ageMs = Duration.between(existing.getUpdatedAt(), Instant.now()).toMillis();
                if (ageMs < PAYMENT_STALE_MS) {
                    // 원 요청이 아직 PG 응답을 기다리는 중 — 동시 중복 실행을 차단한다
                    throw new DomainException(ErrorCode.PAYMENT_IN_PROGRESS);
                }
                // 응답을 못 받고 죽은 결제 — 이 재시도가 PG 상태조회로 대신 마무리한다
                yield finalizeFromPgStatus(existing, reservation);
            }
        };
    }

    /** PG 승인 호출 — 타임아웃이면 실패 단정 대신 상태조회 경로로 넘어간다 */
    private PayResult executeApproval(Payment payment, Reservation reservation) {
        String pgTxId;
        try {
            // 외부 호출은 DB 트랜잭션 밖에서 한다 — PG가 느려질 때 커넥션·행 잠금을
            // 붙들고 있으면 결제 지연이 예매 시스템 전체의 장애로 번진다(장애 격리).
            pgTxId = pg.approve(payment.getIdempotencyKey().toString(),
                    payment.getAmount(), payment.getMethod()).pgTxId();
        } catch (PgTimeoutException e) {
            return finalizeFromPgStatus(payment, reservation);
        } catch (RuntimeException e) {
            // 명시적 거절 등 — 이 키의 결과를 FAILED로 기록하고 실패를 반환
            markFailed(payment.getId());
            throw new DomainException(ErrorCode.PAYMENT_FAILED);
        }
        return confirmApproved(payment, reservation, pgTxId);
    }

    /** 결과를 모르는 결제(타임아웃·정체된 PENDING)를 PG 기록 기준으로 마무리한다 */
    private PayResult finalizeFromPgStatus(Payment payment, Reservation reservation) {
        String approvedTxId = pg.getApprovedTxId(payment.getIdempotencyKey().toString()).orElse(null);
        if (approvedTxId != null) {
            return confirmApproved(payment, reservation, approvedTxId);
        }
        // PG에 거래 기록이 없다 = 승인은 일어나지 않았다 → 실패 확정 (돈은 안 나갔다)
        markFailed(payment.getId());
        throw new DomainException(ErrorCode.PAYMENT_FAILED);
    }

    /**
     * 승인된 결제의 확정 트랜잭션: 좌석 HELD→RESERVED 전이(조건부 UPDATE),
     * 확정 좌석 연결(reservation_seats) 생성, 예매 PENDING→CONFIRMED, 결제 APPROVED.
     * 하나라도 어긋나면 전체 롤백 — 부분 확정은 존재하지 않는다.
     */
    private PayResult confirmApproved(Payment payment, Reservation reservation, String pgTxId) {
        try {
            transactionTemplate.executeWithoutResult(tx -> {
                // 선점 만료 판정을 겸하는 조건부 UPDATE — WHERE가 곧 검증이다.
                // 만료돼 스위퍼가 회수했거나 다른 사용자가 넘겨받았으면 갱신 0건으로 드러난다.
                List<Long> seatIds = seatStateRepository.confirmByGroup(
                        reservation.getHoldGroupId(), reservation.getUserId());
                // 예매 생성 시점의 좌석 수와 정확히 일치해야 한다 — "2석 중 1석만 확정"은
                // 트랜잭션 롤백으로 되돌리고 전체를 선점 만료로 처리한다
                if (seatIds.size() != reservation.getSeatCount()) {
                    throw new DomainException(ErrorCode.HOLD_EXPIRED);
                }

                // 이중 판매 최후 방어선(부분 유니크 인덱스)이 지키는 확정 연결은 여기서 생긴다
                reservationStateRepository.insertSeatLinks(reservation.getId(), seatIds);

                // 결제 승인 사이에 예매가 취소됐을 수 있다 — 조건부 UPDATE로 원자 판정
                if (!reservationStateRepository.transition(
                        reservation.getId(), ReservationStatus.PENDING, ReservationStatus.CONFIRMED)) {
                    throw new DomainException(ErrorCode.RESERVATION_NOT_PAYABLE);
                }

                paymentRepository.approve(payment.getId(), PaymentStatus.APPROVED, pgTxId);
            });
        } catch (DomainException e) {
            return compensate(payment, e);
        }

        // 좌석이 RESERVED로 굳었다 — 확정 트랜잭션 커밋 후 좌석맵 캐시를 지운다.
        // (getId()는 LAZY 프록시 초기화 없이 식별자만 읽는다)
        seatMapCache.invalidate(reservation.getShow().getId());

        // 커밋 후 확정 상태를 다시 읽는다 — 메모리의 payment는 PENDING 시점의 스냅샷이다
        Payment confirmed = paymentRepository.findById(payment.getId()).orElseThrow();
        return new PayResult(PaymentView.from(confirmed), false);
    }

    /**
     * PG 승인은 났는데 좌석을 확정하지 못한 경우의 보상 처리.
     * 결제를 FAILED로 넘기는 데 성공한 쪽만 PG 취소(환불)를 실행한다 — 정체된 PENDING을
     * 동시에 복구하던 경쟁자가 이미 APPROVED로 확정했다면 그 결과를 그대로 재생해야 하며,
     * 여기서 PG를 취소하면 남의 성공한 결제를 환불하는 사고가 된다.
     */
    private PayResult compensate(Payment payment, DomainException cause) {
        boolean owned = markFailed(payment.getId());
        if (owned) {
            pg.cancel(payment.getIdempotencyKey().toString());
            log.warn("결제 보상 취소 — payment={} 사유={} (PG 승인 후 좌석 확정 실패)",
                    payment.getId(), cause.getErrorCode());
            throw cause;
        }
        Payment current = paymentRepository.findById(payment.getId()).orElse(null);
        if (current != null && current.getStatus() == PaymentStatus.APPROVED) {
            return new PayResult(PaymentView.from(current), true);
        }
        throw cause;
    }

    /** PENDING→FAILED 조건부 전이. true면 이 요청이 실패 확정의 소유자다 */
    private boolean markFailed(long paymentId) {
        return paymentRepository.transition(paymentId, PaymentStatus.PENDING, PaymentStatus.FAILED) == 1;
    }

    /** 선점 좌석이 전부 본인 소유로 살아있는지 — 죽었으면 409 HOLD_EXPIRED */
    private void assertHoldAlive(Reservation reservation) {
        if (reservation.getHoldGroupId() == null) {
            throw new DomainException(ErrorCode.HOLD_EXPIRED);
        }
        long alive = showSeatRepository.countAliveInGroup(
                reservation.getHoldGroupId(), reservation.getUserId(), Instant.now());
        if (alive != reservation.getSeatCount()) {
            throw new DomainException(ErrorCode.HOLD_EXPIRED);
        }
    }

    /** 요청 바디 지문 — 필드 순서를 고정해 같은 내용이면 항상 같은 해시가 나온다 */
    public static String hashRequest(CreatePaymentRequest request) {
        String canonical = "{\"reservationId\":" + request.reservationId()
                + ",\"method\":\"" + request.method().name() + "\"}";
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256은 모든 JVM에 필수 구현이다", e);
        }
    }
}
