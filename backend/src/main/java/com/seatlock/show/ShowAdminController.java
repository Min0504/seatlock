package com.seatlock.show;

import com.seatlock.show.dto.ShowDtos.CreateSeatsResponse;
import com.seatlock.show.dto.ShowDtos.CreateShowSeatsRequest;
import com.seatlock.show.dto.ShowDtos.ShowStats;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "admin")
@RestController
@RequestMapping("/admin/shows")
@RequiredArgsConstructor
@SecurityRequirement(name = "bearerAuth")
public class ShowAdminController {

    private final ShowService showService;
    private final ShowStatsService showStatsService;

    @PostMapping("/{id}/seats")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "회차 좌석 일괄 생성 (ADMIN)")
    public CreateSeatsResponse createSeats(
            @PathVariable Long id, @Valid @RequestBody CreateShowSeatsRequest request) {
        return showService.createShowSeats(id, request);
    }

    @GetMapping("/{id}/stats")
    @Operation(summary = "회차 판매 통계 (ADMIN) — 실시간 집계 + 5분 캐시")
    public ShowStats stats(@PathVariable Long id) {
        return showStatsService.getStats(id);
    }
}
