package com.seatlock.common.error;

import lombok.Getter;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;

/**
 * 에러 코드 레지스트리 — backend-nest의 Errors와 1:1 계약.
 * HTTP 상태코드만으로는 "왜 실패했는가"를 구분할 수 없으므로(409가 좌석 선점 실패인지
 * 이메일 중복인지), 기계가 분기할 수 있는 안정적인 code를 계약으로 제공한다.
 * 포팅 원칙: 프레임워크가 바뀌어도 API 계약(코드·메시지·상태)은 바뀌지 않는다.
 */
@Getter
@RequiredArgsConstructor
public enum ErrorCode {

    // auth
    EMAIL_EXISTS(HttpStatus.CONFLICT, "이미 가입된 이메일입니다."),
    INVALID_CREDENTIALS(HttpStatus.UNAUTHORIZED, "이메일 또는 비밀번호가 올바르지 않습니다."),
    UNAUTHORIZED(HttpStatus.UNAUTHORIZED, "유효한 인증 토큰이 필요합니다."),
    FORBIDDEN(HttpStatus.FORBIDDEN, "이 리소스에 접근할 권한이 없습니다."),

    // catalog
    VENUE_NOT_FOUND(HttpStatus.NOT_FOUND, "공연장을 찾을 수 없습니다."),
    PERFORMANCE_NOT_FOUND(HttpStatus.NOT_FOUND, "공연을 찾을 수 없습니다."),
    SHOW_NOT_FOUND(HttpStatus.NOT_FOUND, "회차를 찾을 수 없습니다."),
    SEATS_ALREADY_CREATED(HttpStatus.CONFLICT, "이미 좌석이 생성된 회차입니다."),
    SEAT_NOT_FOUND(HttpStatus.NOT_FOUND, "요청한 좌석을 찾을 수 없습니다."),

    // hold / reservation
    TICKET_NOT_OPEN(HttpStatus.FORBIDDEN, "아직 예매 오픈 전입니다."),
    SEAT_ALREADY_TAKEN(HttpStatus.CONFLICT, "이미 선점되었거나 판매된 좌석이 포함되어 있습니다."),
    HOLD_LIMIT_EXCEEDED(HttpStatus.BAD_REQUEST, "1인당 최대 4석까지 선점할 수 있습니다."),
    HOLD_NOT_FOUND(HttpStatus.NOT_FOUND, "유효한 선점 내역을 찾을 수 없습니다."),
    HOLD_EXPIRED(HttpStatus.CONFLICT, "선점 유효시간이 만료되었습니다. 좌석을 다시 선택해 주세요."),
    RESERVATION_NOT_FOUND(HttpStatus.NOT_FOUND, "예매 내역을 찾을 수 없습니다."),

    // payment
    IDEMPOTENCY_KEY_REQUIRED(HttpStatus.BAD_REQUEST, "Idempotency-Key 헤더(UUID)가 필요합니다."),
    IDEMPOTENCY_KEY_MISMATCH(HttpStatus.UNPROCESSABLE_ENTITY,
            "같은 Idempotency-Key로 다른 내용의 요청이 들어왔습니다. 새 키로 요청해 주세요."),
    PAYMENT_IN_PROGRESS(HttpStatus.CONFLICT, "같은 결제가 처리 중입니다. 잠시 후 같은 키로 다시 시도해 주세요."),
    PAYMENT_FAILED(HttpStatus.PAYMENT_REQUIRED, "결제가 승인되지 않았습니다. 새 키로 다시 시도해 주세요."),
    ALREADY_PAID(HttpStatus.CONFLICT, "이미 결제가 완료된 예매입니다."),
    RESERVATION_NOT_PAYABLE(HttpStatus.CONFLICT, "결제할 수 없는 상태의 예매입니다."),
    CANCEL_WINDOW_CLOSED(HttpStatus.CONFLICT, "공연 시작 24시간 전까지만 취소할 수 있습니다."),

    // common
    VALIDATION_FAILED(HttpStatus.BAD_REQUEST, "요청 값이 올바르지 않습니다."),
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "서버 오류가 발생했습니다.");

    private final HttpStatus status;
    private final String message;
}
