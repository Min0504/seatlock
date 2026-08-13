package com.seatlock.performance.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;

/** 공연 카탈로그 요청/응답 DTO — backend-nest performances.dto.ts와 동일한 검증 규칙 */
public final class PerformanceDtos {

    private PerformanceDtos() {
    }

    public record SeatTemplate(
            @Schema(example = "A") @NotBlank @Size(max = 20) String section,
            @Schema(example = "1") @NotBlank @Size(max = 10) String rowNo,
            @Schema(example = "1") @NotNull @Min(1) Integer seatNo
    ) {
    }

    public record CreateVenueRequest(
            @Schema(example = "세종문화회관 대극장") @NotBlank @Size(max = 100) String name,
            @Schema(example = "서울 종로구 세종대로 175") @NotBlank @Size(max = 255) String address,
            @Schema(description = "물리 좌석 템플릿 (최대 10,000석)")
            @NotEmpty @Size(max = 10_000) @Valid List<SeatTemplate> seats
    ) {
    }

    public record CreateVenueResponse(Long id, int seatCount) {
    }

    public record CreatePerformanceRequest(
            @Schema(example = "오페라의 유령") @NotBlank @Size(max = 200) String title,
            @Schema(example = "뮤지컬의 전설, 다시 무대로") String description,
            @Schema(example = "1") @NotNull Long venueId
    ) {
    }

    public record CreateShowRequest(
            @Schema(example = "1") @NotNull Long performanceId,
            @Schema(example = "2026-10-01T19:30:00+09:00") @NotNull Instant startsAt,
            @Schema(example = "2026-09-01T20:00:00+09:00") @NotNull Instant ticketOpenAt
    ) {
    }

    public record CreatedResponse(Long id) {
    }

    public record ListItem(Long id, String title, String posterUrl, String venueName) {
    }

    public record ListResponse(List<ListItem> items, String nextCursor) {
    }

    public record VenueSummary(Long id, String name, String address) {
    }

    public record ShowSummary(Long id, Instant startsAt, Instant ticketOpenAt) {
    }

    public record DetailResponse(
            Long id,
            String title,
            String description,
            String posterUrl,
            VenueSummary venue,
            List<ShowSummary> shows
    ) {
    }
}
