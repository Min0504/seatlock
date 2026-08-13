package com.seatlock.hold;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.support.DomainTestSupport;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * 선점 만료 방어 (Nest hold-expiry-defense.e2e-spec의 DB 계층 포팅).
 *
 * 5분 TTL을 기다리는 대신 hold_expires_at을 과거로 조작해 만료 상태를 만든다.
 * Redis TTL 알림(빠른 경로)은 Redis 도입과 함께 다음 단계에서 포팅하므로,
 * 여기서는 두 층을 검증한다: ① lazy 판정(조회·선점 시점) ② 스위퍼(최종 권위).
 * 백그라운드 스위퍼는 테스트 설정에서 꺼져 있어(IntegrationTest) 만료 상태가
 * 임의 시점에 회수되지 않는다 — 회수 SQL은 reclaimExpired() 직접 호출로 검증.
 */
@DisplayName("선점 만료 방어 — lazy 판정과 스위퍼")
class HoldExpiryIntegrationTest extends DomainTestSupport {

    @Autowired
    private SeatStateRepository seatStateRepository;

    private SeededShow show;
    private String ownerToken;

    @BeforeEach
    void setUp() {
        truncateAll();
        show = seedShow(2, Instant.now().minus(1, ChronoUnit.HOURS));
        ownerToken = newUser().token();
    }

    private ResponseEntity<Map<String, Object>> hold(String token, List<Long> seatIds) {
        return post("/shows/" + show.showId() + "/holds", Map.of("seatIds", seatIds), token);
    }

    @Test
    @DisplayName("만료됐지만 회수 전인 좌석은 좌석맵에서 AVAILABLE로 보인다 (lazy 판정)")
    void expiredHoldDisplaysAsAvailable() {
        long seatId = show.seatIds().get(0);
        assertThat(hold(ownerToken, List.of(seatId)).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        expireHolds(show.showId());

        ResponseEntity<Map<String, Object>> seatMap = get("/shows/" + show.showId() + "/seats", null);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> seats = (List<Map<String, Object>>) seatMap.getBody().get("seats");
        Map<String, Object> target = seats.stream()
                .filter(s -> ((Number) s.get("id")).longValue() == seatId)
                .findFirst().orElseThrow();
        // DB가 아직 HELD여도(스위퍼 도착 전) 사용자에게는 팔 수 있는 좌석이다
        assertThat(target.get("status")).isEqualTo("AVAILABLE");
    }

    @Test
    @DisplayName("만료 선점은 다른 사용자가 즉시 넘겨받는다 (선점 시점 lazy 판정)")
    void expiredHoldCanBeTakenOver() {
        long seatId = show.seatIds().get(0);
        assertThat(hold(ownerToken, List.of(seatId)).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        expireHolds(show.showId());

        // 스위퍼를 기다리지 않고도 선점 가능해야 한다 — 조건부 UPDATE의
        // "HELD인데 만료" 분기가 요청 시점에 만료를 판정한다
        String thief = newUser().token();
        assertThat(hold(thief, List.of(seatId)).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // 원소유자의 그룹은 더 이상 유효하지 않다 — 해제 시도는 404
        // (좌석의 hold_user_id가 이미 새 주인으로 바뀌었다)
        Integer stillMine = jdbc.queryForObject(
                "SELECT count(*) FROM show_seats WHERE id = ? AND hold_user_id = ?",
                Integer.class, seatId, extractUserId(ownerToken));
        assertThat(stillMine).isZero();
    }

    @Test
    @DisplayName("스위퍼는 만료 선점을 회수하고, 유효한 선점은 건드리지 않는다")
    void sweeperReclaimsOnlyExpired() {
        long expiredSeat = show.seatIds().get(0);
        long liveSeat = show.seatIds().get(1);

        assertThat(hold(ownerToken, List.of(expiredSeat)).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        expireHolds(show.showId());
        // 두 번째 선점은 만료 조작 이후 — 아직 유효한 HELD
        String other = newUser().token();
        assertThat(hold(other, List.of(liveSeat)).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        int reclaimed = seatStateRepository.reclaimExpired();
        assertThat(reclaimed).isEqualTo(1);

        Map<String, Object> expired = jdbc.queryForMap(
                "SELECT status, hold_user_id, hold_group_id, hold_expires_at FROM show_seats WHERE id = ?",
                expiredSeat);
        assertThat(expired.get("status")).isEqualTo("AVAILABLE");
        assertThat(expired.get("hold_user_id")).isNull();
        assertThat(expired.get("hold_group_id")).isNull();
        assertThat(expired.get("hold_expires_at")).isNull();

        String liveStatus = jdbc.queryForObject(
                "SELECT status FROM show_seats WHERE id = ?", String.class, liveSeat);
        assertThat(liveStatus).isEqualTo("HELD");
    }

    @Test
    @DisplayName("만료된 선점으로는 예매를 만들 수 없다 (409 HOLD_EXPIRED)")
    void reservationRejectsExpiredHold() {
        ResponseEntity<Map<String, Object>> held = hold(ownerToken, List.of(show.seatIds().get(0)));
        String holdGroupId = (String) held.getBody().get("holdGroupId");
        expireHolds(show.showId());

        ResponseEntity<Map<String, Object>> res =
                post("/reservations", Map.of("holdGroupId", holdGroupId), ownerToken);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("HOLD_EXPIRED");
    }

    /** sub 클레임 = user id (JwtProvider 계약) */
    private long extractUserId(String token) {
        return Long.parseLong(jwtProvider.parseAccessToken(token).orElseThrow().getSubject());
    }
}
