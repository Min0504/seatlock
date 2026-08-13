package com.seatlock.payment.dto;

import com.seatlock.payment.Payment;
import com.seatlock.payment.PaymentStatus;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

public final class PaymentDtos {

    private PaymentDtos() {
    }

    /** 결제 수단 — Nest의 PAYMENT_METHODS(['CARD', 'EASY_PAY'])와 동일 계약 */
    public enum PaymentMethod {
        CARD,
        EASY_PAY,
    }

    public record CreatePaymentRequest(
            @Schema(description = "결제할 예매 ID (PENDING 상태)")
            @NotNull @Positive Long reservationId,
            @NotNull PaymentMethod method) {
    }

    public record PaymentView(
            long paymentId,
            long reservationId,
            PaymentStatus status,
            int amount,
            String method,
            String pgTxId) {

        public static PaymentView from(Payment payment) {
            return new PaymentView(
                    payment.getId(),
                    payment.getReservationId(),
                    payment.getStatus(),
                    payment.getAmount(),
                    payment.getMethod(),
                    payment.getPgTxId());
        }
    }
}
