package com.seatlock.performance;

import com.seatlock.performance.dto.PerformanceDtos.DetailResponse;
import com.seatlock.performance.dto.PerformanceDtos.ListResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "performances")
@RestController
@RequestMapping("/performances")
@RequiredArgsConstructor
@Validated
public class PerformanceController {

    private final PerformanceService performanceService;

    @GetMapping
    @Operation(summary = "공연 목록/검색 (커서 페이지네이션)")
    public ListResponse list(
            @RequestParam(required = false) @Size(max = 100) String q,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date,
            @RequestParam(required = false) Long cursor,
            @RequestParam(required = false) @Min(1) @Max(50) Integer size) {
        return performanceService.list(q, date, cursor, size);
    }

    @GetMapping("/{id}")
    @Operation(summary = "공연 상세 (회차 목록 포함)")
    public DetailResponse detail(@PathVariable Long id) {
        return performanceService.detail(id);
    }
}
