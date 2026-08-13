package com.seatlock.common.error;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/** 모든 에러 응답의 단일 계약 — backend-nest의 GlobalExceptionFilter 출력과 동일한 형태 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorResponse(String code, String message, Map<String, Object> details) {

    public static ErrorResponse of(ErrorCode errorCode) {
        return new ErrorResponse(errorCode.name(), errorCode.getMessage(), null);
    }

    public static ErrorResponse of(DomainException e) {
        return new ErrorResponse(e.getErrorCode().name(), e.getMessage(), e.getDetails());
    }

    public static ErrorResponse of(ErrorCode errorCode, String message) {
        return new ErrorResponse(errorCode.name(), message, null);
    }
}
