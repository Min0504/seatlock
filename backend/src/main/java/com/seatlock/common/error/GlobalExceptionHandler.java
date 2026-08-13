package com.seatlock.common.error;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * 모든 예외를 { code, message } 단일 계약으로 변환한다 (Nest GlobalExceptionFilter 포팅).
 * 5xx는 스택을 로그로만 남기고 응답에는 내부 정보를 노출하지 않는다.
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(DomainException.class)
    public ResponseEntity<ErrorResponse> handleDomain(DomainException e) {
        return ResponseEntity.status(e.getErrorCode().getStatus()).body(ErrorResponse.of(e));
    }

    /** Bean Validation 실패 — Nest ValidationPipe의 400 VALIDATION_FAILED와 동일 계약 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException e) {
        String message = e.getBindingResult().getFieldErrors().stream()
                .map(err -> err.getField() + ": " + err.getDefaultMessage())
                .findFirst()
                .orElse(ErrorCode.VALIDATION_FAILED.getMessage());
        return ResponseEntity.status(400).body(ErrorResponse.of(ErrorCode.VALIDATION_FAILED, message));
    }

    /** 경로 변수 타입 불일치(/shows/abc 등)도 검증 실패로 취급한다 */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ErrorResponse> handleTypeMismatch(MethodArgumentTypeMismatchException e) {
        return ResponseEntity.status(400)
                .body(ErrorResponse.of(ErrorCode.VALIDATION_FAILED, "요청 값의 형식이 올바르지 않습니다: " + e.getName()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnknown(Exception e) {
        log.error("처리되지 않은 예외", e);
        return ResponseEntity.status(500).body(ErrorResponse.of(ErrorCode.INTERNAL_ERROR));
    }
}
