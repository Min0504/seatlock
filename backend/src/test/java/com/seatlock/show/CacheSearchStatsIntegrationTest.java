package com.seatlock.show;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.performance.Performance;
import com.seatlock.performance.PerformanceListCache;
import com.seatlock.performance.Venue;
import com.seatlock.support.PaymentTestSupport;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 읽기 경로 성능 3종 검증 (Nest cache-search-stats e2e 포팅) — 기획서 §9·§4.
 *
 * 캐시 테스트의 공통 기법: "DB를 직접 바꿔도 응답이 안 바뀌면 캐시가 일하고 있는 것".
 * 캐시 히트는 응답만 보면 미스와 구분되지 않으므로, 무효화를 우회한 변경(직접 UPDATE)이
 * 보이지 않는 것으로 히트를 증명하고, 무효화 후 보이는 것으로 정합 복구를 증명한다.
 */
@DisplayName("좌석맵 캐시 · pg_trgm 검색 · 판매 통계")
class CacheSearchStatsIntegrationTest extends PaymentTestSupport {

    @Autowired
    private SeatMapCache seatMapCache;

    @Autowired
    private PerformanceListCache listCache;

    @Autowired
    private TransactionTemplate transactionTemplate;

    @BeforeEach
    void reset() {
        truncateAll();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> seatMap(long showId) {
        ResponseEntity<Map<String, Object>> res = get("/shows/" + showId + "/seats", null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) res.getBody().get("seats");
    }

    private String seatStatusInMap(List<Map<String, Object>> seats, long seatId) {
        return seats.stream()
                .filter(s -> ((Number) s.get("id")).longValue() == seatId)
                .findFirst().map(s -> (String) s.get("status")).orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private List<String> listTitles() {
        ResponseEntity<Map<String, Object>> res = get("/performances", null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return ((List<Map<String, Object>>) res.getBody().get("items")).stream()
                .map(i -> (String) i.get("title"))
                .toList();
    }

    /** 서비스 계층(무효화)을 우회하는 공연 삽입 — 캐시 히트를 증명하는 도구 */
    private void insertPerformanceBypassingCache(String title) {
        Venue venue = venueRepository.save(Venue.builder().name("우회 삽입 홀").address("서울").build());
        performanceRepository.save(Performance.builder().title(title).venue(venue).build());
    }

    // ── 1. 좌석맵 캐시 ──────────────────────────────────────────────

    @Test
    @DisplayName("좌석맵은 캐시에서 나온다 — 무효화를 우회한 DB 직접 변경은 보이지 않는다")
    void seatMapServedFromCache() {
        SeededShow show = seedShow(3, Instant.now().minus(1, ChronoUnit.HOURS));
        long probe = show.seatIds().get(0);

        assertThat(seatStatusInMap(seatMap(show.showId()), probe)).isEqualTo("AVAILABLE"); // 캐시를 심는다

        // 서비스 계층을 우회한 직접 UPDATE — 무효화가 일어나지 않는 유일한 경로
        jdbc.update("UPDATE show_seats SET status = 'RESERVED' WHERE id = ?", probe);

        // 여전히 AVAILABLE = 응답이 DB가 아니라 캐시에서 왔다는 증거
        assertThat(seatStatusInMap(seatMap(show.showId()), probe)).isEqualTo("AVAILABLE");

        // 무효화하면 즉시 최신 상태가 보인다
        seatMapCache.invalidate(show.showId());
        assertThat(seatStatusInMap(seatMap(show.showId()), probe)).isEqualTo("RESERVED");
    }

    @Test
    @DisplayName("선점·해제가 캐시를 무효화한다 — TTL을 기다리지 않고 즉시 반영된다")
    void holdAndReleaseInvalidate() {
        SeededShow show = seedShow(3, Instant.now().minus(1, ChronoUnit.HOURS));
        long target = show.seatIds().get(0);
        TestUser user = newUser();

        seatMap(show.showId()); // 캐시를 심는다

        ResponseEntity<Map<String, Object>> held =
                post("/shows/" + show.showId() + "/holds", Map.of("seatIds", List.of(target)), user.token());
        assertThat(held.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // 캐시 TTL(5초)이 남아 있어도 HELD가 즉시 보인다 = 선점이 무효화를 수행했다
        assertThat(seatStatusInMap(seatMap(show.showId()), target)).isEqualTo("HELD");

        ResponseEntity<Map<String, Object>> released =
                delete("/holds/" + held.getBody().get("holdGroupId"), user.token());
        assertThat(released.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(seatStatusInMap(seatMap(show.showId()), target)).isEqualTo("AVAILABLE");
    }

    @Test
    @DisplayName("무효화가 없어도 TTL(5초)이 지나면 최신 상태로 수렴한다")
    void ttlConvergence() throws Exception {
        SeededShow show = seedShow(2, Instant.now().minus(1, ChronoUnit.HOURS));
        long probe = show.seatIds().get(0);

        seatMap(show.showId()); // 캐시를 심는다
        jdbc.update("UPDATE show_seats SET status = 'RESERVED' WHERE id = ?", probe);

        // TTL 안: 캐시가 옛 상태를 답한다 (의도된 최대 5초의 신선도 창)
        assertThat(seatStatusInMap(seatMap(show.showId()), probe)).isEqualTo("AVAILABLE");

        Thread.sleep(SeatMapCache.TTL.plusSeconds(1).toMillis());
        assertThat(seatStatusInMap(seatMap(show.showId()), probe)).isEqualTo("RESERVED");
    }

    @Test
    @DisplayName("결제 확정과 예매 취소도 캐시를 무효화한다 — 판매 상태가 즉시 보인다")
    void paymentAndCancelInvalidate() {
        SeededShow show = seedShow(2, Instant.now().minus(1, ChronoUnit.HOURS));
        long seat = show.seatIds().get(0);
        TestUser buyer = newUser();

        HeldReservation reservation = holdAndReserve(show.showId(), buyer, List.of(seat));
        seatMap(show.showId()); // HELD 상태로 캐시를 심는다

        assertThat(pay(buyer, UUID.randomUUID().toString(), reservation.reservationId())
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        // TTL이 남아 있어도 RESERVED가 즉시 보인다 = 결제 확정이 무효화를 수행했다
        assertThat(seatStatusInMap(seatMap(show.showId()), seat)).isEqualTo("RESERVED");

        assertThat(delete("/reservations/" + reservation.reservationId(), buyer.token())
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(seatStatusInMap(seatMap(show.showId()), seat)).isEqualTo("AVAILABLE");
    }

    // ── 2. pg_trgm 검색 ────────────────────────────────────────────

    @Test
    @DisplayName("검색은 대소문자를 무시한다 (ILIKE)")
    void caseInsensitiveSearch() {
        insertPerformanceBypassingCache("Hamilton");

        ResponseEntity<Map<String, Object>> res = get("/performances?q=hamilton", null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) res.getBody().get("items");
        assertThat(items).hasSize(1);
        assertThat(items.get(0).get("title")).isEqualTo("Hamilton");
    }

    @Test
    @DisplayName("ILIKE 검색이 GIN(gin_trgm_ops) 인덱스를 사용할 수 있다 (EXPLAIN 검증)")
    void searchCanUseGinIndex() {
        insertPerformanceBypassingCache("오페라의 유령");

        // 소규모 테이블에서는 플래너가 seq scan을 선호하므로 seqscan을 꺼서
        // "이 연산자가 이 인덱스로 처리 가능한가"라는 사실 자체를 검증한다
        String plan = transactionTemplate.execute(tx -> {
            jdbc.execute("SET LOCAL enable_seqscan = off");
            return String.join("\n", jdbc.queryForList(
                    "EXPLAIN SELECT id FROM performances WHERE search_text ILIKE '%오페라%'", String.class));
        });
        assertThat(plan).contains("performances_search_text_trgm_idx");
    }

    // ── 3. 공연 목록 캐시 ──────────────────────────────────────────

    @Test
    @DisplayName("목록 첫 페이지가 캐시된다 — 무효화를 우회한 직접 INSERT는 보이지 않는다")
    void firstPageCached() {
        insertPerformanceBypassingCache("원래 있던 공연");
        int before = listTitles().size(); // 캐시를 심는다

        insertPerformanceBypassingCache("직접 삽입 공연");
        assertThat(listTitles()).hasSize(before); // 캐시가 답했다

        listCache.invalidate();
        assertThat(listTitles()).hasSize(before + 1);
    }

    @Test
    @DisplayName("검색·커서 요청은 캐시를 우회한다 — 방금 만든 공연이 바로 검색된다")
    void searchBypassesListCache() {
        listTitles(); // 첫 페이지 캐시를 심는다
        insertPerformanceBypassingCache("우회 검증 공연");

        // 검색 경로는 캐시가 없으므로 즉시 보인다
        ResponseEntity<Map<String, Object>> search = get("/performances?q=우회 검증", null);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) search.getBody().get("items");
        assertThat(items).hasSize(1);

        // 반면 캐시된 첫 페이지에는 아직 없다
        assertThat(listTitles()).doesNotContain("우회 검증 공연");
    }

    @Test
    @DisplayName("공연 등록 API는 목록 캐시를 무효화한다 — 등록 직후 목록에 보인다")
    void createInvalidatesListCache() {
        TestUser admin = newAdmin();
        Venue venue = venueRepository.save(Venue.builder().name("등록 홀").address("서울").build());
        listTitles(); // 캐시를 심는다

        ResponseEntity<Map<String, Object>> created = post("/admin/performances",
                Map.of("title", "등록 직후 보이는 공연", "venueId", venue.getId()), admin.token());
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        assertThat(listTitles()).contains("등록 직후 보이는 공연");
    }

    // ── 4. 판매 통계 ───────────────────────────────────────────────

    /** 4석 중 2석 결제(매출 20만)·1석 선점 상태를 만든다 — 통계 시나리오 공용 픽스처 */
    private record StatsFixture(long showId, String extraHoldGroupId) {
    }

    private StatsFixture seedStatsScenario() {
        SeededShow show = seedShow(4, Instant.now().minus(1, ChronoUnit.HOURS));
        TestUser buyer = newUser();

        HeldReservation reservation =
                holdAndReserve(show.showId(), buyer, show.seatIds().subList(0, 2));
        assertThat(pay(buyer, UUID.randomUUID().toString(), reservation.reservationId())
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);

        ResponseEntity<Map<String, Object>> extraHold = post("/shows/" + show.showId() + "/holds",
                Map.of("seatIds", List.of(show.seatIds().get(2))), buyer.token());
        assertThat(extraHold.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return new StatsFixture(show.showId(), (String) extraHold.getBody().get("holdGroupId"));
    }

    @Test
    @DisplayName("판매율·매출·좌석 상태 분포를 집계한다")
    void statsAggregation() {
        StatsFixture fixture = seedStatsScenario();
        TestUser admin = newAdmin();

        ResponseEntity<Map<String, Object>> res =
                get("/admin/shows/" + fixture.showId() + "/stats", admin.token());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat(body).containsEntry("totalSeats", 4)
                .containsEntry("reservedSeats", 2)
                .containsEntry("heldSeats", 1)
                .containsEntry("availableSeats", 1)
                .containsEntry("salesRate", 0.5)
                .containsEntry("revenue", 200000);
        assertThat(body.get("generatedAt")).isNotNull();
    }

    @Test
    @DisplayName("통계는 5분 캐시된다 — 직후의 상태 변화는 다음 TTL까지 보이지 않는다")
    void statsCachedSnapshot() {
        StatsFixture fixture = seedStatsScenario();
        TestUser admin = newAdmin();

        get("/admin/shows/" + fixture.showId() + "/stats", admin.token()); // 캐시를 심는다

        // 선점 좌석을 DB에서 직접 반납해도…
        jdbc.update("UPDATE show_seats SET status = 'AVAILABLE', hold_user_id = NULL, "
                + "hold_group_id = NULL, hold_expires_at = NULL WHERE hold_group_id = ?::uuid",
                fixture.extraHoldGroupId());

        // …통계는 캐시된 스냅샷을 답한다 (관리자 대시보드에 5분 신선도는 충분)
        ResponseEntity<Map<String, Object>> res =
                get("/admin/shows/" + fixture.showId() + "/stats", admin.token());
        assertThat(res.getBody()).containsEntry("heldSeats", 1);
    }

    @Test
    @DisplayName("일반 사용자는 통계에 접근할 수 없다 (403)")
    void statsForbiddenForUser() {
        SeededShow show = seedShow(1, Instant.now().minus(1, ChronoUnit.HOURS));
        TestUser user = newUser();

        ResponseEntity<Map<String, Object>> res =
                get("/admin/shows/" + show.showId() + "/stats", user.token());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    @DisplayName("존재하지 않는 회차의 통계는 404를 반환한다")
    void statsUnknownShow() {
        TestUser admin = newAdmin();

        ResponseEntity<Map<String, Object>> res = get("/admin/shows/999999/stats", admin.token());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody().get("code")).isEqualTo("SHOW_NOT_FOUND");
    }
}
