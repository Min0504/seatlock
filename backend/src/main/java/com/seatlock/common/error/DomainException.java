package com.seatlock.common.error;

import java.util.Map;
import lombok.Getter;

/**
 * 도메인 에러의 표준형. GlobalExceptionHandler가 { code, message, details? }로 직렬화한다.
 * details는 클라이언트가 후속 행동을 결정하는 데 필요한 최소 정보만 담는다
 * (예: SEAT_ALREADY_TAKEN의 충돌 좌석 목록).
 */
@Getter
public class DomainException extends RuntimeException {

    private final ErrorCode errorCode;
    private final transient Map<String, Object> details;

    public DomainException(ErrorCode errorCode) {
        this(errorCode, null);
    }

    public DomainException(ErrorCode errorCode, Map<String, Object> details) {
        super(errorCode.getMessage());
        this.errorCode = errorCode;
        this.details = details;
    }
}
