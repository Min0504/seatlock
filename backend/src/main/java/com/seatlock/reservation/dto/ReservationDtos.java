package com.seatlock.reservation.dto;

import com.seatlock.reservation.ReservationStatus;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class ReservationDtos {

    private ReservationDtos() {
    }

    public record CreateReservationRequest(
            @Schema(description = "좌석 선점 시 발급된 holdGroupId") @NotNull UUID holdGroupId
    ) {
    }

    public record CreatedReservation(
            Long id,
            ReservationStatus status,
            int totalPrice,
            int seatCount,
            @Schema(description = "이 시각 전에 결제해야 한다 — 프론트 카운트다운의 기준")
            Instant payUntil
    ) {
    }

    public record CancelResult(
            long id,
            ReservationStatus status,
            @Schema(description = "이번 취소로 판매 가능 상태로 되돌린 좌석 수 (반복 취소는 0일 수 있다)")
            int releasedSeats
    ) {
    }

    public record SeatLine(String section, String rowNo, int seatNo, int price) {
    }

    public record ShowLine(Long id, Instant startsAt, String performanceTitle) {
    }

    public record ReservationSummary(
            Long id,
            ReservationStatus status,
            int totalPrice,
            Instant createdAt,
            ShowLine show,
            List<SeatLine> seats
    ) {
    }

    public record MyReservationsResponse(List<ReservationSummary> items, String nextCursor) {
    }
}
