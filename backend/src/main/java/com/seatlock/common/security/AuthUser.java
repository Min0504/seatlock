package com.seatlock.common.security;

import com.seatlock.user.Role;

/**
 * SecurityContext에 올라가는 인증 주체 — Nest의 AuthenticatedUser와 동일한 최소 정보.
 * 매 요청 DB 조회 없이 토큰 클레임만으로 구성한다(stateless access의 핵심 비용 절감).
 */
public record AuthUser(long id, Role role) {
}
