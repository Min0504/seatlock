package com.seatlock.performance;

import com.seatlock.performance.dto.PerformanceDtos.CreatePerformanceRequest;
import com.seatlock.performance.dto.PerformanceDtos.CreateShowRequest;
import com.seatlock.performance.dto.PerformanceDtos.CreateVenueRequest;
import com.seatlock.performance.dto.PerformanceDtos.CreateVenueResponse;
import com.seatlock.performance.dto.PerformanceDtos.CreatedResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** ADMIN 전용 카탈로그 등록 — /admin/** 경로는 SecurityConfig에서 hasRole(ADMIN)로 잠근다 */
@Tag(name = "admin")
@RestController
@RequestMapping("/admin")
@RequiredArgsConstructor
@SecurityRequirement(name = "bearerAuth")
public class PerformanceAdminController {

    private final PerformanceService performanceService;

    @PostMapping("/venues")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "공연장 + 좌석 템플릿 등록 (ADMIN)")
    public CreateVenueResponse createVenue(@Valid @RequestBody CreateVenueRequest request) {
        return performanceService.createVenue(request);
    }

    @PostMapping("/performances")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "공연 등록 (ADMIN)")
    public CreatedResponse createPerformance(@Valid @RequestBody CreatePerformanceRequest request) {
        return performanceService.createPerformance(request);
    }

    @PostMapping("/shows")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "회차 등록 (ADMIN)")
    public CreatedResponse createShow(@Valid @RequestBody CreateShowRequest request) {
        return performanceService.createShow(request);
    }
}
