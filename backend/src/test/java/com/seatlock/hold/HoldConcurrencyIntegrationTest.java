package com.seatlock.hold;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.support.DomainTestSupport;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.IntStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * 이 프로젝트의 존재 증명 — 동일 좌석 동시 선점 (Nest hold-concurrency.e2e-spec 포팅).
 *
 * 요구 불변식: 같은 좌석에 100명이 동시에 달려들면 성공은 정확히 1건.
 * check-then-act 구현(SELECT 후 UPDATE)은 여러 트랜잭션이 같은 좌석을 동시에
 * AVAILABLE로 읽어 성공이 2건 이상 나온다 — 조건부 UPDATE 한 문장이 이를 막는다.
 */
@DisplayName("동일 좌석 동시 선점 — 초과판매 방지")
class HoldConcurrencyIntegrationTest extends DomainTestSupport {

    private static final int USERS = 100;

    private SeededShow show;

    @BeforeEach
    void setUp() {
        truncateAll();
        show = seedShow(4, Instant.now().minus(1, ChronoUnit.HOURS));
    }

    private ResponseEntity<Map<String, Object>> hold(String token, List<Long> seatIds) {
        return post("/shows/" + show.showId() + "/holds", Map.of("seatIds", seatIds), token);
    }

    @Test
    @DisplayName("같은 좌석에 100명이 동시 선점 요청하면 성공은 정확히 1건이어야 한다")
    void exactlyOneWinnerUnderContention() throws Exception {
        List<String> tokens = IntStream.range(0, USERS).mapToObj(i -> newUser().token()).toList();
        long targetSeatId = show.seatIds().get(0);

        CountDownLatch startGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(USERS);
        List<ResponseEntity<Map<String, Object>>> responses;
        try {
            List<CompletableFuture<ResponseEntity<Map<String, Object>>>> futures = tokens.stream()
                    .map(token -> CompletableFuture.supplyAsync(() -> {
                        try {
                            startGate.await();
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return hold(token, List.of(targetSeatId));
                    }, pool))
                    .toList();
            startGate.countDown();
            responses = futures.stream().map(CompletableFuture::join).toList();
        } finally {
            pool.shutdownNow();
        }

        List<ResponseEntity<Map<String, Object>>> successes = responses.stream()
                .filter(r -> r.getStatusCode() == HttpStatus.CREATED).toList();
        List<ResponseEntity<Map<String, Object>>> conflicts = responses.stream()
                .filter(r -> r.getStatusCode() == HttpStatus.CONFLICT).toList();

        assertThat(successes).hasSize(1);
        assertThat(conflicts).hasSize(USERS - 1);
        assertThat(conflicts).allMatch(r -> "SEAT_ALREADY_TAKEN".equals(r.getBody().get("code")));

        // DB 최종 상태: HELD는 정확히 1좌석 (승자의 좌석)
        Integer heldCount = jdbc.queryForObject(
                "SELECT count(*) FROM show_seats WHERE show_id = ? AND status = 'HELD'",
                Integer.class, show.showId());
        assertThat(heldCount).isEqualTo(1);
    }

    @Test
    @DisplayName("여러 좌석 중 하나라도 실패하면 그룹 전체가 롤백된다 (부분 선점 금지)")
    void allOrNothingHold() {
        String userA = newUser().token();
        String userB = newUser().token();
        long seatB = show.seatIds().get(1);
        long seatC = show.seatIds().get(2);

        // A가 seatB를 먼저 선점
        assertThat(hold(userA, List.of(seatB)).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // B가 [seatB, seatC]를 요청 → seatB 충돌로 전체 실패 + 실패 좌석 안내
        ResponseEntity<Map<String, Object>> conflict = hold(userB, List.of(seatB, seatC));
        assertThat(conflict.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(conflict.getBody().get("code")).isEqualTo("SEAT_ALREADY_TAKEN");
        @SuppressWarnings("unchecked")
        Map<String, Object> details = (Map<String, Object>) conflict.getBody().get("details");
        @SuppressWarnings("unchecked")
        List<Integer> takenSeatIds = (List<Integer>) details.get("seatIds");
        assertThat(takenSeatIds).containsExactly((int) seatB);

        // seatC는 여전히 AVAILABLE — "2좌석 중 1좌석만 잡힘"이 없어야 한다
        String seatCStatus = jdbc.queryForObject(
                "SELECT status FROM show_seats WHERE id = ?", String.class, seatC);
        assertThat(seatCStatus).isEqualTo("AVAILABLE");
    }

    @Test
    @DisplayName("예매 오픈 전에는 선점할 수 없다 (403 TICKET_NOT_OPEN)")
    void ticketNotOpenYet() {
        SeededShow notOpen = seedShow(1, Instant.now().plus(1, ChronoUnit.HOURS));
        ResponseEntity<Map<String, Object>> res = post(
                "/shows/" + notOpen.showId() + "/holds",
                Map.of("seatIds", List.of(notOpen.seatIds().get(0))),
                newUser().token());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(res.getBody().get("code")).isEqualTo("TICKET_NOT_OPEN");
    }

    @Test
    @DisplayName("1인 보유 상한 — 유효한 HELD 누적 + 신규 요청이 4석을 넘으면 400")
    void holdLimitAcrossRequests() {
        String token = newUser().token();
        assertThat(hold(token, show.seatIds().subList(0, 3)).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);

        // 이미 3석 보유 + 2석 추가 요청 = 5석 > 4석 상한
        SeededShow more = show; // 같은 회차에서 남은 좌석으로 시도
        ResponseEntity<Map<String, Object>> res = hold(token, more.seatIds().subList(3, 4));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED); // 3+1=4는 허용

        ResponseEntity<Map<String, Object>> over = hold(token, List.of(more.seatIds().get(0)));
        // 4석 보유 후 1석 추가 → 상한 초과. (선점 충돌 409보다 상한 검사 400이 먼저다)
        assertThat(over.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(over.getBody().get("code")).isEqualTo("HOLD_LIMIT_EXCEEDED");
    }
}
