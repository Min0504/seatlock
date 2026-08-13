package com.seatlock.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 인증 요청/응답 DTO — backend-nest의 auth.dto.ts와 동일한 검증 규칙 */
public final class AuthDtos {

    private AuthDtos() {
    }

    public record SignupRequest(
            @Schema(example = "user@example.com")
            @Email @NotBlank @Size(max = 255)
            String email,

            // bcrypt는 72바이트 이후를 무시하므로 그 이하로 상한을 강제한다
            @Schema(example = "password1234")
            @NotBlank @Size(min = 8, max = 72)
            String password
    ) {
    }

    public record LoginRequest(
            @Schema(example = "user@example.com")
            @Email @NotBlank
            String email,

            @Schema(example = "password1234")
            @NotBlank
            String password
    ) {
    }

    public record RefreshRequest(
            @Schema(description = "Refresh Token")
            @NotBlank
            String refreshToken
    ) {
    }

    public record SignupResponse(Long id, String email) {
    }

    public record TokenPair(String accessToken, String refreshToken) {
    }
}
