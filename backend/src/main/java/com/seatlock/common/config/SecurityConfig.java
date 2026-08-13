package com.seatlock.common.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.common.error.ErrorResponse;
import com.seatlock.common.security.JwtAuthenticationFilter;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Spring Security 필터 체인 (Nest의 전역 JwtAuthGuard + RolesGuard 포팅).
 *
 * Nest에서는 "전역 가드 + @Public 데코레이터 예외" 모델이었다. Spring에서는 반대로
 * "명시된 public 경로 외 전부 인증 필요"를 인가 규칙 한 곳에 선언한다 — 모델은
 * 달라도 계약은 같다: 기본 잠금(deny-by-default), 예외만 명시.
 */
@Configuration
@EnableWebSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    // cost 12: 2026년 기준 해싱 1회 ~250ms — 온라인 로그인 UX를 해치지 않으면서
    // 오프라인 무차별 대입 비용을 충분히 올리는 업계 권장 균형점 (Nest 구현과 동일)
    public static final int BCRYPT_COST = 12;

    private final JwtAuthenticationFilter jwtAuthenticationFilter;
    private final ObjectMapper objectMapper;

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
                // 세션·폼로그인·CSRF는 브라우저 세션 모델의 장치 — Bearer 토큰 API에선 전부 끈다
                .csrf(csrf -> csrf.disable())
                .formLogin(form -> form.disable())
                .httpBasic(basic -> basic.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.POST, "/auth/signup", "/auth/login", "/auth/refresh").permitAll()
                        .requestMatchers(HttpMethod.GET, "/performances", "/performances/*", "/shows/*/seats").permitAll()
                        .requestMatchers("/docs", "/docs/**", "/swagger-ui/**", "/v3/api-docs/**").permitAll()
                        .requestMatchers("/actuator/health").permitAll()
                        .requestMatchers("/admin/**").hasRole("ADMIN")
                        .anyRequest().authenticated())
                // 401/403도 도메인 에러와 같은 { code, message } 계약으로 응답한다
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) ->
                                writeError(res, HttpServletResponse.SC_UNAUTHORIZED, ErrorCode.UNAUTHORIZED))
                        .accessDeniedHandler((req, res, ex) ->
                                writeError(res, HttpServletResponse.SC_FORBIDDEN, ErrorCode.FORBIDDEN)))
                .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(BCRYPT_COST);
    }

    private void writeError(HttpServletResponse res, int status, ErrorCode code) throws java.io.IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        res.setCharacterEncoding("UTF-8");
        res.getWriter().write(objectMapper.writeValueAsString(ErrorResponse.of(code)));
    }
}
