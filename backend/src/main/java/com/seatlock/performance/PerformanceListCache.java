package com.seatlock.performance;

import com.seatlock.common.cache.CacheClient;
import java.time.Duration;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 공연 목록 첫 페이지 캐시 (기획서 §9 — 공연 목록 TTL 60s, Nest 포팅).
 *
 * 좌석맵 캐시(5s + 즉시 무효화)와 달리 목록은 60초 신선도로 충분하다:
 * 목록에는 좌석 상태 같은 실시간 정보가 없고, 공연 등록은 ADMIN의 드문 이벤트라
 * 등록 시점의 무효화 한 번이면 정합이 맞는다.
 */
@Component
@RequiredArgsConstructor
public class PerformanceListCache {

    public static final Duration TTL = Duration.ofSeconds(60);
    private static final String KEY = "performances:list:first";

    private final CacheClient cache;

    public Optional<String> get() {
        return cache.tryGet("공연 목록 캐시 조회", KEY);
    }

    public void set(String json) {
        cache.trySet("공연 목록 캐시 저장", KEY, json, TTL);
    }

    public void invalidate() {
        cache.deleteAfterCommit("공연 목록 캐시 무효화", KEY);
    }
}
