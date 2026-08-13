package com.seatlock.auth;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

/**
 * Refresh Token Rotation의 상태 저장소 (Nest 구현과 같은 테이블).
 * Access는 끝까지 stateless(검증 비용 0)로 두고, 수명이 긴 Refresh만 상태를 추적한다 —
 * 검증 비용은 refresh 시점(15분에 1회)에만 발생하는 중간 지점 설계.
 *
 * user를 연관관계(@ManyToOne)가 아닌 FK 값으로 두는 이유: 이 테이블의 모든 접근은
 * 토큰 지문 → 소유자 id 확인뿐이라 User 엔티티 로딩이 필요한 지점이 없다.
 * 연관관계는 그래프 탐색이 필요할 때만 산다 — 여기선 지연 로딩 프록시조차 낭비다.
 */
@Entity
@Table(name = "refresh_tokens")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class RefreshToken {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    // 로그인 1회 = family 1개. rotation으로 이어지는 토큰들이 같은 familyId를 공유하며,
    // 재사용(탈취 신호) 탐지 시 이 단위로 전부 폐기한다.
    @Column(name = "family_id", nullable = false)
    private UUID familyId;

    // 토큰 원문은 저장하지 않는다(SHA-256) — DB가 유출돼도 세션을 탈취할 수 없다.
    // UNIQUE가 rotation의 원자성 장치를 겸한다: 같은 토큰의 중복 등록이 불가능하다.
    // @JdbcTypeCode(CHAR): 스키마가 CHAR(64)다(SHA-256 hex는 항상 64자 고정폭).
    // String의 기본 매핑은 VARCHAR라 ddl-auto=validate가 타입 불일치로 부팅을 막는다.
    @JdbcTypeCode(SqlTypes.CHAR)
    @Column(name = "token_hash", nullable = false, unique = true, length = 64)
    private String tokenHash;

    // rotation으로 소모됨 — used 토큰의 재등장 = 정상 사용자와 탈취범이 둘 다 쓴 증거
    @Column(nullable = false)
    private boolean used;

    // family 폐기(재사용 탐지·로그아웃) 표식
    @Column(nullable = false)
    private boolean revoked;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Builder
    private RefreshToken(Long userId, UUID familyId, String tokenHash, Instant expiresAt) {
        this.userId = userId;
        this.familyId = familyId;
        this.tokenHash = tokenHash;
        this.expiresAt = expiresAt;
    }

    public boolean isExpired(Instant now) {
        return !expiresAt.isAfter(now);
    }
}
