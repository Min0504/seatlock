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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
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
     * 좌석 선점 (Nest HoldsService.hold 포팅) — 부분 선점 금지.
     *
     * 트랜잭션 경계가 곧 "전부 아니면 전무"다: 조건부 UPDATE가 요청 좌석 일부만
     * 이기면 예외를 던져 이긴 좌석까지 롤백한다. "2좌석 중 1좌석만 잡힘"은
     * 사용자에게 최악의 상태이기 때문이다.
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

        // 1인 보유 상한 — UX 규칙이라 근사 검증으로 충분하다(초과판매처럼 돈이 걸린
        // 불변식이 아니므로 이 검사와 아래 UPDATE 사이의 race는 수용한다)
        long activeHolds = showSeatRepository.countActiveHolds(showId, userId, now);
        if (activeHolds + seatIds.size() > HoldDtos.MAX_SEATS_PER_HOLD) {
            throw new DomainException(ErrorCode.HOLD_LIMIT_EXCEEDED);
        }

        UUID holdGroupId = UUID.randomUUID();
        Instant expiresAt = now.plus(HOLD_TTL);
        Set<Long> won = new HashSet<>(
                seatStateRepository.acquire(showId, seatIds, userId, holdGroupId, expiresAt));

        if (won.size() != seatIds.size()) {
            // 하나라도 선점 실패 → 예외로 전체 롤백. 실패 좌석을 details로 알려
            // 클라이언트가 해당 좌석만 다시 고르게 한다.
            List<Long> taken = seatIds.stream().filter(id -> !won.contains(id)).toList();
            throw new DomainException(ErrorCode.SEAT_ALREADY_TAKEN, Map.<String, Object>of("seatIds", taken));
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
