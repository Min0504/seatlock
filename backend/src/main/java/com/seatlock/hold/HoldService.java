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
     * [실험: 비관적 락] 좌석 선점 — SELECT ... FOR UPDATE로 "잠금 → 검사 → 변경".
     *
     * 본선(조건부 UPDATE)과의 구조 차이:
     * - 본선은 검사와 변경이 UPDATE 한 문장이라 race가 성립하지 않고, 패자는 즉시
     *   갱신 0건으로 실패한다(대기 없음).
     * - 이 방식은 행 잠금을 먼저 획득한 뒤 애플리케이션에서 검사한다. 경합 패자는
     *   승자의 커밋까지 "줄을 선다" — FOR UPDATE 대기 시간 + 커넥션 점유가 비용이다.
     *   대신 잠금 이후의 검증 로직을 여러 단계로 자유롭게 쓸 수 있다(다단계 검증이
     *   필요한 도메인에서 이 방식이 정당화된다).
     * - 잠금 순서는 findAllForUpdate의 ORDER BY ss.id가 통일한다 — 교착 예방.
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

        // 잠금이 가장 먼저다. 잠그기 전에 읽은 상태는 검사에 쓰면 안 된다 —
        // 읽기(비잠금)와 잠금 사이에 다른 트랜잭션이 커밋하면 영속성 컨텍스트에
        // 낡은 스냅샷이 남아 check-then-act race가 부활한다.
        List<ShowSeat> locked = showSeatRepository.findAllForUpdate(seatIds, showId);
        // 중복 id가 섞이면 조회 결과가 요청 수보다 적다 — 존재하지 않는 좌석과 같은 404
        if (locked.size() != seatIds.size()) {
            throw new DomainException(ErrorCode.SEAT_NOT_FOUND);
        }

        // 1인 보유 상한 — UX 규칙이라 근사 검증으로 충분하다
        long activeHolds = showSeatRepository.countActiveHolds(showId, userId, now);
        if (activeHolds + seatIds.size() > HoldDtos.MAX_SEATS_PER_HOLD) {
            throw new DomainException(ErrorCode.HOLD_LIMIT_EXCEEDED);
        }

        // 잠금 아래에서의 검사 — 지금부터 커밋까지 이 좌석들은 우리 것이다
        List<Long> taken = locked.stream()
                .filter(ss -> !ss.holdable(now))
                .map(ShowSeat::getId)
                .toList();
        if (!taken.isEmpty()) {
            // 하나라도 선점 불가 → 전체 실패(부분 선점 금지). 변경 전이라 롤백할 것도 없다.
            throw new DomainException(ErrorCode.SEAT_ALREADY_TAKEN, Map.<String, Object>of("seatIds", taken));
        }

        UUID holdGroupId = UUID.randomUUID();
        Instant expiresAt = now.plus(HOLD_TTL);
        // 변경 감지(dirty checking) — UPDATE는 커밋 직전 flush에서 나간다
        locked.forEach(ss -> ss.applyHold(userId, holdGroupId, expiresAt));

        // 응답용 좌석 정보 — 같은 영속성 컨텍스트의 관리 엔티티에 seat만 fetch join으로 채운다
        List<HeldSeat> heldSeats = showSeatRepository.findAllWithSeat(seatIds, showId).stream()
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
