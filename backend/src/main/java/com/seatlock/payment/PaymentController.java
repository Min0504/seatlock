package com.seatlock.payment;

import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.common.security.AuthUser;
import com.seatlock.payment.PaymentService.PayResult;
import com.seatlock.payment.dto.PaymentDtos.CreatePaymentRequest;
import com.seatlock.payment.dto.PaymentDtos.PaymentView;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "payments")
@RestController
@RequestMapping("/payments")
@RequiredArgsConstructor
@SecurityRequirement(name = "bearerAuth")
public class PaymentController {

    private final PaymentService paymentService;

    @PostMapping
    @Operation(summary = "결제 실행 (멱등)",
            description = "같은 Idempotency-Key 재요청은 결제를 재실행하지 않고 첫 결과를 200으로 반환한다. "
                    + "같은 키에 다른 바디는 422, 처리 중 동시 요청은 409.")
    public ResponseEntity<PaymentView> pay(
            @AuthenticationPrincipal AuthUser user,
            @Parameter(in = ParameterIn.HEADER, name = "Idempotency-Key", required = true,
                    description = "클라이언트가 생성한 UUID. 재시도 시 반드시 같은 값을 보낸다.")
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody CreatePaymentRequest request) {
        // 키 없는 결제를 허용하면 멱등성 계약 전체가 무너진다 — 헤더를 필수로 강제
        UUID key = parseUuid(idempotencyKey);
        PayResult result = paymentService.pay(user.id(), key, request);
        // 이번 요청이 결제를 실행했으면 201, 기존 결과의 재생이면 200 — 재실행 여부를 상태코드로 드러낸다
        return ResponseEntity
                .status(result.replayed() ? HttpStatus.OK : HttpStatus.CREATED)
                .body(result.payment());
    }

    private static UUID parseUuid(String raw) {
        if (raw == null) {
            throw new DomainException(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException e) {
            throw new DomainException(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
        }
    }
}
