package com.seatlock.show.dto;

import com.seatlock.show.SeatStatus;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
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
}
