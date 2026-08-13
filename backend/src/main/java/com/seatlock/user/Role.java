package com.seatlock.user;

/** PostgreSQL enum "Role"과 1:1 — 값 추가는 DB 타입과 함께 마이그레이션으로만 한다 */
public enum Role {
    USER, ADMIN
}
