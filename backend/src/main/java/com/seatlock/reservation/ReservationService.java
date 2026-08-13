package com.seatlock.reservation;

import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.reservation.dto.ReservationDtos.CreatedReservation;
import com.seatlock.reservation.dto.ReservationDtos.MyReservationsResponse;
import com.seatlock.reservation.dto.ReservationDtos.ReservationSummary;
import com.seatlock.reservation.dto.ReservationDtos.SeatLine;
import com.seatlock.reservation.dto.ReservationDtos.ShowLine;
import com.seatlock.show.SeatStatus;
import com.seatlock.show.ShowRepository;
import com.seatlock.show.ShowSeat;
import com.seatlock.show.ShowSeatRepository;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class ReservationService {

    private static final int DEFAULT_SIZE = 20;

    private final ReservationRepository reservationRepository;
    private final ReservationSeatRepository reservationSeatRepository;
    private final ShowSeatRepository showSeatRepository;
    private final ShowRepository showRepository;

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
