package com.seatlock.reservation;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.support.DomainTestSupport;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * 선점 → 예매(PENDING) → 내 예매 → 해제 흐름 (Nest reservation-flow.e2e-spec 포팅).
 * 결제(CONFIRMED 전이)는 멱등 결제 포팅과 함께 다음 단계에서 검증한다.
 */
@DisplayName("예매 흐름 — 선점에서 미결제 예매까지")
class ReservationFlowIntegrationTest extends DomainTestSupport {

    private SeededShow show;
    private TestUser user;

    @BeforeEach
    void setUp() {
        truncateAll();
        show = seedShow(3, Instant.now().minus(1, ChronoUnit.HOURS));
        user = newUser();
    }

    private ResponseEntity<Map<String, Object>> hold(List<Long> seatIds) {
        return post("/shows/" + show.showId() + "/holds", Map.of("seatIds", seatIds), user.token());
    }

    @Test
    @DisplayName("선점 → 예매 생성(PENDING) → 내 예매 조회 — 좌석·금액·마감시각이 맞아야 한다")
    void holdToPendingReservation() {
        ResponseEntity<Map<String, Object>> held = hold(show.seatIds().subList(0, 2));
        assertThat(held.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String holdGroupId = (String) held.getBody().get("holdGroupId");
        assertThat(holdGroupId).isNotBlank();

        // 예매 생성 = 미결제(PENDING) 단계 — 좌석 확정은 결제 승인 시점이다
        ResponseEntity<Map<String, Object>> created =
                post("/reservations", Map.of("holdGroupId", holdGroupId), user.token());
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody().get("status")).isEqualTo("PENDING");
        assertThat(created.getBody().get("totalPrice")).isEqualTo(200000);
        assertThat(created.getBody().get("seatCount")).isEqualTo(2);
        assertThat(created.getBody().get("payUntil")).isNotNull();

        // 같은 선점으로 다시 생성해도 새 예매가 생기지 않는다 (부분 유니크 → 기존 반환)
        ResponseEntity<Map<String, Object>> dup =
                post("/reservations", Map.of("holdGroupId", holdGroupId), user.token());
        assertThat(dup.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(dup.getBody().get("id")).isEqualTo(created.getBody().get("id"));

        // 내 예매 목록 — PENDING 예매의 좌석은 선점 그룹으로 표시된다
        ResponseEntity<Map<String, Object>> mine = get("/me/reservations", user.token());
        assertThat(mine.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) mine.getBody().get("items");
        assertThat(items).hasSize(1);
        assertThat(items.get(0).get("status")).isEqualTo("PENDING");
        assertThat((List<?>) items.get(0).get("seats")).hasSize(2);
        @SuppressWarnings("unchecked")
        Map<String, Object> showLine = (Map<String, Object>) items.get(0).get("show");
        assertThat(showLine.get("performanceTitle")).isEqualTo("동시성 실험 공연");

        // 결제 전이므로 좌석은 여전히 HELD다 (RESERVED 전이는 결제 승인 때)
        Integer heldCount = jdbc.queryForObject(
                "SELECT count(*) FROM show_seats WHERE show_id = ? AND status = 'HELD'",
                Integer.class, show.showId());
        assertThat(heldCount).isEqualTo(2);
    }

    @Test
    @DisplayName("남의 선점 그룹이나 없는 그룹으로는 예매를 만들 수 없다 (404)")
    void rejectsForeignOrUnknownHoldGroup() {
        ResponseEntity<Map<String, Object>> held = hold(show.seatIds().subList(0, 1));
        String holdGroupId = (String) held.getBody().get("holdGroupId");

        // 남의 그룹 — hold_user_id 불일치는 "없는 선점"과 같은 404 (IDOR 차단)
        TestUser other = newUser();
        ResponseEntity<Map<String, Object>> foreign =
                post("/reservations", Map.of("holdGroupId", holdGroupId), other.token());
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(foreign.getBody().get("code")).isEqualTo("HOLD_NOT_FOUND");

        ResponseEntity<Map<String, Object>> unknown = post("/reservations",
                Map.of("holdGroupId", "00000000-0000-0000-0000-000000000000"), user.token());
        assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("선점 해제는 본인 좌석만 원복하고, 반복 호출은 404로 끝난다")
    void releaseRestoresSeats() {
        ResponseEntity<Map<String, Object>> held = hold(show.seatIds().subList(0, 2));
        String holdGroupId = (String) held.getBody().get("holdGroupId");

        // 남이 내 선점을 해제할 수 없다 — 소유 조건이 WHERE에 있어 0건 = 404
        TestUser other = newUser();
        ResponseEntity<Map<String, Object>> foreign =
                delete("/holds/" + holdGroupId, other.token());
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<Map<String, Object>> released = delete("/holds/" + holdGroupId, user.token());
        assertThat(released.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(released.getBody().get("releasedSeats")).isEqualTo(2);

        Integer available = jdbc.queryForObject(
                "SELECT count(*) FROM show_seats WHERE show_id = ? AND status = 'AVAILABLE'",
                Integer.class, show.showId());
        assertThat(available).isEqualTo(3);

        // 이미 해제된 그룹의 재해제 — 조건부 UPDATE 0건 = 404 (중복 호출 안전)
        assertThat(delete("/holds/" + holdGroupId, user.token()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("커서 페이지네이션 — 예매 목록이 겹침 없이 이어진다")
    void reservationListPagination() {
        // 예매 3건 생성 (선점 → 예매 → 해제 없이 각각 다른 좌석)
        for (long seatId : show.seatIds()) {
            ResponseEntity<Map<String, Object>> held = hold(List.of(seatId));
            assertThat(held.getStatusCode()).isEqualTo(HttpStatus.CREATED);
            post("/reservations",
                    Map.of("holdGroupId", held.getBody().get("holdGroupId")), user.token());
        }

        ResponseEntity<Map<String, Object>> first = get("/me/reservations?size=2", user.token());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> page1 = (List<Map<String, Object>>) first.getBody().get("items");
        assertThat(page1).hasSize(2);
        assertThat(first.getBody().get("nextCursor")).isNotNull();

        ResponseEntity<Map<String, Object>> second = get(
                "/me/reservations?size=2&cursor=" + first.getBody().get("nextCursor"), user.token());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> page2 = (List<Map<String, Object>>) second.getBody().get("items");
        assertThat(page2).hasSize(1);
        assertThat(second.getBody().get("nextCursor")).isNull();

        List<Object> ids1 = page1.stream().map(i -> i.get("id")).toList();
        assertThat(page2).noneMatch(i -> ids1.contains(i.get("id")));
    }
}
