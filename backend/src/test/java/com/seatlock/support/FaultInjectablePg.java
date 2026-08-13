package com.seatlock.support;

import com.seatlock.payment.MockPgClient;

/**
 * 실물 PG로는 재현할 수 없는 장애를 주입하는 확장 mock (Nest FaultInjectablePg 포팅).
 * @Primary 빈으로 MockPgClient 자리를 대체한다 — PgFaultConfig 참조.
 *
 * - timeoutNextApprove: 승인은 PG 쪽에 기록되지만 응답이 유실되는 상황
 *   (가맹점 입장에서 "됐는지 안 됐는지 모르는" 타임아웃)
 * - delayNextApproveMs: PG 왕복이 느려지는 상황 — 승인이 진행되는 동안
 *   선점 만료·예매 취소가 끼어드는 경합 구간을 결정적으로 만들 수 있다
 */
public class FaultInjectablePg extends MockPgClient {

    public volatile boolean timeoutNextApprove = false;
    public volatile long delayNextApproveMs = 0;

    @Override
    public PgApproval approve(String orderId, int amount, String method) {
        long delay = delayNextApproveMs;
        delayNextApproveMs = 0;
        if (delay > 0) {
            try {
                Thread.sleep(delay);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        PgApproval result = super.approve(orderId, amount, method);
        if (timeoutNextApprove) {
            timeoutNextApprove = false;
            throw new PgTimeoutException();
        }
        return result;
    }
}
