package com.seatlock.auth;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface RefreshTokenRepository extends JpaRepository<RefreshToken, Long> {

    Optional<RefreshToken> findByTokenHash(String tokenHash);

    /**
     * 소모 처리를 조건부 UPDATE로 원자화 — 같은 토큰의 동시 refresh(두 탭 경합)에서
     * 정확히 한 요청만 1을 돌려받는다. 엔티티를 읽어 setUsed(true) 후 save 하는 방식은
     * 두 트랜잭션이 같은 미소모 상태를 읽는 틈(check-then-act race)이 생긴다.
     *
     * @Transactional을 서비스가 아닌 여기(메서드 단위)에 두는 이유: AuthService.refresh
     * 주석 참조 — 폐기·소모는 이어지는 401과 무관하게 즉시 커밋돼야 한다.
     */
    @Transactional
    @Modifying(clearAutomatically = true)
    @Query("UPDATE RefreshToken t SET t.used = true WHERE t.id = :id AND t.used = false")
    int consume(@Param("id") Long id);

    /** 재사용 탐지·로그아웃 시 family 일괄 폐기 */
    @Transactional
    @Modifying(clearAutomatically = true)
    @Query("UPDATE RefreshToken t SET t.revoked = true WHERE t.familyId = :familyId AND t.revoked = false")
    int revokeFamily(@Param("familyId") UUID familyId);
}
