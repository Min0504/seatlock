package com.seatlock.support;

import com.seatlock.common.jwt.JwtProvider;
import com.seatlock.performance.Performance;
import com.seatlock.performance.PerformanceRepository;
import com.seatlock.performance.Venue;
import com.seatlock.performance.VenueRepository;
import com.seatlock.show.Show;
import com.seatlock.show.ShowRepository;
import com.seatlock.user.Role;
import com.seatlock.user.User;
import com.seatlock.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * 도메인 시나리오 테스트의 픽스처 조립 — 카탈로그는 리포지토리로 직접 심는다.
 *
 * 관리자 API 경유 세팅(Nest e2e 방식)은 CatalogIntegrationTest가 이미 검증하는
 * 경로의 반복이라 여기서는 생략한다. 특히 bcrypt(cost 12, ~250ms/회)를 유저 수만큼
 * 반복하지 않도록 해시를 1회만 계산해 공유하고, 토큰도 로그인 API 대신
 * JwtProvider로 직접 발급한다 — 필터가 검증하는 대상은 어차피 토큰 자체다.
 */
public abstract class DomainTestSupport extends IntegrationTest {

    private static final AtomicInteger USER_SEQ = new AtomicInteger();

    @Autowired
    protected UserRepository userRepository;

    @Autowired
    protected VenueRepository venueRepository;

    @Autowired
    protected PerformanceRepository performanceRepository;

    @Autowired
    protected ShowRepository showRepository;

    @Autowired
    protected JwtProvider jwtProvider;

    @Autowired
    private PasswordEncoder passwordEncoder;

    private String sharedHash;

    protected record TestUser(long id, String token) {
    }

    protected record SeededShow(long showId, List<Long> seatIds) {
    }

    protected TestUser newUser() {
        return newUser(Role.USER);
    }

    protected TestUser newAdmin() {
        return newUser(Role.ADMIN);
    }

    private TestUser newUser(Role role) {
        if (sharedHash == null) {
            sharedHash = passwordEncoder.encode("password1234");
        }
        User user = userRepository.save(User.builder()
                .email("domain" + USER_SEQ.getAndIncrement() + "@test.com")
                .passwordHash(sharedHash)
                .role(role)
                .build());
        return new TestUser(user.getId(), jwtProvider.issueAccessToken(user.getId(), role));
    }

    /** 좌석 n개짜리 회차 — 티켓 오픈 시각만 바꿔가며 시나리오를 만든다 */
    protected SeededShow seedShow(int seatCount, Instant ticketOpenAt) {
        return seedShow(seatCount, ticketOpenAt, Instant.now().plus(30, ChronoUnit.DAYS));
    }

    /** startsAt까지 지정하는 변형 — 취소 24시간 규칙 같은 시각 조건 시나리오용 */
    protected SeededShow seedShow(int seatCount, Instant ticketOpenAt, Instant startsAt) {
        Venue venue = venueRepository.save(Venue.builder()
                .name("테스트홀").address("서울").build());
        for (int i = 1; i <= seatCount; i++) {
            jdbc.update("INSERT INTO seats (venue_id, section, row_no, seat_no) VALUES (?, 'A', '1', ?)",
                    venue.getId(), i);
        }
        Performance performance = performanceRepository.save(Performance.builder()
                .title("동시성 실험 공연").venue(venue).build());
        Show show = showRepository.save(Show.builder()
                .performance(performance)
                .startsAt(startsAt)
                .ticketOpenAt(ticketOpenAt)
                .build());
        jdbc.update("""
                INSERT INTO show_seats (show_id, seat_id, price)
                SELECT ?, id, 100000 FROM seats WHERE venue_id = ?
                """, show.getId(), venue.getId());
        List<Long> seatIds = jdbc.queryForList(
                "SELECT id FROM show_seats WHERE show_id = ? ORDER BY id", Long.class, show.getId());
        return new SeededShow(show.getId(), seatIds);
    }

    /** 선점을 강제로 과거-만료 상태로 만든다 — 5분 TTL을 기다리지 않기 위한 시간 조작 */
    protected void expireHolds(long showId) {
        jdbc.update(
                "UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE show_id = ?",
                showId);
    }
}
