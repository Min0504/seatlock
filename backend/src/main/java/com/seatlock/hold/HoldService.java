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
import java.util.concurrent.TimeUnit;
import lombok.RequiredArgsConstructor;
import org.redisson.api.RLock;
import org.redisson.api.RedissonClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
@RequiredArgsConstructor
public class HoldService {

    public static final Duration HOLD_TTL = Duration.ofMinutes(5);

    /**
     * 락 점유 시간 상한. 트랜잭션은 ms 단위로 끝나므로 5초는 "홀더가 죽어도 이 안에
     * 자동 해제된다"는 안전장치다. 이 안에 트랜잭션이 안 끝나는 비정상 상황에서도
     * 초과판매는 없다 — 최종 권위는 아래 조건부 UPDATE이기 때문.
     */
    private static final long LOCK_LEASE_SECONDS = 5;

    private final ShowRepository showRepository;
    private final ShowSeatRepository showSeatRepository;
    private final SeatStateRepository seatStateRepository;
    private final SeatMapCache seatMapCache;
    private final RedissonClient redisson;
    private final TransactionTemplate tx;

    /**
     * [실험: Redis 분산락] 좌석 선점 — 경합을 DB 앞단에서 걸러낸다.
     *
     * 구조: 좌석별 RLock을 MultiLock으로 묶어 tryLock(대기 0) → 성공한 요청만
     * 트랜잭션에 진입 → 본선과 동일한 조건부 UPDATE 실행 → 커밋 후 unlock.
     *
     * 본선(조건부 UPDATE 단독)과의 차이:
     * - 패자의 실패 지점이 DB에서 Redis로 당겨진다. 본선에서 패자 99명은 전부
     *   행 락 대기열에 줄을 서서 승자의 커밋을 기다렸다 0건 갱신을 확인하지만,
     *   여기서는 Redis 왕복 1회로 즉시 탈락 — DB 커넥션을 아예 소비하지 않는다.
     *   "경합이 극단적일 때 DB 커넥션 고갈을 막는다"가 이 전략의 존재 이유.
     * - 대가: 정상 경로(승자)에 Redis 왕복이 추가되고, Redis라는 장애 지점이 생긴다.
     *
     * 정합성의 최종 권위는 여전히 DB다 — 락은 성능 최적화 계층일 뿐:
     * - lease(5초) 만료·Redis 장애·락을 안 지나는 쓰기 경로(스위퍼의 만료 회수 등)가
     *   있어도 조건부 UPDATE가 초과판매를 막는다. "분산락만 믿는" 설계는 락 소실
     *   시나리오(기획서 §7 비교표의 단점)에서 무너지므로 채택하지 않았다.
     *
     * 측정 결과와 트레이드오프 분석: docs/lock-benchmark.md
     */
    public HoldResponse hold(Long showId, long userId, List<Long> seatIds) {
        // 좌석 ID 정렬 — MultiLock은 목록 순서대로 잠그므로, 겹치는 좌석 집합을
        // 요청한 두 클라이언트가 서로 반대 순서로 잠그다 엇갈리는 낭비를 없앤다
        List<Long> sorted = seatIds.stream().sorted().distinct().toList();
        RLock lock = redisson.getMultiLock(sorted.stream()
                .map(id -> redisson.getLock("lock:hold:%d:%d".formatted(showId, id)))
                .toArray(RLock[]::new));

        boolean locked;
        try {
            // 대기 0초 — "선착순 실패는 즉시 실패" UX(기획서 §7). 대기열에 세우는
            // 순간 락 보유 시간과 커넥션 점유가 늘어나 비관적 락과 같은 병목이 된다.
            locked = lock.tryLock(0, LOCK_LEASE_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DomainException(ErrorCode.SEAT_ALREADY_TAKEN);
        }
        if (!locked) {
            // 다른 요청이 같은 좌석을 처리 중 — DB를 건드리지 않고 탈락.
            // 어느 좌석이 문제인지는 모르므로(락 실패는 원인을 안 알려준다) details 없음.
            throw new DomainException(ErrorCode.SEAT_ALREADY_TAKEN);
        }
        try {
            // 락 획득과 트랜잭션 경계를 분리한 이유: @Transactional 메서드 안에서
            // unlock하면 "커밋 전에 락이 풀리는" 순간이 생긴다. 락 → 트랜잭션 전체
            // → unlock 순서를 코드로 강제하기 위해 TransactionTemplate을 쓴다.
            return tx.execute(status -> doHold(showId, userId, seatIds));
        } finally {
            try {
                lock.unlock();
            } catch (IllegalMonitorStateException e) {
                // lease 만료로 이미 풀린 락 — 정합성은 조건부 UPDATE가 지켰으므로 무시
            }
        }
    }

    /** 트랜잭션 본체 — 본선(조건부 UPDATE) 구현과 동일하다. 락은 이 앞의 필터일 뿐. */
    private HoldResponse doHold(Long showId, long userId, List<Long> seatIds) {
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

        UUID holdGroupId = UUID.randomUUID();
        Instant expiresAt = now.plus(HOLD_TTL);
        Set<Long> won = new HashSet<>(
                seatStateRepository.acquire(showId, seatIds, userId, holdGroupId, expiresAt));

        if (won.size() != seatIds.size()) {
            // 락은 "동시 요청"만 거른다. 이미 확정된 선점(락 해제 후 상태)은 여기서
            // 걸리며, 실패 좌석을 details로 알려 클라이언트가 다시 고르게 한다.
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
