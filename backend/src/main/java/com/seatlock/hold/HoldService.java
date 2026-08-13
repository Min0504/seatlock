package com.seatlock.hold;

import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.hold.SeatStateRepository.ReleasedSeat;
import com.seatlock.hold.dto.HoldDtos;
import com.seatlock.hold.dto.HoldDtos.HeldSeat;
import com.seatlock.hold.dto.HoldDtos.HoldResponse;
import com.seatlock.hold.dto.HoldDtos.ReleaseResponse;
import com.seatlock.show.SeatMapCache;
import com.seatlock.show.Show;
import com.seatlock.show.ShowRepository;
import com.seatlock.show.ShowSeat;
import com.seatlock.show.ShowSeatRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class HoldService {

    public static final Duration HOLD_TTL = Duration.ofMinutes(5);

    private final ShowRepository showRepository;
    private final ShowSeatRepository showSeatRepository;
    private final SeatStateRepository seatStateRepository;
    private final SeatMapCache seatMapCache;

    /**
     * [실험: 낙관적 락] 좌석 선점 — 잠그지 않고 읽고, 커밋 때 버전으로 판정한다.
     *
     * 본선(조건부 UPDATE)과의 구조 차이:
     * - 읽기 시점에는 아무 잠금이 없다. flush되는 UPDATE에 JPA가
     *   "WHERE version = 읽은값"을 붙이고, 그 사이 누가 먼저 커밋했으면 갱신
     *   0건 → OptimisticLockException. "충돌은 드물다"에 베팅하는 전략이다.
     * - 티케팅은 그 베팅이 정확히 반대로 걸리는 도메인이다 — 인기 좌석은 충돌이
     *   기본값이라, 패자들이 트랜잭션을 끝까지 실행하고 나서야 실패를 안다
     *   (헛수고 비용). 읽기 위주·충돌 희귀 도메인(마이페이지 수정 등)에서 빛난다.
     * - flush를 메서드 안에서 명시 호출하는 이유: 기본 flush는 커밋 시점(트랜잭션
     *   프록시 내부)이라 예외가 서비스 밖에서 터져 500이 된다. 안에서 flush해야
     *   버전 충돌을 도메인 에러(409)로 번역할 수 있다.
     *
     * 측정 결과와 트레이드오프 분석: docs/lock-benchmark.md
     */
    @Transactional
    public HoldResponse hold(Long showId, long userId, List<Long> seatIds) {
        Show show = showRepository.findById(showId)
                .orElseThrow(() -> new DomainException(ErrorCode.SHOW_NOT_FOUND));
        Instant now = Instant.now();
        if (show.getTicketOpenAt().isAfter(now)) {
            throw new DomainException(ErrorCode.TICKET_NOT_OPEN,
                    Map.<String, Object>of("ticketOpenAt", show.getTicketOpenAt().toString()));
        }

        // 중복 id가 섞이면 조회 결과가 요청 수보다 적다 — 존재하지 않는 좌석과 같은 404
        List<ShowSeat> seats = showSeatRepository.findAllWithSeat(seatIds, showId);
        if (seats.size() != seatIds.size()) {
            throw new DomainException(ErrorCode.SEAT_NOT_FOUND);
        }

        // 1인 보유 상한 — UX 규칙이라 근사 검증으로 충분하다
        long activeHolds = showSeatRepository.countActiveHolds(showId, userId, now);
        if (activeHolds + seatIds.size() > HoldDtos.MAX_SEATS_PER_HOLD) {
            throw new DomainException(ErrorCode.HOLD_LIMIT_EXCEEDED);
        }

        // 1차 검사 — 이미 남의 좌석인 것은 버전 충돌까지 갈 것 없이 여기서 걸러
        // 실패 좌석을 details로 알린다 (경합이 아니라 확정된 사실이므로)
        List<Long> taken = seats.stream()
                .filter(ss -> !ss.holdable(now))
                .map(ShowSeat::getId)
                .toList();
        if (!taken.isEmpty()) {
            throw new DomainException(ErrorCode.SEAT_ALREADY_TAKEN, Map.<String, Object>of("seatIds", taken));
        }

        UUID holdGroupId = UUID.randomUUID();
        Instant expiresAt = now.plus(HOLD_TTL);
        seats.forEach(ss -> ss.applyHold(userId, holdGroupId, expiresAt));
        try {
            // 진짜 판정은 여기다: UPDATE ... WHERE version = 읽은값.
            // 읽기와 flush 사이에 다른 트랜잭션이 커밋했다면 갱신 0건 → 예외.
            showSeatRepository.flush();
        } catch (OptimisticLockingFailureException e) {
            // 경합 패배 — 전체 롤백(부분 선점 금지). 어느 좌석이 충돌했는지는
            // 예외가 알려주지 않으므로 details 없이 409만 반환한다.
            throw new DomainException(ErrorCode.SEAT_ALREADY_TAKEN);
        }

        List<HeldSeat> heldSeats = seats.stream()
                .sorted(Comparator.comparing(ShowSeat::getId))
                .map(ss -> new HeldSeat(
                        ss.getId(),
                        ss.getSeat().getSection(),
                        ss.getSeat().getRowNo(),
                        ss.getSeat().getSeatNo(),
                        ss.getPrice()))
                .toList();
        // 커밋 후 무효화 예약 — 롤백되면 실행되지 않는다 (SeatMapCache 주석 참조)
        seatMapCache.invalidate(showId);
        return new HoldResponse(holdGroupId, expiresAt, heldSeats);
    }

    /** 선점 취소 — 본인 소유의 HELD 좌석만 원복한다 (조건부 UPDATE라 중복 호출에도 안전) */
    public ReleaseResponse release(UUID holdGroupId, long userId) {
        List<ReleasedSeat> released = seatStateRepository.releaseByGroup(holdGroupId, userId);
        if (released.isEmpty()) {
            throw new DomainException(ErrorCode.HOLD_NOT_FOUND);
        }
        seatMapCache.invalidate(released.get(0).showId());
        return new ReleaseResponse(released.size());
    }
}
