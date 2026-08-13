package com.seatlock.show;

/**
 * 좌석 상태 전이(AVAILABLE→HELD→RESERVED)가 곧 도메인 규칙이다.
 * PostgreSQL enum "SeatStatus"와 1:1.
 */
public enum SeatStatus {
    AVAILABLE, HELD, RESERVED
}
