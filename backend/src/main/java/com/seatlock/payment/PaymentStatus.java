package com.seatlock.payment;

/**
 * 결제 상태 기계 — PostgreSQL enum "PaymentStatus"와 1:1.
 *
 * PENDING(PG 결과 모름) → APPROVED / FAILED, APPROVED → CANCELED(환불).
 * 타임아웃·크래시로 PENDING에 멈춘 결제는 실패로 단정하지 않고 PG 상태조회로
 * 확인한다 — "모른다"를 상태로 모델링하는 것이 핵심 (기획서 장애 시나리오 2).
 */
public enum PaymentStatus {
    PENDING,
    APPROVED,
    FAILED,
    CANCELED,
}
