package com.seatlock.show;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.performance.Seat;
import com.seatlock.performance.SeatRepository;
import com.seatlock.show.dto.ShowDtos.CreateSeatsResponse;
import com.seatlock.show.dto.ShowDtos.CreateShowSeatsRequest;
import com.seatlock.show.dto.ShowDtos.SeatMapEntry;
import com.seatlock.show.dto.ShowDtos.SeatMapResponse;
import com.seatlock.show.dto.ShowDtos.SectionPrice;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.BatchPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class ShowService {

    private final ShowRepository showRepository;
    private final ShowSeatRepository showSeatRepository;
    private final SeatRepository seatRepository;
    private final JdbcTemplate jdbcTemplate;
    private final SeatMapCache seatMapCache;
    private final ObjectMapper objectMapper;

    /**
     * 공연장 좌석 템플릿 → 회차 좌석 인스턴스 일괄 생성 (Nest ShowsService 포팅).
     * 수천 행이므로 JDBC 배치 1회로 적재한다 — IDENTITY 전략에서 Hibernate는
     * INSERT 배칭이 불가능해 saveAll이 N회 왕복이 되기 때문.
     */
    @Transactional
    public CreateSeatsResponse createShowSeats(Long showId, CreateShowSeatsRequest request) {
        Show show = showRepository.findById(showId)
                .orElseThrow(() -> new DomainException(ErrorCode.SHOW_NOT_FOUND));
        // 재생성 시 배치 중간의 UNIQUE 위반보다 명확한 409를 먼저 준다.
        // (동시 요청의 최종 방어선은 여전히 UNIQUE(show_id, seat_id) — 아래 catch)
        if (showSeatRepository.existsByShowId(showId)) {
            throw new DomainException(ErrorCode.SEATS_ALREADY_CREATED);
        }

        Map<String, Integer> priceBySection = request.prices().stream()
                .collect(Collectors.toMap(SectionPrice::section, SectionPrice::price));
        // 프록시의 @Id 접근은 초기화를 유발하지 않지만, venue id는 Performance를 거쳐야
        // 하므로 한 단계 로딩이 필요하다 — 관리자 1회성 작업이라 추가 SELECT를 수용한다
        Long venueId = show.getPerformance().getVenue().getId();
        List<Seat> templates = seatRepository.findByVenueIdAndSectionIn(venueId, priceBySection.keySet());
        if (templates.isEmpty()) {
            throw new DomainException(ErrorCode.SEAT_NOT_FOUND);
        }

        try {
            // status는 스키마 기본값('AVAILABLE')에 맡긴다 — 도메인 시작 상태의 정의를
            // 앱과 DB 두 곳에 중복 기술하지 않는다
            jdbcTemplate.batchUpdate(
                    "INSERT INTO show_seats (show_id, seat_id, price) VALUES (?, ?, ?)",
                    new BatchPreparedStatementSetter() {
                        @Override
                        public void setValues(PreparedStatement ps, int i) throws SQLException {
                            Seat seat = templates.get(i);
                            ps.setLong(1, show.getId());
                            ps.setLong(2, seat.getId());
                            // findByVenueIdAndSectionIn의 구역 조건과 같은 맵이므로 반드시 존재한다
                            ps.setInt(3, priceBySection.get(seat.getSection()));
                        }

                        @Override
                        public int getBatchSize() {
                            return templates.size();
                        }
                    });
        } catch (DataIntegrityViolationException e) {
            // UNIQUE(show_id, seat_id) 위반 = 동시 재생성 경합 — 스키마가 차단
            throw new DomainException(ErrorCode.SEATS_ALREADY_CREATED);
        }
        return new CreateSeatsResponse(templates.size());
    }

    /**
     * 좌석맵 조회 — 오픈 순간 조회가 폭주하는 이 시스템의 읽기 병목 지점.
     * 캐시 히트 시 DB를 전혀 만지지 않고(그래서 @Transactional을 걸지 않는다 —
     * 히트 경로가 커넥션을 잡으면 캐시의 의미가 반감된다), 미스 시 DB에서 만들어
     * 5초 TTL로 심는다. 무효화는 좌석 상태를 바꾸는 쪽(선점·해제·결제 확정·취소·
     * 만료 회수)의 책임이다.
     */
    public SeatMapResponse getSeatMap(Long showId) {
        Optional<String> cached = seatMapCache.get(showId);
        if (cached.isPresent()) {
            try {
                return objectMapper.readValue(cached.get(), SeatMapResponse.class);
            } catch (JsonProcessingException e) {
                // 손상된 캐시는 무시하고 DB에서 다시 만든다 — 아래 set이 덮어쓴다
                log.warn("좌석맵 캐시 역직렬화 실패 — DB로 폴백: {}", e.getMessage());
            }
        }

        if (!showRepository.existsById(showId)) {
            throw new DomainException(ErrorCode.SHOW_NOT_FOUND);
        }
        Instant now = Instant.now();
        List<SeatMapEntry> seats = showSeatRepository.findSeatMapByShowId(showId).stream()
                .map(ss -> new SeatMapEntry(
                        ss.getId(),
                        ss.getSeat().getSection(),
                        ss.getSeat().getRowNo(),
                        ss.getSeat().getSeatNo(),
                        ss.getPrice(),
                        ss.displayStatus(now)))
                .toList();
        SeatMapResponse response = new SeatMapResponse(showId, seats);
        try {
            // 존재하는 회차만 캐시된다 — 404는 위에서 던져져 미스 경로가 캐시를 오염시키지 않는다
            seatMapCache.set(showId, objectMapper.writeValueAsString(response));
        } catch (JsonProcessingException e) {
            log.warn("좌석맵 캐시 직렬화 실패 — 이번 응답은 캐시 없이 반환: {}", e.getMessage());
        }
        return response;
    }
}
