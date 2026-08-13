package com.seatlock.hold;

import com.seatlock.show.SeatMapCache;
import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 만료 선점 회수 스케줄러 — 만료 방어의 "최종 권위" (기획서 §7 문제 2).
 *
 * 요청이 오지 않는 좌석은 lazy 판정(조회·선점 시점의 만료 처리)만으로는 영원히
 * HELD로 남는다. 누가 조회하지 않아도 30초마다 DB를 스캔해 회수하는 이 스위퍼가
 * 정합성의 책임을 진다. Nest 구현의 Redis TTL 알림(빠른 경로)은 Redis 도입과 함께
 * 다음 단계에서 포팅한다 — 알림은 UX(즉시성)용이고 권위는 어디까지나 스위퍼다.
 */
@Slf4j
@Component
@RequiredArgsConstructor
// 통합 테스트가 "만료됐지만 회수 전" 상태를 결정적으로 만들 수 있도록 끄는 스위치.
// 운영·개발 기본값은 켜짐(matchIfMissing) — 회수 로직 자체는 SeatStateRepository에
// 있으므로 테스트는 그쪽을 직접 호출해 같은 SQL을 검증한다.
@ConditionalOnProperty(name = "seatlock.hold-sweeper.enabled", havingValue = "true", matchIfMissing = true)
public class HoldSweeper {

    public static final long INTERVAL_MS = 30_000;

    private final SeatStateRepository seatStateRepository;
    private final SeatMapCache seatMapCache;

    // fixedDelay: 이전 실행이 끝난 뒤 30초 — 스캔이 오래 걸려도 실행이 겹치지 않는다
    @Scheduled(fixedDelay = INTERVAL_MS)
    public void sweep() {
        List<Long> reclaimedShowIds = seatStateRepository.reclaimExpired();
        if (!reclaimedShowIds.isEmpty()) {
            long[] showIds = reclaimedShowIds.stream().distinct().mapToLong(Long::longValue).toArray();
            seatMapCache.invalidate(showIds);
            log.info("만료 선점 {}석 회수 (회차 {}개 캐시 무효화)", reclaimedShowIds.size(), showIds.length);
        }
    }
}
