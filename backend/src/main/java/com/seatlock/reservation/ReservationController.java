package com.seatlock.reservation;

import com.seatlock.common.security.AuthUser;
import com.seatlock.reservation.dto.ReservationDtos.CreateReservationRequest;
import com.seatlock.reservation.dto.ReservationDtos.CreatedReservation;
import com.seatlock.reservation.dto.ReservationDtos.MyReservationsResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "reservations")
@RestController
@RequiredArgsConstructor
@Validated
@SecurityRequirement(name = "bearerAuth")
public class ReservationController {

    private final ReservationService reservationService;

    @PostMapping("/reservations")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "선점 좌석으로 예매 생성 (미결제 PENDING)")
    public CreatedReservation create(
            @AuthenticationPrincipal AuthUser user,
            @Valid @RequestBody CreateReservationRequest request) {
        return reservationService.create(user.id(), request.holdGroupId());
    }

    @GetMapping("/me/reservations")
    @Operation(summary = "내 예매 목록 (커서 페이지네이션)")
    public MyReservationsResponse listMine(
            @AuthenticationPrincipal AuthUser user,
            @RequestParam(required = false) Long cursor,
            @RequestParam(required = false) @Min(1) @Max(50) Integer size) {
        return reservationService.listMine(user.id(), cursor, size);
    }
}
