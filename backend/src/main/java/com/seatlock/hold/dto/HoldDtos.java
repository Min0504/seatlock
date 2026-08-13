package com.seatlock.hold.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class HoldDtos {

    /** 1인 보유 상한 — UX 규칙 (기획서 §6: 좌석 독점 방지) */
    public static final int MAX_SEATS_PER_HOLD = 4;

    private HoldDtos() {
    }

    public record HoldSeatsRequest(
            @Schema(example = "[101, 102]", description = "선점할 좌석 ID (최대 " + MAX_SEATS_PER_HOLD + "석)")
            @NotEmpty @Size(max = MAX_SEATS_PER_HOLD) List<Long> seatIds
    ) {
    }

    public record HeldSeat(Long id, String section, String rowNo, int seatNo, int price) {
    }

    public record HoldResponse(UUID holdGroupId, Instant expiresAt, List<HeldSeat> seats) {
    }

    public record ReleaseResponse(int releasedSeats) {
    }
}
