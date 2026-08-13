package com.seatlock.auth;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.support.IntegrationTest;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * Refresh Token Rotation + 재사용 탐지 (backend-nest auth-rotation.e2e-spec 포팅).
 *
 * 위협 모델: Refresh 토큰은 14일 유효하다 — 탈취되면 장기간 세션이 도용된다.
 * Rotation의 계약:
 * - refresh 1회 = 토큰 쌍 교체, 이전 토큰은 그 자리에서 소모(used)
 * - used 토큰의 재등장 = 탈취 신호 → family 전체 폐기 (도둑이 이어받은 세션까지 차단)
 * - 같은 토큰의 동시 refresh는 정확히 1건만 성공 (토큰 쌍 이중 발급 금지)
 */
@DisplayName("Refresh Rotation — 탈취 재사용 탐지")
class AuthRotationIntegrationTest extends IntegrationTest {

    private static final AtomicInteger EMAIL_SEQ = new AtomicInteger();
    private static final String PASSWORD = "password1234";

    /** 테스트마다 새 계정 — family 상태가 테스트 간에 섞이지 않게 한다 */
    private Map<String, Object> loginFresh() {
        String email = "rotation" + EMAIL_SEQ.getAndIncrement() + "@test.com";
        assertThat(post("/auth/signup", Map.of("email", email, "password", PASSWORD), null)
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        ResponseEntity<Map<String, Object>> login =
                post("/auth/login", Map.of("email", email, "password", PASSWORD), null);
        assertThat(login.getStatusCode()).isEqualTo(HttpStatus.OK);
        return login.getBody();
    }

    private ResponseEntity<Map<String, Object>> refresh(Object refreshToken) {
        return post("/auth/refresh", Map.of("refreshToken", refreshToken), null);
    }

    @Test
    @DisplayName("refresh하면 새 쌍이 발급되고, 소모된 이전 토큰은 즉시 무효다")
    void rotationConsumesOldToken() {
        Map<String, Object> first = loginFresh();

        ResponseEntity<Map<String, Object>> rotated = refresh(first.get("refreshToken"));
        assertThat(rotated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rotated.getBody().get("refreshToken")).isNotEqualTo(first.get("refreshToken"));

        // 방금 소모된 토큰의 재사용 — stateless 검증(v1)이라면 서명이 유효해 200이 나온다
        assertThat(refresh(first.get("refreshToken")).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("재사용 탐지는 family 전체를 폐기한다 — 탈취범이 이어받은 세션도 죽는다")
    void reuseDetectionRevokesWholeFamily() {
        // 피해자 로그인 → 탈취범이 refresh 토큰을 복사해갔다고 가정
        Object stolen = loginFresh().get("refreshToken");

        // 탈취범이 먼저 갱신에 성공해 새 쌍을 확보한다 (피해자는 아직 모른다)
        ResponseEntity<Map<String, Object>> attacker = refresh(stolen);
        assertThat(attacker.getStatusCode()).isEqualTo(HttpStatus.OK);

        // 피해자의 앱이 원래 토큰으로 갱신 시도 → used 토큰의 재등장 = 탈취 신호
        assertThat(refresh(stolen).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        // 핵심: 탐지 순간 family 전체가 폐기돼 탈취범이 확보한 새 토큰도 무효가 된다.
        // 이 한 줄이 없으면 "재사용은 거부하지만 도둑의 세션은 계속 살아있는" 반쪽 방어다.
        assertThat(refresh(attacker.getBody().get("refreshToken")).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("같은 토큰의 동시 refresh 경합 — 새 쌍 발급은 정확히 1건이어야 한다")
    void concurrentRefreshIssuesExactlyOnePair() throws Exception {
        Object refreshToken = loginFresh().get("refreshToken");

        int attempts = 10;
        CountDownLatch startGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(attempts);
        try {
            List<CompletableFuture<HttpStatus>> futures = IntStream.range(0, attempts)
                    .mapToObj(i -> CompletableFuture.supplyAsync(() -> {
                        try {
                            startGate.await();
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return (HttpStatus) refresh(refreshToken).getStatusCode();
                    }, pool))
                    .toList();
            startGate.countDown();

            long successes = futures.stream().map(CompletableFuture::join)
                    .filter(HttpStatus.OK::equals)
                    .count();
            // 토큰 1개 = 갱신 1회. 2건 이상 성공하면 유효한 세션이 복제된 것이다.
            // (경합 패자가 family를 폐기하는지는 도착 순서에 따라 갈리므로 단정하지 않는다)
            assertThat(successes).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @DisplayName("로그아웃은 family를 폐기한다 — 남은 refresh 토큰이 전부 무효")
    void logoutRevokesFamily() {
        Map<String, Object> pair = loginFresh();
        ResponseEntity<Map<String, Object>> rotated = refresh(pair.get("refreshToken"));
        assertThat(rotated.getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<Map<String, Object>> logout = post(
                "/auth/logout",
                Map.of("refreshToken", rotated.getBody().get("refreshToken")),
                (String) rotated.getBody().get("accessToken"));
        assertThat(logout.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        assertThat(refresh(rotated.getBody().get("refreshToken")).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("로그인은 독립된 family를 만든다 — 한 기기의 폐기가 다른 기기를 죽이지 않는다")
    void familiesAreIndependentPerLogin() {
        String email = "rotation-multi" + EMAIL_SEQ.getAndIncrement() + "@test.com";
        post("/auth/signup", Map.of("email", email, "password", PASSWORD), null);
        Map<String, Object> deviceA =
                post("/auth/login", Map.of("email", email, "password", PASSWORD), null).getBody();
        Map<String, Object> deviceB =
                post("/auth/login", Map.of("email", email, "password", PASSWORD), null).getBody();

        // 기기 A에서 재사용 탐지 유발 → A의 family만 폐기
        assertThat(refresh(deviceA.get("refreshToken")).getStatusCode()).isEqualTo(HttpStatus.OK);
        refresh(deviceA.get("refreshToken")); // 재사용 → family A 폐기

        assertThat(refresh(deviceB.get("refreshToken")).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("위조·변조 토큰과 access 토큰은 형태와 무관하게 401 (회귀 가드)")
    void malformedAndWrongTypeTokensAreRejected() {
        Map<String, Object> pair = loginFresh();

        // access 토큰은 다른 키로 서명되고 type 클레임도 다르다 — refresh 자리에선 무효
        assertThat(refresh(pair.get("accessToken")).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        String forged = UUID.randomUUID() + "." + UUID.randomUUID() + "." + UUID.randomUUID();
        assertThat(refresh(forged).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }
}
