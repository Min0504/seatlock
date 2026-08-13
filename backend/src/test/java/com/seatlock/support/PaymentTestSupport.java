package com.seatlock.support;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * 결제·취소 시나리오 공통 픽스처 — 선점→예매까지의 지름길과 결제 호출 헬퍼.
 * PG는 TestBeans의 FaultInjectablePg(@Primary)로 대체돼 있어 지연·타임아웃을 주입할 수 있다.
 */
public abstract class PaymentTestSupport extends DomainTestSupport {

    @Autowired
    protected FaultInjectablePg pg;

    protected record HeldReservation(long reservationId, UUID holdGroupId, int totalPrice) {
    }

    /** 선점 → PENDING 예매까지 만드는 지름길 — 각 테스트를 독립된 예매로 시작한다 */
    protected HeldReservation holdAndReserve(long showId, TestUser user, List<Long> seatIds) {
        ResponseEntity<Map<String, Object>> held =
                post("/shows/" + showId + "/holds", Map.of("seatIds", seatIds), user.token());
        assertThat(held.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String holdGroupId = (String) held.getBody().get("holdGroupId");

        ResponseEntity<Map<String, Object>> created =
                post("/reservations", Map.of("holdGroupId", holdGroupId), user.token());
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return new HeldReservation(
                ((Number) created.getBody().get("id")).longValue(),
                UUID.fromString(holdGroupId),
                ((Number) created.getBody().get("totalPrice")).intValue());
    }

    protected ResponseEntity<Map<String, Object>> pay(TestUser user, String idempotencyKey, Object body) {
        Map<String, String> headers = idempotencyKey == null
                ? Map.of()
                : Map.of("Idempotency-Key", idempotencyKey);
        return post("/payments", body, user.token(), headers);
    }

    protected ResponseEntity<Map<String, Object>> pay(TestUser user, String idempotencyKey, long reservationId) {
        return pay(user, idempotencyKey, Map.of("reservationId", reservationId, "method", "CARD"));
    }

    /** 선점을 강제로 과거-만료 상태로 만든다 (그룹 단위) */
    protected void expireGroup(UUID holdGroupId) {
        jdbc.update(
                "UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE hold_group_id = ?",
                holdGroupId);
    }

    protected List<String> seatStatuses(List<Long> seatIds) {
        return seatIds.stream()
                .map(id -> jdbc.queryForObject(
                        "SELECT status FROM show_seats WHERE id = ?", String.class, id))
                .toList();
    }

    protected int paymentCount(long reservationId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM payments WHERE reservation_id = ?", Integer.class, reservationId);
        return count != null ? count : 0;
    }

    protected String paymentStatus(UUID idempotencyKey) {
        return jdbc.queryForObject(
                "SELECT status FROM payments WHERE idempotency_key = ?", String.class, idempotencyKey);
    }
}
