package com.seatlock.payment;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.stereotype.Component;

/**
 * 실제 PG 연동의 계약만 흉내 낸 mock (Nest MockPgService 포팅).
 *
 * 실 PG와 동일하게 유지하는 계약 두 가지:
 * - 가맹점이 주문번호(orderId = Idempotency-Key)를 먼저 정해 보낸다 — 응답을 못
 *   받아도(타임아웃) orderId로 상태를 역조회(getStatus)할 수 있는 근거가 된다.
 * - 승인 여부의 진실은 PG 쪽 기록이다. 타임아웃은 "실패"가 아니라 "모름"이며,
 *   getStatus로 확인하기 전까지 결제를 실패 처리하면 안 된다(이중 청구·유실의 근원).
 *
 * 카드번호 등 민감정보는 받지 않는다 — 기획서 §보안: mock PG 토큰만 다룬다.
 */
@Component
public class MockPgClient {

    /** PG 응답을 받지 못한 상태 — "됐는지 안 됐는지 모른다"를 예외 타입으로 구분한다 */
    public static class PgTimeoutException extends RuntimeException {
        public PgTimeoutException() {
            super("PG 응답 시간 초과");
        }
    }

    public record PgApproval(String pgTxId) {
    }

    private final Map<String, String> transactions = new ConcurrentHashMap<>();

    public PgApproval approve(String orderId, int amount, String method) {
        simulateLatency();
        // 같은 주문번호 재승인 요청은 기존 거래를 반환한다 — 실 PG의 주문번호 중복 방지와 동일
        String pgTxId = transactions.computeIfAbsent(orderId, k -> "pg_" + UUID.randomUUID());
        return new PgApproval(pgTxId);
    }

    /** 타임아웃 복구용 상태 조회 — empty = 승인 기록 없음(그 주문은 PG에 도달하지 않았다) */
    public Optional<String> getApprovedTxId(String orderId) {
        simulateLatency();
        return Optional.ofNullable(transactions.get(orderId));
    }

    /** 승인 취소(환불 mock) — 멱등: 이미 취소됐거나 없는 거래여도 오류 없이 끝난다 */
    public void cancel(String orderId) {
        simulateLatency();
        transactions.remove(orderId);
    }

    private void simulateLatency() {
        try {
            Thread.sleep(5 + ThreadLocalRandom.current().nextLong(15));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
