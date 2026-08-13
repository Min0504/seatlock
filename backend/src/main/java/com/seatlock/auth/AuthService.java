package com.seatlock.auth;

import com.seatlock.auth.dto.AuthDtos.SignupResponse;
import com.seatlock.auth.dto.AuthDtos.TokenPair;
import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.common.jwt.JwtProvider;
import com.seatlock.user.Role;
import com.seatlock.user.User;
import com.seatlock.user.UserRepository;
import io.jsonwebtoken.Claims;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * 인증 서비스 (Nest AuthService 포팅 — 계약·보안 속성 동일).
 *
 * 주의: refresh()는 의도적으로 하나의 @Transactional로 묶지 않는다.
 * 재사용 탐지 시 "family 폐기 후 401"인데, 폐기와 throw가 같은 트랜잭션이면
 * 예외가 폐기를 롤백해 탐지가 무효가 된다. Nest 구현도 문장 단위 커밋이었다 —
 * 상태 변경(consume/revoke)은 리포지토리 메서드 단위의 짧은 트랜잭션으로 커밋된다.
 * (@Transactional의 rollback 규칙이 도메인 의미를 바꾸는 대표 사례)
 */
@Slf4j
@Service
public class AuthService {

    private final UserRepository userRepository;
    private final RefreshTokenRepository refreshTokenRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtProvider jwtProvider;

    // 존재하지 않는 이메일로 로그인 시도할 때도 bcrypt 비교를 수행하기 위한 더미 해시.
    // 이메일 존재 여부에 따라 응답 시간이 달라지면(타이밍 공격) 계정 존재가 노출된다.
    private final String dummyHash;

    public AuthService(
            UserRepository userRepository,
            RefreshTokenRepository refreshTokenRepository,
            PasswordEncoder passwordEncoder,
            JwtProvider jwtProvider) {
        this.userRepository = userRepository;
        this.refreshTokenRepository = refreshTokenRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtProvider = jwtProvider;
        this.dummyHash = passwordEncoder.encode("timing-attack-guard");
    }

    public SignupResponse signup(String email, String password) {
        try {
            User user = userRepository.save(User.builder()
                    .email(email)
                    .passwordHash(passwordEncoder.encode(password))
                    .role(Role.USER)
                    .build());
            return new SignupResponse(user.getId(), user.getEmail());
        } catch (DataIntegrityViolationException e) {
            // 이메일 중복은 UNIQUE 제약 위반으로 판정한다.
            // 사전 조회(check-then-act)는 동시 가입 요청 사이에 뚫릴 수 있기 때문.
            throw new DomainException(ErrorCode.EMAIL_EXISTS);
        }
    }

    public TokenPair login(String email, String password) {
        User user = userRepository.findByEmail(email).orElse(null);
        String hash = user != null ? user.getPasswordHash() : dummyHash;
        boolean matches = passwordEncoder.matches(password, hash);
        if (user == null || !matches) {
            // 이메일/비밀번호 중 무엇이 틀렸는지 구분해 주지 않는다 — 계정 열거 방지
            throw new DomainException(ErrorCode.INVALID_CREDENTIALS);
        }
        return issueTokens(user, null);
    }

    /**
     * Refresh Token Rotation (기획서 §7 문제 4).
     *
     * refresh 1회 = 토큰 쌍 교체. 이전 토큰은 그 자리에서 소모(used)되고, 소모된
     * 토큰이 다시 오면 "정상 사용자와 탈취범 둘 다 썼다"는 유일한 해석만 남으므로
     * family 전체를 폐기해 양쪽 모두 재로그인시킨다.
     *
     * 모든 실패는 동일한 401이다. 실패 사유(위조/만료/재사용 탐지)를 구분해 주면
     * 공격자에게 탐지 시스템의 동작을 알려주는 오라클이 된다.
     */
    public TokenPair refresh(String refreshToken) {
        Claims claims = jwtProvider.parseRefreshToken(refreshToken)
                .orElseThrow(() -> new DomainException(ErrorCode.UNAUTHORIZED));

        RefreshToken stored = refreshTokenRepository.findByTokenHash(sha256(refreshToken))
                .orElseThrow(() -> new DomainException(ErrorCode.UNAUTHORIZED));
        // 서명은 유효한데 기록이 없거나 폐기·만료됐다 = 재로그인 대상
        if (stored.isRevoked() || stored.isExpired(Instant.now())) {
            throw new DomainException(ErrorCode.UNAUTHORIZED);
        }

        if (stored.isUsed()) {
            // 재사용 탐지 — 이 토큰은 이미 rotation으로 소모됐다. 지금 이 요청과 과거의
            // 정상 갱신, 둘 중 하나는 반드시 탈취범이다. 누가 도둑인지 알 수 없으므로
            // family의 모든 토큰을 폐기해 도둑이 이어받은 세션까지 끊는다.
            refreshTokenRepository.revokeFamily(stored.getFamilyId());
            log.warn("refresh 토큰 재사용 탐지 — user={} family={} 전체 폐기",
                    stored.getUserId(), stored.getFamilyId());
            throw new DomainException(ErrorCode.UNAUTHORIZED);
        }

        // 조건부 UPDATE 관문 — 같은 토큰의 동시 refresh에서 정확히 한 요청만 통과한다.
        // 패자는 새 쌍 없이 401로 끝난다(이중 발급 금지).
        if (refreshTokenRepository.consume(stored.getId()) != 1) {
            throw new DomainException(ErrorCode.UNAUTHORIZED);
        }

        User user = userRepository.findById(stored.getUserId())
                .orElseThrow(() -> new DomainException(ErrorCode.UNAUTHORIZED));
        // sub 클레임과 저장 소유자는 항상 같아야 한다 — 다르면 데이터 오염이므로 재로그인
        if (!String.valueOf(user.getId()).equals(claims.getSubject())) {
            throw new DomainException(ErrorCode.UNAUTHORIZED);
        }
        // 새 토큰은 같은 family를 잇는다 — 로그인부터 이어지는 rotation 사슬의 식별자
        return issueTokens(user, stored.getFamilyId());
    }

    /**
     * 로그아웃 — 제출된 refresh 토큰이 속한 family를 폐기한다.
     * 본인 소유 토큰만 유효하며, 이미 폐기됐거나 모르는 토큰이어도 같은 결과(204)로
     * 끝난다(멱등). access 토큰은 stateless라 만료(15분)까지 유효한데, 이를 즉시
     * 죽이려면 모든 요청에 블랙리스트 조회가 붙는다 — 15분 노출을 받아들이는 트레이드오프.
     */
    public void logout(long userId, String refreshToken) {
        refreshTokenRepository.findByTokenHash(sha256(refreshToken))
                .filter(stored -> stored.getUserId() == userId)
                .ifPresent(stored -> refreshTokenRepository.revokeFamily(stored.getFamilyId()));
    }

    private TokenPair issueTokens(User user, UUID familyId) {
        String accessToken = jwtProvider.issueAccessToken(user.getId(), user.getRole());
        String refreshToken = jwtProvider.issueRefreshToken(user.getId());

        // 로그인(familyId 없음)은 새 family를 연다 — 기기마다 독립된 rotation 사슬을
        // 가져야 한 기기의 탈취·폐기가 다른 기기의 세션을 죽이지 않는다.
        refreshTokenRepository.save(RefreshToken.builder()
                .userId(user.getId())
                .familyId(familyId != null ? familyId : UUID.randomUUID())
                .tokenHash(sha256(refreshToken))
                .expiresAt(Instant.now().plusSeconds(jwtProvider.refreshTtlSec()))
                .build());

        return new TokenPair(accessToken, refreshToken);
    }

    /** 토큰 원문 대신 저장·조회에 쓰는 지문 — DB가 유출돼도 토큰을 복원할 수 없다 */
    static String sha256(String token) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256을 지원하지 않는 JVM", e);
        }
    }
}
