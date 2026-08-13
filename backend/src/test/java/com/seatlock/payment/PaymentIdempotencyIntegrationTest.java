package com.seatlock.payment;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.payment.dto.PaymentDtos.CreatePaymentRequest;
import com.seatlock.payment.dto.PaymentDtos.PaymentMethod;
import com.seatlock.support.PaymentTestSupport;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * 결제 멱등성 계약 검증 (기획서 §6 대표 API, §7 문제 3) — Nest payment-idempotency 포팅.
 *
 * 계약:
 * - 같은 키 재요청 → 첫 요청의 결과를 재실행 없이 반환 (200)
 * - 같은 키 + 다른 바디 → 422 IDEMPOTENCY_KEY_MISMATCH
 * - 처리 중 동시 요청 → 409 PAYMENT_IN_PROGRESS
 * - 선점 만료 후 결제 → 409 HOLD_EXPIRED
 * - 타임아웃/크래시로 정체된 PENDING은 PG 상태조회로 복구
 */
@DisplayName("결제 멱등성 — 이중 결제 방지")
class PaymentIdempotencyIntegrationTest extends PaymentTestSupport {

    private SeededShow show;
    private TestUser user;

    @BeforeEach
    void setUp() {
        truncateAll();
        show = seedShow(16, Instant.now().minus(1, ChronoUnit.HOURS));
        user = newUser();
    }

    private String key() {
        return UUID.randomUUID().toString();
    }

    @Test
    @DisplayName("Idempotency-Key 헤더가 없거나 UUID가 아니면 400 — 키 없는 결제는 계약 위반")
    void requiresIdempotencyKeyHeader() {
        HeldReservation hr = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 1));

        ResponseEntity<Map<String, Object>> missing = pay(user, null, hr.reservationId());
        assertThat(missing.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(missing.getBody().get("code")).isEqualTo("IDEMPOTENCY_KEY_REQUIRED");

        ResponseEntity<Map<String, Object>> malformed = pay(user, "not-a-uuid", hr.reservationId());
        assertThat(malformed.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    @DisplayName("같은 키 재요청은 200으로 첫 결과를 재생하고, 결제 레코드는 1건만 생긴다")
    void replaysSameKeyWithoutReexecution() {
        HeldReservation hr = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 1));
        String idempotencyKey = key();

        ResponseEntity<Map<String, Object>> first = pay(user, idempotencyKey, hr.reservationId());
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(first.getBody().get("status")).isEqualTo("APPROVED");
        assertThat(first.getBody().get("amount")).isEqualTo(hr.totalPrice());

        ResponseEntity<Map<String, Object>> replay = pay(user, idempotencyKey, hr.reservationId());
        assertThat(replay.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(replay.getBody().get("paymentId")).isEqualTo(first.getBody().get("paymentId"));
        assertThat(replay.getBody().get("pgTxId")).isEqualTo(first.getBody().get("pgTxId"));

        assertThat(paymentCount(hr.reservationId())).isEqualTo(1);
    }

    @Test
    @DisplayName("같은 키 + 다른 바디는 422 — 캐시된 응답을 조용히 돌려주면 안 된다")
    void rejectsSameKeyDifferentBody() {
        HeldReservation hr = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 1));
        HeldReservation other = holdAndReserve(show.showId(), user, show.seatIds().subList(1, 2));
        String idempotencyKey = key();

        pay(user, idempotencyKey, hr.reservationId());

        ResponseEntity<Map<String, Object>> mismatch = pay(user, idempotencyKey, other.reservationId());
        assertThat(mismatch.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(mismatch.getBody().get("code")).isEqualTo("IDEMPOTENCY_KEY_MISMATCH");
    }

    @Test
    @DisplayName("같은 키 동시 10발 — 결제 실행은 정확히 1번, 나머지는 처리중(409) 또는 재생(200)")
    void concurrentSameKeyExecutesOnce() throws InterruptedException {
        HeldReservation hr = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 2));
        String idempotencyKey = key();

        int attempts = 10;
        ExecutorService pool = Executors.newFixedThreadPool(attempts);
        CountDownLatch ready = new CountDownLatch(attempts);
        CountDownLatch fire = new CountDownLatch(1);
        List<CompletableFuture<ResponseEntity<Map<String, Object>>>> futures =
                IntStream.range(0, attempts)
                        .mapToObj(i -> CompletableFuture.supplyAsync(() -> {
                            ready.countDown();
                            try {
                                fire.await(10, TimeUnit.SECONDS);
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                            return pay(user, idempotencyKey, hr.reservationId());
                        }, pool))
                        .toList();
        ready.await(10, TimeUnit.SECONDS);
        fire.countDown();
        List<ResponseEntity<Map<String, Object>>> responses =
                futures.stream().map(CompletableFuture::join).toList();
        pool.shutdown();

        // 201(실행됨)은 정확히 1건 — 2건 이상이면 이중 결제다
        List<ResponseEntity<Map<String, Object>>> executed = responses.stream()
                .filter(r -> r.getStatusCode() == HttpStatus.CREATED)
                .toList();
        assertThat(executed).hasSize(1);
        Object executedTxId = executed.get(0).getBody().get("pgTxId");

        // 나머지는 "처리 중"(409) 또는 완료 후 재생(200) — 둘 다 재실행 없음
        for (ResponseEntity<Map<String, Object>> r : responses) {
            assertThat(r.getStatusCode())
                    .isIn(HttpStatus.OK, HttpStatus.CREATED, HttpStatus.CONFLICT);
            if (r.getStatusCode() == HttpStatus.CONFLICT) {
                assertThat(r.getBody().get("code")).isEqualTo("PAYMENT_IN_PROGRESS");
            }
            if (r.getStatusCode() == HttpStatus.OK) {
                assertThat(r.getBody().get("pgTxId")).isEqualTo(executedTxId);
            }
        }

        // 최종 상태: 결제 1건, 처리중이던 요청도 재시도하면 같은 결과를 200으로 받는다
        assertThat(paymentCount(hr.reservationId())).isEqualTo(1);
        ResponseEntity<Map<String, Object>> retry = pay(user, idempotencyKey, hr.reservationId());
        assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(retry.getBody().get("pgTxId")).isEqualTo(executedTxId);
    }

    @Test
    @DisplayName("이미 결제된 예매에 다른 키로 결제하면 409 ALREADY_PAID")
    void rejectsSecondKeyOnPaidReservation() {
        HeldReservation hr = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 1));
        pay(user, key(), hr.reservationId());

        ResponseEntity<Map<String, Object>> second = pay(user, key(), hr.reservationId());
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(second.getBody().get("code")).isEqualTo("ALREADY_PAID");
    }

    @Test
    @DisplayName("남의 예매 결제 시도는 404 — 예매 존재 여부조차 노출하지 않는다")
    void hidesForeignReservation() {
        HeldReservation victim = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 1));
        String victimKey = key();
        pay(user, victimKey, victim.reservationId());

        // 공격자가 피해자의 예매 ID를 알아내도 404 (IDOR 차단)
        TestUser attacker = newUser();
        ResponseEntity<Map<String, Object>> probe = pay(attacker, key(), victim.reservationId());
        assertThat(probe.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // 피해자의 키를 탈취해 자기 예매에 재사용해도 바디 지문이 달라 422
        HeldReservation own = holdAndReserve(show.showId(), attacker, show.seatIds().subList(1, 2));
        ResponseEntity<Map<String, Object>> reuse = pay(attacker, victimKey, own.reservationId());
        assertThat(reuse.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    @Test
    @DisplayName("선점 만료 후 결제는 409 HOLD_EXPIRED — PG 호출 전에 끊는다")
    void rejectsExpiredHoldBeforePg() {
        HeldReservation hr = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 1));
        expireGroup(hr.holdGroupId());

        ResponseEntity<Map<String, Object>> expired = pay(user, key(), hr.reservationId());
        assertThat(expired.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(expired.getBody().get("code")).isEqualTo("HOLD_EXPIRED");

        // PG 호출 전에 차단됐으므로 결제 레코드 자체가 없어야 한다
        assertThat(paymentCount(hr.reservationId())).isZero();
    }

    @Test
    @DisplayName("승인 도중 선점이 만료되면 보상 취소(환불)하고 409 — 돈만 나가는 상태를 남기지 않는다")
    void compensatesWhenHoldExpiresMidApproval() throws Exception {
        List<Long> seats = show.seatIds().subList(0, 1);
        HeldReservation hr = holdAndReserve(show.showId(), user, seats);
        String idempotencyKey = key();

        // PG 왕복을 500ms로 늦춰, 승인이 진행되는 동안 선점이 만료되는 경합을 재현
        pg.delayNextApproveMs = 500;
        CompletableFuture<ResponseEntity<Map<String, Object>>> inFlight =
                CompletableFuture.supplyAsync(() -> pay(user, idempotencyKey, hr.reservationId()));
        Thread.sleep(150);
        expireGroup(hr.holdGroupId());

        ResponseEntity<Map<String, Object>> result = inFlight.get(10, TimeUnit.SECONDS);
        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(result.getBody().get("code")).isEqualTo("HOLD_EXPIRED");

        // 결제는 FAILED로 확정되고, PG 승인 건은 취소(환불)돼 기록이 없어야 한다
        assertThat(paymentStatus(UUID.fromString(idempotencyKey))).isEqualTo("FAILED");
        assertThat(pg.getApprovedTxId(idempotencyKey)).isEmpty();

        // 좌석은 확정되지 않았다 — RESERVED가 아니어야 한다
        assertThat(seatStatuses(seats)).noneMatch("RESERVED"::equals);
    }

    @Test
    @DisplayName("PG 타임아웃(승인은 기록됨) → 상태조회로 복구해 결제를 확정한다")
    void recoversFromPgTimeoutViaStatusQuery() {
        List<Long> seats = show.seatIds().subList(0, 1);
        HeldReservation hr = holdAndReserve(show.showId(), user, seats);

        // 승인은 PG에 도달했지만 응답이 유실되는 상황 — 실패로 단정하면 고객 돈만 나간다
        pg.timeoutNextApprove = true;
        ResponseEntity<Map<String, Object>> result = pay(user, key(), hr.reservationId());

        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(result.getBody().get("status")).isEqualTo("APPROVED");
        assertThat(seatStatuses(seats)).allMatch("RESERVED"::equals);
    }

    @Test
    @DisplayName("정체된 PENDING(크래시 흔적)은 재시도가 PG 상태조회로 마무리한다 — 승인 기록 없으면 FAILED")
    void finalizesStalePendingViaPgStatus() {
        HeldReservation hr = holdAndReserve(show.showId(), user, show.seatIds().subList(0, 1));
        String idempotencyKey = key();
        String requestHash = PaymentService.hashRequest(
                new CreatePaymentRequest(hr.reservationId(), PaymentMethod.CARD));

        // "INSERT 후 PG 응답 전에 프로세스가 죽은" 흔적을 직접 심는다
        jdbc.update("""
                INSERT INTO payments (reservation_id, idempotency_key, request_hash, status,
                                      amount, method, created_at, updated_at)
                VALUES (?, ?::uuid, ?, 'PENDING', ?, 'CARD',
                        now() - interval '60 seconds', now() - interval '60 seconds')
                """, hr.reservationId(), idempotencyKey, requestHash, hr.totalPrice());

        // 같은 키 재시도 → PG에 승인 기록이 없으므로 FAILED 확정 (돈은 나가지 않았다)
        ResponseEntity<Map<String, Object>> retry = pay(user, idempotencyKey, hr.reservationId());
        assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.PAYMENT_REQUIRED);
        assertThat(retry.getBody().get("code")).isEqualTo("PAYMENT_FAILED");

        // 같은 키의 이후 요청도 같은 실패를 재현한다 (키 = 시도 1회의 식별자)
        ResponseEntity<Map<String, Object>> again = pay(user, idempotencyKey, hr.reservationId());
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.PAYMENT_REQUIRED);

        // FAILED는 부분 유니크 인덱스 범위 밖 — 새 키로는 정상 결제된다
        ResponseEntity<Map<String, Object>> fresh = pay(user, key(), hr.reservationId());
        assertThat(fresh.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(fresh.getBody().get("status")).isEqualTo("APPROVED");
    }
}
