package com.seatlock.common.security;

import com.seatlock.common.jwt.JwtProvider;
import com.seatlock.user.Role;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Bearer 토큰을 파싱해 SecurityContext에 인증을 심는다 (Nest JwtAuthGuard 포팅).
 *
 * 토큰이 없거나 무효여도 여기서 응답을 끊지 않고 다음 필터로 넘긴다 —
 * "보호된 경로인가"의 판단은 SecurityConfig의 authorizeHttpRequests가 하고,
 * 미인증 접근의 401 변환은 AuthenticationEntryPoint가 맡는다. 판단 지점을
 * 한 곳(인가 규칙)으로 모아야 public 경로 목록이 두 군데로 갈라지지 않는다.
 */
@Component
@RequiredArgsConstructor
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private static final String BEARER_PREFIX = "Bearer ";

    private final JwtProvider jwtProvider;

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith(BEARER_PREFIX)) {
            jwtProvider.parseAccessToken(header.substring(BEARER_PREFIX.length())).ifPresent(claims -> {
                AuthUser user = new AuthUser(
                        Long.parseLong(claims.getSubject()),
                        Role.valueOf(claims.get("role", String.class)));
                var authentication = new UsernamePasswordAuthenticationToken(
                        user, null, List.of(new SimpleGrantedAuthority("ROLE_" + user.role().name())));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            });
        }
        chain.doFilter(request, response);
    }
}
