package com.seatlock.auth;

import com.seatlock.auth.dto.AuthDtos.LoginRequest;
import com.seatlock.auth.dto.AuthDtos.RefreshRequest;
import com.seatlock.auth.dto.AuthDtos.SignupRequest;
import com.seatlock.auth.dto.AuthDtos.SignupResponse;
import com.seatlock.auth.dto.AuthDtos.TokenPair;
import com.seatlock.common.security.AuthUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "auth")
@RestController
@RequestMapping("/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @PostMapping("/signup")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "회원가입")
    public SignupResponse signup(@Valid @RequestBody SignupRequest request) {
        return authService.signup(request.email(), request.password());
    }

    @PostMapping("/login")
    @Operation(summary = "로그인 — Access(15m) + Refresh(14d) 발급")
    public TokenPair login(@Valid @RequestBody LoginRequest request) {
        return authService.login(request.email(), request.password());
    }

    @PostMapping("/refresh")
    @Operation(summary = "토큰 재발급 (Rotation)",
            description = "새 쌍을 발급하고 이전 refresh 토큰을 소모 처리한다. "
                    + "소모된 토큰이 재사용되면 탈취로 판정해 로그인 단위(family) 전체를 폐기한다.")
    public TokenPair refresh(@Valid @RequestBody RefreshRequest request) {
        return authService.refresh(request.refreshToken());
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @SecurityRequirement(name = "bearerAuth")
    @Operation(summary = "로그아웃 — 이 기기의 refresh 토큰 family 폐기")
    public void logout(@AuthenticationPrincipal AuthUser user, @Valid @RequestBody RefreshRequest request) {
        authService.logout(user.id(), request.refreshToken());
    }
}
