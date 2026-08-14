package com.seatlock.common.error;

import java.sql.SQLTransientConnectionException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
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

    /** 역직렬화 불가 바디(잘못된 enum 값, 깨진 JSON 등) — Nest ValidationPipe의 400과 동일 계약 */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> handleUnreadable(HttpMessageNotReadableException e) {
        return ResponseEntity.status(400)
                .body(ErrorResponse.of(ErrorCode.VALIDATION_FAILED, "요청 본문을 해석할 수 없습니다."));
    }

    /**
     * Hikari 풀이 비고 connection-timeout 안에 커넥션을 못 받은 경우.
     * 기본 30초 대기는 오픈 순간 전체 API를 같이 죽인다 — 3초 후 503으로 빠르게 거절한다.
     */
    @ExceptionHandler({CannotGetJdbcConnectionException.class, SQLTransientConnectionException.class})
    public ResponseEntity<ErrorResponse> handlePoolExhausted(Exception e) {
        log.warn("커넥션 풀 고갈: {}", e.getMessage());
        return ResponseEntity.status(ErrorCode.SERVICE_UNAVAILABLE.getStatus())
                .body(ErrorResponse.of(ErrorCode.SERVICE_UNAVAILABLE));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnknown(Exception e) {
        if (isPoolExhausted(e)) {
            return handlePoolExhausted(e);
        }
        log.error("처리되지 않은 예외", e);
        return ResponseEntity.status(500).body(ErrorResponse.of(ErrorCode.INTERNAL_ERROR));
    }

    private static boolean isPoolExhausted(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLTransientConnectionException
                    || t instanceof CannotGetJdbcConnectionException) {
                return true;
            }
            String msg = t.getMessage();
            if (msg != null && msg.contains("Connection is not available")) {
                return true;
            }
        }
        return false;
    }
}
