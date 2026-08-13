package com.seatlock.support;

import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * 통합 테스트 베이스 — 실제 PostgreSQL 16(Testcontainers) 위에서 전체 스택을 돌린다.
 *
 * <p>H2 같은 인메모리 DB를 쓰지 않는 이유(기획서 §11): 이 프로젝트의 검증 대상은
 * 조건부 UPDATE의 rowCount, 부분 유니크 인덱스, PG enum, pg_trgm처럼
 * "PostgreSQL 엔진의 실제 동작"이며 인메모리 대체재는 이를 흉내 내지 못한다.
 *
 * <p>컨테이너는 JVM당 1개를 공유하는 싱글턴 패턴이다. {@code @Container} 필드는
 * 테스트 클래스가 끝날 때마다 컨테이너를 내리고 새로 올려 클래스 수 × 수 초를
 * 낭비하므로 static 초기화 블록에서 직접 start()한다(Ryuk이 JVM 종료 시 정리).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public abstract class IntegrationTest {

    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

    static {
        POSTGRES.start();
    }

    @DynamicPropertySource
    static void overrideProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        // HS256 키는 256bit(32byte) 이상이어야 jjwt가 수용한다
        registry.add("jwt.access-secret", () -> "test-access-secret-must-be-at-least-32-bytes");
        registry.add("jwt.refresh-secret", () -> "test-refresh-secret-must-be-at-least-32-bytes");
        // 백그라운드 스위퍼를 끈다 — "만료됐지만 회수 전" 상태를 결정적으로 만들기 위함.
        // 회수 SQL 자체는 SeatStateRepository.reclaimExpired()를 직접 호출해 검증한다.
        registry.add("seatlock.hold-sweeper.enabled", () -> "false");
    }

    @Autowired
    protected TestRestTemplate rest;

    @Autowired
    protected JdbcTemplate jdbc;

    /** 테스트 간 격리 — 시퀀스까지 초기화해 ID 의존 단언이 흔들리지 않게 한다 */
    protected void truncateAll() {
        jdbc.execute("""
                TRUNCATE TABLE payments, reservation_seats, reservations, show_seats, shows,
                               performances, seats, venues, refresh_tokens, users
                RESTART IDENTITY CASCADE""");
    }

    private static final ParameterizedTypeReference<Map<String, Object>> JSON_MAP =
            new ParameterizedTypeReference<>() {
            };

    /** supertest의 request().post().send()에 대응하는 얇은 헬퍼 — 응답은 Map으로 받아 단언한다 */
    protected ResponseEntity<Map<String, Object>> post(String path, Object body, String token) {
        return rest.exchange(path, HttpMethod.POST, entity(body, token), JSON_MAP);
    }

    protected ResponseEntity<Map<String, Object>> get(String path, String token, Object... uriVars) {
        return rest.exchange(path, HttpMethod.GET, entity(null, token), JSON_MAP, uriVars);
    }

    protected ResponseEntity<Map<String, Object>> delete(String path, String token) {
        return rest.exchange(path, HttpMethod.DELETE, entity(null, token), JSON_MAP);
    }

    private HttpEntity<Object> entity(Object body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return new HttpEntity<>(body, headers);
    }
}
