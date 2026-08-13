package com.seatlock.reservation;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.support.PaymentTestSupport;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * 예매 취소 시나리오 (Nest reservation-cancel e2e 포팅) — 기획서 §6 API 계약.
 *
 * 취소의 핵심 위험은 "되돌리기"가 아니라 경합이다: 취소 직후의 신규 선점,
 * 반복 취소, 진행 중인 결제 승인과의 교차. 모든 전이가 조건부 UPDATE라서
 * 어느 경합이든 정확히 한쪽만 이긴다는 것을 검증한다.
 */
class ReservationCancelIntegrationTest extends PaymentTestSupport {

    private long showId;
    private List<Long> seatIds;

    @BeforeEach
    void seed() {
        truncateAll();
        SeededShow show = seedShow(4, Instant.now().minus(1, ChronoUnit.HOURS));
        showId = show.showId();
        seatIds = show.seatIds();
    }

    private ResponseEntity<Map<String, Object>> cancel(TestUser user, long reservationId) {
        return delete("/reservations/" + reservationId, user.token());
    }

    /** 선점→예매→결제까지 끝낸 CONFIRMED 예매를 만든다 */
    private HeldReservation confirmedReservation(TestUser user, List<Long> seats, UUID payKey) {
        HeldReservation reservation = holdAndReserve(showId, user, seats);
        ResponseEntity<Map<String, Object>> paid = pay(user, payKey.toString(), reservation.reservationId());
        assertThat(paid.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return reservation;
    }

    @Test
    @DisplayName("결제 완료 예매 취소 — 좌석 원복·연결 이력화·환불까지, 그리고 그 좌석은 재판매된다")
    void confirmedCancelRestoresSeatsAndRefunds() {
        TestUser buyer = newUser();
        UUID payKey = UUID.randomUUID();
        List<Long> mySeats = seatIds.subList(0, 2);
        HeldReservation reservation = confirmedReservation(buyer, mySeats, payKey);

        ResponseEntity<Map<String, Object>> canceled = cancel(buyer, reservation.reservationId());
        assertThat(canceled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(canceled.getBody().get("status")).isEqualTo("CANCELED");
        assertThat(((Number) canceled.getBody().get("releasedSeats")).intValue()).isEqualTo(2);

        // 좌석은 판매 가능으로 원복, 확정 연결은 삭제가 아니라 canceled=true 이력으로 남는다
        assertThat(seatStatuses(mySeats)).containsOnly("AVAILABLE");
        Integer canceledLinks = jdbc.queryForObject(
                "SELECT count(*) FROM reservation_seats WHERE reservation_id = ? AND canceled = true",
                Integer.class, reservation.reservationId());
        assertThat(canceledLinks).isEqualTo(2);

        // 결제는 CANCELED로 넘어가고 PG의 승인 기록도 사라진다(환불)
        assertThat(paymentStatus(payKey)).isEqualTo("CANCELED");
        assertThat(pg.getApprovedTxId(payKey.toString())).isEmpty();

        // 부분 유니크 인덱스(WHERE canceled=false)에서 빠졌으므로 같은 좌석 재판매가 열린다
        TestUser next = newUser();
        HeldReservation resold = holdAndReserve(showId, next, mySeats);
        ResponseEntity<Map<String, Object>> resoldPaid =
                pay(next, UUID.randomUUID().toString(), resold.reservationId());
        assertThat(resoldPaid.getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    @Test
    @DisplayName("반복 취소는 멱등 — 두 번째 취소가 새 주인의 선점을 건드리지 못한다")
    void repeatedCancelKeepsNewOwnerSafe() {
        TestUser buyer = newUser();
        List<Long> mySeat = seatIds.subList(0, 1);
        HeldReservation reservation = confirmedReservation(buyer, mySeat, UUID.randomUUID());

        ResponseEntity<Map<String, Object>> first = cancel(buyer, reservation.reservationId());
        assertThat(((Number) first.getBody().get("releasedSeats")).intValue()).isEqualTo(1);

        // 반납된 좌석을 다른 사용자가 곧바로 선점한다
        TestUser next = newUser();
        ResponseEntity<Map<String, Object>> reHeld =
                post("/shows/" + showId + "/holds", Map.of("seatIds", mySeat), next.token());
        assertThat(reHeld.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // 두 번째 취소 — 이미 CANCELED라 200이되, 좌석은 절대 건드리지 않는다(releasedSeats 0).
        // 여기가 무조건 UPDATE와 조건부 UPDATE의 차이다: 무조건이면 남의 HELD를 지워버린다.
        ResponseEntity<Map<String, Object>> second = cancel(buyer, reservation.reservationId());
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) second.getBody().get("releasedSeats")).intValue()).isZero();
        assertThat(seatStatuses(mySeat)).containsOnly("HELD");
    }

    @Test
    @DisplayName("공연 24시간 전에는 결제 완료 예매를 취소할 수 없다 — 409 CANCEL_WINDOW_CLOSED")
    void cancelWindowClosed() {
        SeededShow soonShow = seedShow(2,
                Instant.now().minus(1, ChronoUnit.HOURS),
                Instant.now().plus(23, ChronoUnit.HOURS));
        TestUser buyer = newUser();
        HeldReservation reservation = holdAndReserve(
                soonShow.showId(), buyer, soonShow.seatIds().subList(0, 1));
        assertThat(pay(buyer, UUID.randomUUID().toString(), reservation.reservationId())
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);

        ResponseEntity<Map<String, Object>> rejected = cancel(buyer, reservation.reservationId());
        assertThat(rejected.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(rejected.getBody().get("code")).isEqualTo("CANCEL_WINDOW_CLOSED");

        // 예매·좌석 모두 그대로다
        String status = jdbc.queryForObject(
                "SELECT status FROM reservations WHERE id = ?", String.class, reservation.reservationId());
        assertThat(status).isEqualTo("CONFIRMED");
        assertThat(seatStatuses(soonShow.seatIds().subList(0, 1))).containsOnly("RESERVED");
    }

    @Test
    @DisplayName("미결제(PENDING) 예매 취소 — 24시간 규칙 없이 즉시 좌석을 반납한다")
    void pendingCancelReleasesSeatsImmediately() {
        TestUser buyer = newUser();
        List<Long> mySeat = seatIds.subList(0, 1);
        HeldReservation reservation = holdAndReserve(showId, buyer, mySeat);

        ResponseEntity<Map<String, Object>> canceled = cancel(buyer, reservation.reservationId());
        assertThat(canceled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) canceled.getBody().get("releasedSeats")).intValue()).isEqualTo(1);
        assertThat(seatStatuses(mySeat)).containsOnly("AVAILABLE");

        // 취소된 예매로는 결제할 수 없다
        ResponseEntity<Map<String, Object>> payAfter =
                pay(buyer, UUID.randomUUID().toString(), reservation.reservationId());
        assertThat(payAfter.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(payAfter.getBody().get("code")).isEqualTo("RESERVATION_NOT_PAYABLE");
    }

    @Test
    @DisplayName("남의 예매는 취소는커녕 존재도 알 수 없다 — 404")
    void foreignReservationIsHidden() {
        TestUser owner = newUser();
        HeldReservation reservation = confirmedReservation(
                owner, seatIds.subList(0, 1), UUID.randomUUID());

        TestUser attacker = newUser();
        ResponseEntity<Map<String, Object>> attempt = cancel(attacker, reservation.reservationId());
        assertThat(attempt.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(attempt.getBody().get("code")).isEqualTo("RESERVATION_NOT_FOUND");

        String status = jdbc.queryForObject(
                "SELECT status FROM reservations WHERE id = ?", String.class, reservation.reservationId());
        assertThat(status).isEqualTo("CONFIRMED");
    }

    @Test
    @DisplayName("PG 승인이 진행되는 사이의 취소 — 취소가 이기고 결제는 보상 취소(환불)된다")
    void cancelDuringApprovalTriggersCompensation() throws Exception {
        TestUser buyer = newUser();
        List<Long> mySeat = seatIds.subList(0, 1);
        HeldReservation reservation = holdAndReserve(showId, buyer, mySeat);
        UUID payKey = UUID.randomUUID();

        // PG 왕복을 600ms로 늦춰 "승인 진행 중" 상태를 결정적으로 만든다
        pg.delayNextApproveMs = 600;
        CompletableFuture<ResponseEntity<Map<String, Object>>> paying =
                CompletableFuture.supplyAsync(() -> pay(buyer, payKey.toString(), reservation.reservationId()));

        Thread.sleep(150); // 결제가 PG 구간에 들어갈 시간
        ResponseEntity<Map<String, Object>> canceled = cancel(buyer, reservation.reservationId());
        assertThat(canceled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(canceled.getBody().get("status")).isEqualTo("CANCELED");

        // 결제 쪽은 확정 트랜잭션의 조건부 UPDATE(0건)로 패배를 감지하고 보상 취소한다
        ResponseEntity<Map<String, Object>> payResult = paying.get();
        assertThat(payResult.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(paymentStatus(payKey)).isEqualTo("FAILED");
        assertThat(pg.getApprovedTxId(payKey.toString())).isEmpty(); // 환불 완료 — 돈은 안 나갔다

        // 좌석은 판매 가능 상태 그대로 — 유령 확정이 없다
        assertThat(seatStatuses(mySeat)).containsOnly("AVAILABLE");
        String status = jdbc.queryForObject(
                "SELECT status FROM reservations WHERE id = ?", String.class, reservation.reservationId());
        assertThat(status).isEqualTo("CANCELED");
    }
}
