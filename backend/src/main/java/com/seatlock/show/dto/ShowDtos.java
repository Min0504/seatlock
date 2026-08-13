package com.seatlock.show.dto;

import com.seatlock.show.SeatStatus;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;

public final class ShowDtos {

    private ShowDtos() {
    }

    public record SectionPrice(
            @Schema(example = "A") @NotBlank @Size(max = 20) String section,
            @Schema(example = "150000") @NotNull @Min(0) Integer price
    ) {
    }

    public record CreateShowSeatsRequest(
            @Schema(description = "구역별 가격 — 명시한 구역의 템플릿 좌석만 생성된다")
            @NotEmpty @Valid List<SectionPrice> prices
    ) {
    }

    public record CreateSeatsResponse(int count) {
    }

    public record SeatMapEntry(
            Long id,
            String section,
            String rowNo,
            int seatNo,
            int price,
            SeatStatus status
    ) {
    }

    public record SeatMapResponse(Long showId, List<SeatMapEntry> seats) {
    }

    public record ShowStats(
            long showId,
            int totalSeats,
            @Schema(description = "결제 확정된 좌석 수 (판매 완료)") int reservedSeats,
            @Schema(description = "유효한(미만료) 선점 좌석 수") int heldSeats,
            @Schema(description = "판매 가능 좌석 수 — 만료됐지만 회수 전인 HELD 포함") int availableSeats,
            @Schema(description = "reservedSeats / totalSeats, 소수 4자리") double salesRate,
            @Schema(description = "승인 상태 결제 금액 합계 — 취소(환불)된 결제는 자동 제외") int revenue,
            Instant generatedAt
    ) {
    }
}
