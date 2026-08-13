package com.seatlock.performance;

import static org.assertj.core.api.Assertions.assertThat;

import com.seatlock.support.IntegrationTest;
import com.seatlock.user.Role;
import com.seatlock.user.User;
import com.seatlock.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * 카탈로그 + 인가 경계 검증 (backend-nest reservation-flow.e2e-spec의 카탈로그 구간 포팅).
 * 가입/로그인 → (ADMIN) 공연장/공연/회차/좌석 생성 → 목록/검색/상세 → 좌석맵.
 */
@DisplayName("카탈로그 — 관리자 등록과 공개 조회")
class CatalogIntegrationTest extends IntegrationTest {

    private static final String PASSWORD = "password1234";

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    private String adminToken;
    private String userToken;

    @BeforeEach
    void setUp() {
        truncateAll();

        // ADMIN 승격 API는 의도적으로 없다(기획서 §4) — Nest의 seedAdmin처럼 직접 심는다
        userRepository.save(User.builder()
                .email("admin@test.com")
                .passwordHash(passwordEncoder.encode(PASSWORD))
                .role(Role.ADMIN)
                .build());
        adminToken = login("admin@test.com");

        post("/auth/signup", Map.of("email", "user@test.com", "password", PASSWORD), null);
        userToken = login("user@test.com");
    }

    private String login(String email) {
        ResponseEntity<Map<String, Object>> res =
                post("/auth/login", Map.of("email", email, "password", PASSWORD), null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("accessToken");
    }

    @Test
    @DisplayName("중복 이메일 가입은 409 EMAIL_EXISTS를 반환한다")
    void duplicateSignupConflicts() {
        ResponseEntity<Map<String, Object>> dup =
                post("/auth/signup", Map.of("email", "user@test.com", "password", PASSWORD), null);
        assertThat(dup.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(dup.getBody().get("code")).isEqualTo("EMAIL_EXISTS");
    }

    @Test
    @DisplayName("관리자 API 인가 경계 — 비로그인 401, 일반 사용자 403")
    void adminEndpointsAreLockedDown() {
        Map<String, Object> body = Map.of("title", "x", "venueId", 1);

        ResponseEntity<Map<String, Object>> anonymous = post("/admin/performances", body, null);
        assertThat(anonymous.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(anonymous.getBody().get("code")).isEqualTo("UNAUTHORIZED");

        ResponseEntity<Map<String, Object>> plainUser = post("/admin/performances", body, userToken);
        assertThat(plainUser.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(plainUser.getBody().get("code")).isEqualTo("FORBIDDEN");
    }

    @Test
    @DisplayName("ADMIN이 공연장→공연→회차→좌석을 만들고, 공개 API로 조회된다")
    void fullCatalogFlow() {
        // 1) 공연장 + 좌석 템플릿
        ResponseEntity<Map<String, Object>> venue = post("/admin/venues", Map.of(
                "name", "테스트 아트홀",
                "address", "서울시 어딘가 1",
                "seats", List.of(
                        Map.of("section", "A", "rowNo", "1", "seatNo", 1),
                        Map.of("section", "A", "rowNo", "1", "seatNo", 2),
                        Map.of("section", "B", "rowNo", "1", "seatNo", 1))), adminToken);
        assertThat(venue.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(venue.getBody().get("seatCount")).isEqualTo(3);
        Number venueId = (Number) venue.getBody().get("id");

        // 2) 공연
        ResponseEntity<Map<String, Object>> performance = post("/admin/performances", Map.of(
                "title", "테스트 콘서트",
                "description", "설명",
                "venueId", venueId), adminToken);
        assertThat(performance.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Number performanceId = (Number) performance.getBody().get("id");

        // 3) 회차
        ResponseEntity<Map<String, Object>> show = post("/admin/shows", Map.of(
                "performanceId", performanceId,
                "startsAt", Instant.now().plus(30, ChronoUnit.DAYS).toString(),
                "ticketOpenAt", Instant.now().minus(1, ChronoUnit.HOURS).toString()), adminToken);
        assertThat(show.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Number showId = (Number) show.getBody().get("id");

        // 4) 회차 좌석 — 구역별 가격
        ResponseEntity<Map<String, Object>> seats = post("/admin/shows/" + showId + "/seats",
                Map.of("prices", List.of(
                        Map.of("section", "A", "price", 150000),
                        Map.of("section", "B", "price", 90000))), adminToken);
        assertThat(seats.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(seats.getBody().get("count")).isEqualTo(3);

        // 같은 회차 재생성은 409 — UNIQUE(show_id, seat_id)가 최종 방어선
        ResponseEntity<Map<String, Object>> dup = post("/admin/shows/" + showId + "/seats",
                Map.of("prices", List.of(Map.of("section", "A", "price", 150000))), adminToken);
        assertThat(dup.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(dup.getBody().get("code")).isEqualTo("SEATS_ALREADY_CREATED");

        // 5) 공개 조회 — 목록(검색), 상세, 좌석맵 (비로그인 허용)
        ResponseEntity<Map<String, Object>> list = get("/performances?q={q}", null, "테스트");
        assertThat(list.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<?>) list.getBody().get("items")).hasSize(1);

        ResponseEntity<Map<String, Object>> detail = get("/performances/" + performanceId, null);
        assertThat(detail.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(detail.getBody().get("title")).isEqualTo("테스트 콘서트");
        @SuppressWarnings("unchecked")
        Map<String, Object> detailVenue = (Map<String, Object>) detail.getBody().get("venue");
        assertThat(detailVenue.get("name")).isEqualTo("테스트 아트홀");
        assertThat((List<?>) detail.getBody().get("shows")).hasSize(1);

        ResponseEntity<Map<String, Object>> seatMap = get("/shows/" + showId + "/seats", null);
        assertThat(seatMap.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> mapSeats = (List<Map<String, Object>>) seatMap.getBody().get("seats");
        assertThat(mapSeats).hasSize(3);
        assertThat(mapSeats).allMatch(s -> "AVAILABLE".equals(s.get("status")));
    }

    @Test
    @DisplayName("검색은 설명(출연진)도 부분 일치하고, LIKE 메타문자는 무력화된다")
    void searchMatchesDescriptionAndEscapesLikeMeta() {
        ResponseEntity<Map<String, Object>> venue = post("/admin/venues", Map.of(
                "name", "홀", "address", "주소",
                "seats", List.of(Map.of("section", "A", "rowNo", "1", "seatNo", 1))), adminToken);
        Number venueId = (Number) venue.getBody().get("id");

        post("/admin/performances", Map.of(
                "title", "오페라의 유령",
                "description", "출연: 조승우",
                "venueId", venueId), adminToken);

        // 제목이 아니라 설명에만 있는 검색어 — search_text 결합 컬럼 덕에 매치된다
        ResponseEntity<Map<String, Object>> byCast = get("/performances?q={q}", null, "조승우");
        assertThat((List<?>) byCast.getBody().get("items")).hasSize(1);

        // '%'가 와일드카드로 해석되면 전체가 긁힌다 — 리터럴로 무력화됐다면 0건
        ResponseEntity<Map<String, Object>> meta = get("/performances?q={q}", null, "%");
        assertThat((List<?>) meta.getBody().get("items")).isEmpty();
    }

    @Test
    @DisplayName("커서 페이지네이션 — 겹침 없이 다음 페이지로 이어진다")
    void cursorPaginationWalksWithoutOverlap() {
        ResponseEntity<Map<String, Object>> venue = post("/admin/venues", Map.of(
                "name", "홀", "address", "주소",
                "seats", List.of(Map.of("section", "A", "rowNo", "1", "seatNo", 1))), adminToken);
        Number venueId = (Number) venue.getBody().get("id");
        for (int i = 1; i <= 5; i++) {
            post("/admin/performances",
                    Map.of("title", "공연 " + i, "venueId", venueId), adminToken);
        }

        ResponseEntity<Map<String, Object>> first = get("/performances?size=2", null);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> page1 = (List<Map<String, Object>>) first.getBody().get("items");
        assertThat(page1).hasSize(2);
        assertThat(first.getBody().get("nextCursor")).isNotNull();

        ResponseEntity<Map<String, Object>> second =
                get("/performances?size=2&cursor=" + first.getBody().get("nextCursor"), null);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> page2 = (List<Map<String, Object>>) second.getBody().get("items");
        assertThat(page2).hasSize(2);

        List<Object> page1Ids = page1.stream().map(i -> i.get("id")).toList();
        assertThat(page2).noneMatch(i -> page1Ids.contains(i.get("id")));
    }

    @Test
    @DisplayName("없는 리소스는 404와 도메인 에러 코드로 응답한다")
    void notFoundContract() {
        ResponseEntity<Map<String, Object>> performance = get("/performances/999999", null);
        assertThat(performance.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(performance.getBody().get("code")).isEqualTo("PERFORMANCE_NOT_FOUND");

        ResponseEntity<Map<String, Object>> seatMap = get("/shows/999999/seats", null);
        assertThat(seatMap.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(seatMap.getBody().get("code")).isEqualTo("SHOW_NOT_FOUND");
    }

    @Test
    @DisplayName("검증 실패는 400 VALIDATION_FAILED 계약으로 응답한다")
    void validationContract() {
        ResponseEntity<Map<String, Object>> res =
                post("/auth/signup", Map.of("email", "not-an-email", "password", "short"), null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("VALIDATION_FAILED");
    }
}
