package com.seatlock.common.jwt;

import com.seatlock.user.Role;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.SecretKey;
import org.springframework.stereotype.Component;

/**
 * JWT 발급·검증 (Nest JwtService 사용부 포팅 — HS256 대칭키, 계약 동일).
 *
 * access와 refresh는 서로 다른 secret으로 서명한다. 같은 키를 쓰면 수명이 짧은
 * access 토큰을 refresh 엔드포인트에 넣는 오용이 서명 검증을 통과해 버리므로,
 * 키 분리 + type 클레임 이중으로 용도를 격리한다.
 */
@Component
public class JwtProvider {

    /** refresh 토큰의 용도 태그 — access 토큰의 refresh 엔드포인트 오용을 구분한다 */
    public static final String TYPE_REFRESH = "refresh";

    private final SecretKey accessKey;
    private final SecretKey refreshKey;
    private final JwtProperties properties;

    public JwtProvider(JwtProperties properties) {
        this.accessKey = Keys.hmacShaKeyFor(properties.accessSecret().getBytes(StandardCharsets.UTF_8));
        this.refreshKey = Keys.hmacShaKeyFor(properties.refreshSecret().getBytes(StandardCharsets.UTF_8));
        this.properties = properties;
    }

    public String issueAccessToken(long userId, Role role) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("role", role.name())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(properties.accessTtlSec())))
                .signWith(accessKey)
                .compact();
    }

    /**
     * jti(무작위 UUID)를 심는 이유: 같은 사용자가 같은 초에 두 번 로그인하면
     * sub/iat/exp가 전부 같아 JWT 문자열까지 동일해진다 — token_hash UNIQUE와
     * 충돌하므로 발급마다 난수로 토큰의 유일성을 보장한다.
     */
    public String issueRefreshToken(long userId) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("type", TYPE_REFRESH)
                .id(UUID.randomUUID().toString())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(properties.refreshTtlSec())))
                .signWith(refreshKey)
                .compact();
    }

    /** 서명·만료가 유효하면 클레임을, 아니면 empty를 돌려준다 — 예외를 흐름 제어에 쓰지 않는다 */
    public Optional<Claims> parseAccessToken(String token) {
        return parse(token, accessKey);
    }

    public Optional<Claims> parseRefreshToken(String token) {
        return parse(token, refreshKey).filter(c -> TYPE_REFRESH.equals(c.get("type", String.class)));
    }

    public long refreshTtlSec() {
        return properties.refreshTtlSec();
    }

    private Optional<Claims> parse(String token, SecretKey key) {
        try {
            return Optional.of(
                    Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload());
        } catch (Exception e) {
            return Optional.empty();
        }
    }
}
