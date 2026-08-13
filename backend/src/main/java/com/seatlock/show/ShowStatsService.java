package com.seatlock.show;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.seatlock.common.cache.CacheClient;
import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.show.dto.ShowDtos.ShowStats;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * 회차별 판매 통계 (기획서 §4 관리자 판매 통계, §9 캐시 전략 — 통계 TTL 5m).
 *
 * 집계는 실시간 GROUP BY로 계산하고 5분 캐시로 감싼다. 배치 사전 집계(별도 테이블)와
 * 비교하면: 회차당 좌석 수천 행의 단일 인덱스 스캔 집계는 캐시 미스 시에도 수 ms라
 * 사전 집계가 해결할 문제(수억 행 스캔)가 아직 없다 — 단순한 쪽을 선택했다.
 * 관리자 대시보드는 5분 신선도로 충분하므로 무효화 없이 TTL 만료에만 맡긴다.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ShowStatsService {

    public static final Duration TTL = Duration.ofMinutes(5);

    private final ShowRepository showRepository;
    private final JdbcTemplate jdbcTemplate;
    private final CacheClient cache;
    private final ObjectMapper objectMapper;

    static String key(long showId) {
        return "show:" + showId + ":stats";
    }

    public ShowStats getStats(long showId) {
        Optional<String> cached = cache.tryGet("통계 캐시 조회", key(showId));
        if (cached.isPresent()) {
            try {
                return objectMapper.readValue(cached.get(), ShowStats.class);
            } catch (JsonProcessingException e) {
                log.warn("통계 캐시 역직렬화 실패 — DB로 폴백: {}", e.getMessage());
            }
        }

        if (!showRepository.existsById(showId)) {
            throw new DomainException(ErrorCode.SHOW_NOT_FOUND);
        }

        // 좌석 집계와 매출을 한 왕복으로: FILTER 절은 조건별 count를 단일 스캔에서 뽑고,
        // 매출은 payments(APPROVED)의 합 — 좌석 수 × 가격으로 역산하지 않는 이유는
        // 환불·부분 취소가 생겨도 "돈의 사실"은 결제 원장에만 있기 때문이다.
        ShowStats stats = jdbcTemplate.queryForObject("""
                SELECT
                  count(*)::int                                                            AS total_seats,
                  count(*) FILTER (WHERE status = 'RESERVED')::int                         AS reserved_seats,
                  count(*) FILTER (WHERE status = 'HELD' AND hold_expires_at > now())::int AS held_seats,
                  (SELECT coalesce(sum(p.amount), 0)::int
                     FROM payments p
                     JOIN reservations r ON r.id = p.reservation_id
                    WHERE r.show_id = ? AND p.status = 'APPROVED')                         AS revenue
                FROM show_seats
                WHERE show_id = ?
                """,
                (rs, i) -> {
                    int total = rs.getInt("total_seats");
                    int reserved = rs.getInt("reserved_seats");
                    int held = rs.getInt("held_seats");
                    return new ShowStats(
                            showId,
                            total,
                            reserved,
                            held,
                            total - reserved - held,
                            total == 0 ? 0 : Math.round(reserved * 10000.0 / total) / 10000.0,
                            rs.getInt("revenue"),
                            Instant.now());
                },
                showId, showId);

        try {
            cache.trySet("통계 캐시 저장", key(showId), objectMapper.writeValueAsString(stats), TTL);
        } catch (JsonProcessingException e) {
            log.warn("통계 캐시 직렬화 실패 — 이번 응답은 캐시 없이 반환: {}", e.getMessage());
        }
        return stats;
    }
}
