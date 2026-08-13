package com.seatlock.reservation;

import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.hold.SeatStateRepository;
import com.seatlock.payment.MockPgClient;
import com.seatlock.payment.Payment;
import com.seatlock.payment.PaymentRepository;
import com.seatlock.payment.PaymentStatus;
import com.seatlock.reservation.dto.ReservationDtos.CancelResult;
import com.seatlock.reservation.dto.ReservationDtos.CreatedReservation;
import com.seatlock.reservation.dto.ReservationDtos.MyReservationsResponse;
import com.seatlock.reservation.dto.ReservationDtos.ReservationSummary;
import com.seatlock.reservation.dto.ReservationDtos.SeatLine;
import com.seatlock.reservation.dto.ReservationDtos.ShowLine;
import com.seatlock.show.SeatMapCache;
import com.seatlock.show.SeatStatus;
import com.seatlock.show.ShowRepository;
import com.seatlock.show.ShowSeat;
import com.seatlock.show.ShowSeatRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Slf4j
@Service
@RequiredArgsConstructor
public class ReservationService {

    /** 공연 시작 24시간 전까지만 취소 가능 (기획서 §6 API 계약) */
    public static final Duration CANCEL_DEADLINE = Duration.ofHours(24);

    private static final int DEFAULT_SIZE = 20;

    private final ReservationRepository reservationRepository;
    private final ReservationSeatRepository reservationSeatRepository;
    private final ReservationStateRepository reservationStateRepository;
    private final SeatStateRepository seatStateRepository;
    private final PaymentRepository paymentRepository;
    private final ShowSeatRepository showSeatRepository;
    private final ShowRepository showRepository;
    private final MockPgClient pg;
    private final SeatMapCache seatMapCache;
    private final TransactionTemplate transactionTemplate;

    /** 취소 트랜잭션 도중 예매 상태가 바뀐 경우의 내부 신호 — 롤백 후 재판정 트리거 */
    private static class StateChangedDuringCancel extends RuntimeException {
    }

    /**
     * 선점 좌석으로 미결제(PENDING) 예매를 생성한다. 좌석 상태는 바꾸지 않는다.
     *
     * 의도적으로 @Transactional을 붙이지 않았다: 부분 유니크 충돌을 잡아 기존 예매를
     * 재조회하는 멱등화 경로가 있는데, PostgreSQL은 제약 위반이 난 트랜잭션을
     * abort 상태로 만들어 같은 트랜잭션의 후속 SELECT까지 전부 거부한다.
     * save(INSERT)를 자체 트랜잭션으로 커밋/실패시키고 재조회는 새 트랜잭션에서 한다.
     */
    public CreatedReservation create(long userId, UUID holdGroupId) {
        List<ShowSeat> seats = showSeatRepository
                .findByHoldGroupIdAndHoldUserIdAndStatus(holdGroupId, userId, SeatStatus.HELD);
        if (seats.isEmpty()) {
            throw new DomainException(ErrorCode.HOLD_NOT_FOUND);
        }
        Instant now = Instant.now();
        if (seats.stream().anyMatch(s -> s.getHoldExpiresAt() != null && s.getHoldExpiresAt().isBefore(now))) {
            throw new DomainException(ErrorCode.HOLD_EXPIRED);
        }

        // 금액은 항상 서버가 DB의 가격으로 계산한다 — 클라이언트 전달 금액은 신뢰하지 않는다
        int totalPrice = seats.stream().mapToInt(ShowSeat::getPrice).sum();
        Instant payUntil = seats.stream()
                .map(ShowSeat::getHoldExpiresAt)
                .filter(java.util.Objects::nonNull)
                .min(Comparator.naturalOrder())
                .orElse(null);

        try {
            // getReferenceById: FK 값만 필요하므로 SELECT 없이 지연 프록시로 참조만 건다
            Reservation reservation = reservationRepository.save(Reservation.builder()
                    .userId(userId)
                    .show(showRepository.getReferenceById(seats.get(0).getShowId()))
                    .status(ReservationStatus.PENDING)
                    .totalPrice(totalPrice)
                    .seatCount(seats.size())
                    .holdGroupId(holdGroupId)
                    .build());
            return new CreatedReservation(
                    reservation.getId(), reservation.getStatus(), totalPrice, seats.size(), payUntil);
        } catch (DataIntegrityViolationException e) {
            // 부분 유니크(hold_group_id WHERE status='PENDING') 충돌 = 같은 선점으로 이미
            // 만든 미결제 예매가 있다 → 새로 만들지 않고 그대로 반환(생성의 멱등화)
            Reservation existing = reservationRepository
                    .findFirstByHoldGroupIdAndUserIdAndStatus(holdGroupId, userId, ReservationStatus.PENDING)
                    .orElseThrow(() -> e);
            return new CreatedReservation(
                    existing.getId(), existing.getStatus(),
                    existing.getTotalPrice(), existing.getSeatCount(), payUntil);
        }
    }

    /**
     * 예매 취소 (Nest ReservationsService.cancel 포팅). 상태 기계 전이는 전부 조건부
     * UPDATE로 원자화한다 — 취소 직후의 신규 선점, 동시 이중 취소, 취소와 결제 승인의
     * 경합(기획서 장애 시나리오 5)이 모두 "WHERE가 곧 판정"인 한 문장으로 직렬화된다.
     */
    public CancelResult cancel(long userId, long reservationId) {
        Reservation reservation = reservationRepository.findWithShowById(reservationId).orElse(null);
        // 남의 예매는 존재 자체를 숨긴다(404) — IDOR 차단
        if (reservation == null || !reservation.getUserId().equals(userId)) {
            throw new DomainException(ErrorCode.RESERVATION_NOT_FOUND);
        }
        // 반복 취소는 멱등 — 이미 취소된 상태를 그대로 반환한다 (DELETE의 재시도 안전)
        if (reservation.getStatus() == ReservationStatus.CANCELED) {
            return new CancelResult(reservationId, ReservationStatus.CANCELED, 0);
        }

        long showId = reservation.getShow().getId();
        if (reservation.getStatus() == ReservationStatus.PENDING) {
            return cancelPending(userId, reservationId, reservation.getHoldGroupId(), showId);
        }
        return cancelConfirmed(reservationId, reservation.getShow().getStartsAt(), showId);
    }

    /**
     * 미결제 예매 취소 — 환불이 없으므로 24시간 규칙을 적용하지 않고,
     * 선점 좌석을 즉시 반납해 다른 사람이 살 수 있게 한다.
     *
     * 갱신 순서는 결제 확정 트랜잭션과 동일하게 "좌석 → 예매"다. 순서가 어긋나면
     * 같은 예매에 결제와 취소가 동시에 달릴 때 서로의 행 잠금을 기다리는
     * 교착(deadlock)이 생길 수 있다 — 잠금 순서 통일이 교착 예방의 기본이다.
     */
    private CancelResult cancelPending(long userId, long reservationId, UUID holdGroupId, long showId) {
        int released;
        try {
            Integer count = transactionTemplate.execute(tx -> {
                int seats = holdGroupId == null
                        ? 0
                        : seatStateRepository.releaseByGroup(holdGroupId, userId).size();
                // 그 사이 결제가 확정됐거나(CONFIRMED) 다른 요청이 취소했다 —
                // 좌석 반납까지 통째로 롤백하고 바깥에서 새 상태 기준으로 재판정한다.
                // 반대로 이 취소가 이기면, 진행 중이던 결제 승인은 확정 트랜잭션의
                // "예매 PENDING→CONFIRMED" 조건부 UPDATE 0건으로 롤백 + 보상 취소(환불)된다.
                if (!reservationStateRepository.transition(
                        reservationId, ReservationStatus.PENDING, ReservationStatus.CANCELED)) {
                    throw new StateChangedDuringCancel();
                }
                return seats;
            });
            released = count != null ? count : 0;
        } catch (StateChangedDuringCancel e) {
            return cancel(userId, reservationId);
        }
        if (released > 0) {
            seatMapCache.invalidate(showId);
        }
        return new CancelResult(reservationId, ReservationStatus.CANCELED, released);
    }

    /** 결제 완료 예매 취소 — 좌석 원복 + 결제 CANCELED + PG 환불(mock) */
    private CancelResult cancelConfirmed(long reservationId, Instant startsAt, long showId) {
        if (Duration.between(Instant.now(), startsAt).compareTo(CANCEL_DEADLINE) < 0) {
            throw new DomainException(ErrorCode.CANCEL_WINDOW_CLOSED);
        }

        record Outcome(int releasedSeats, String refundOrderId) {
        }
        Outcome outcome = transactionTemplate.execute(tx -> {
            if (!reservationStateRepository.transition(
                    reservationId, ReservationStatus.CONFIRMED, ReservationStatus.CANCELED)) {
                return null; // 동시 취소 경합에서 진 쪽 — 이미 CANCELED다
            }

            // 확정 연결을 취소 이력으로 남긴다(행 삭제가 아니라 canceled=true) —
            // 부분 유니크 인덱스(WHERE canceled=false)에서 빠지며 좌석 재판매가 열린다
            List<Long> seatIds = reservationStateRepository.cancelSeatLinks(reservationId);
            seatStateRepository.restoreReserved(seatIds);

            Payment payment = paymentRepository
                    .findFirstByReservationIdAndStatusIn(reservationId, List.of(PaymentStatus.APPROVED))
                    .orElse(null);
            if (payment != null) {
                paymentRepository.transition(payment.getId(), PaymentStatus.APPROVED, PaymentStatus.CANCELED);
            }
            return new Outcome(seatIds.size(), payment != null ? payment.getIdempotencyKey().toString() : null);
        });

        if (outcome == null) {
            return new CancelResult(reservationId, ReservationStatus.CANCELED, 0);
        }
        seatMapCache.invalidate(showId);
        // 환불은 DB 확정 후 실행한다. mock PG의 cancel은 멱등이라 재시도에 안전하지만,
        // 실 PG라면 "DB는 취소됐는데 환불 요청이 유실"될 수 있는 지점 — 아웃박스/재시도가
        // 필요한 주제이며 이 포트폴리오에서는 HookRelay가 그 문제를 전담한다.
        if (outcome.refundOrderId() != null) {
            pg.cancel(outcome.refundOrderId());
            log.info("환불 완료 — reservation={}", reservationId);
        }
        return new CancelResult(reservationId, ReservationStatus.CANCELED, outcome.releasedSeats());
    }

    @Transactional(readOnly = true)
    public MyReservationsResponse listMine(long userId, Long cursor, Integer size) {
        int limit = size != null ? size : DEFAULT_SIZE;
        List<Reservation> rows = cursor == null
                ? reservationRepository.findPage(userId, Limit.of(limit + 1))
                : reservationRepository.findPageAfter(userId, cursor, Limit.of(limit + 1));
        boolean hasNext = rows.size() > limit;
        List<Reservation> page = hasNext ? rows.subList(0, limit) : rows;

        // PENDING 예매의 좌석은 아직 reservation_seats가 없다 — 선점 그룹으로 일괄 조회.
        // 선점이 만료돼 회수됐다면 빈 목록 = 결제 불가능한 예매다.
        List<UUID> pendingGroupIds = page.stream()
                .filter(r -> r.getStatus() == ReservationStatus.PENDING && r.getHoldGroupId() != null)
                .map(Reservation::getHoldGroupId)
                .toList();
        Map<UUID, List<SeatLine>> seatsByGroup = pendingGroupIds.isEmpty() ? Map.of()
                : showSeatRepository.findAllWithSeatByHoldGroupIdIn(pendingGroupIds).stream()
                        .collect(Collectors.groupingBy(
                                ShowSeat::getHoldGroupId,
                                Collectors.mapping(ReservationService::toSeatLine, Collectors.toList())));

        // 확정 예매의 좌석은 reservation_seats에서 — 역시 페이지 단위 배치 조회
        List<Long> confirmedIds = page.stream()
                .filter(r -> r.getStatus() != ReservationStatus.PENDING)
                .map(Reservation::getId)
                .toList();
        Map<Long, List<SeatLine>> seatsByReservation = confirmedIds.isEmpty() ? Map.of()
                : reservationSeatRepository.findAllWithSeatByReservationIdIn(confirmedIds).stream()
                        .collect(Collectors.groupingBy(
                                ReservationSeat::getReservationId,
                                Collectors.mapping(
                                        rs -> toSeatLine(rs.getShowSeat()), Collectors.toList())));

        List<ReservationSummary> items = page.stream()
                .map(r -> new ReservationSummary(
                        r.getId(),
                        r.getStatus(),
                        r.getTotalPrice(),
                        r.getCreatedAt(),
                        new ShowLine(
                                r.getShow().getId(),
                                r.getShow().getStartsAt(),
                                r.getShow().getPerformance().getTitle()),
                        r.getStatus() == ReservationStatus.PENDING
                                ? seatsByGroup.getOrDefault(r.getHoldGroupId(), List.of())
                                : seatsByReservation.getOrDefault(r.getId(), List.of())))
                .toList();
        return new MyReservationsResponse(
                items, hasNext ? String.valueOf(items.get(items.size() - 1).id()) : null);
    }

    private static SeatLine toSeatLine(ShowSeat ss) {
        return new SeatLine(
                ss.getSeat().getSection(), ss.getSeat().getRowNo(), ss.getSeat().getSeatNo(), ss.getPrice());
    }
}
