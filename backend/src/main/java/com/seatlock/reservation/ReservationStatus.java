package com.seatlock.reservation;

/** PostgreSQL enum "ReservationStatus" 미러 — 값·순서를 스키마와 동일하게 유지한다 */
public enum ReservationStatus {
    PENDING,
    CONFIRMED,
    CANCELED
}
