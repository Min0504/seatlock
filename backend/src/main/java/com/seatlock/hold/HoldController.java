package com.seatlock.hold;

import com.seatlock.common.security.AuthUser;
import com.seatlock.hold.dto.HoldDtos.HoldResponse;
import com.seatlock.hold.dto.HoldDtos.HoldSeatsRequest;
import com.seatlock.hold.dto.HoldDtos.ReleaseResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "holds")
@RestController
@RequiredArgsConstructor
@SecurityRequirement(name = "bearerAuth")
public class HoldController {

    private final HoldService holdService;

    @PostMapping("/shows/{showId}/holds")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "좌석 선점 (5분) — 하나라도 실패하면 그룹 전체 실패")
    public HoldResponse hold(
            @PathVariable Long showId,
            @AuthenticationPrincipal AuthUser user,
            @Valid @RequestBody HoldSeatsRequest request) {
        return holdService.hold(showId, user.id(), request.seatIds());
    }

    @DeleteMapping("/holds/{holdGroupId}")
    @Operation(summary = "선점 취소 (본인만)")
    public ReleaseResponse release(
            @PathVariable UUID holdGroupId, @AuthenticationPrincipal AuthUser user) {
        return holdService.release(holdGroupId, user.id());
    }
}
