package com.seatlock.common.jwt;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * JWT 설정 — Nest 구현과 동일한 환경변수 계약(JWT_*)을 relaxed binding으로 받는다.
 * TTL은 초 단위 숫자로 관리한다: "15m" 같은 문자열 포맷은 파서 구현마다 해석이
 * 갈릴 수 있어 설정 오류를 만들기 쉽다 (기본: access 15분, refresh 14일).
 * secret이 없으면 부팅이 실패한다(fail-fast) — 런타임에 null 키로 서명하는 사고보다 싸다.
 */
@ConfigurationProperties(prefix = "jwt")
public record JwtProperties(
        String accessSecret,
        String refreshSecret,
        long accessTtlSec,
        long refreshTtlSec
) {
    public JwtProperties {
        if (accessSecret == null || accessSecret.isBlank()
                || refreshSecret == null || refreshSecret.isBlank()) {
            throw new IllegalStateException("JWT_ACCESS_SECRET / JWT_REFRESH_SECRET 환경변수가 필요합니다.");
        }
    }
}
