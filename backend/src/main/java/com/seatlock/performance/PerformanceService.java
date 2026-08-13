package com.seatlock.performance;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.seatlock.common.error.DomainException;
import com.seatlock.common.error.ErrorCode;
import com.seatlock.performance.dto.PerformanceDtos.CreatePerformanceRequest;
import com.seatlock.performance.dto.PerformanceDtos.CreateShowRequest;
import com.seatlock.performance.dto.PerformanceDtos.CreateVenueRequest;
import com.seatlock.performance.dto.PerformanceDtos.CreateVenueResponse;
import com.seatlock.performance.dto.PerformanceDtos.CreatedResponse;
import com.seatlock.performance.dto.PerformanceDtos.DetailResponse;
import com.seatlock.performance.dto.PerformanceDtos.ListItem;
import com.seatlock.performance.dto.PerformanceDtos.ListResponse;
import com.seatlock.performance.dto.PerformanceDtos.ShowSummary;
import com.seatlock.performance.dto.PerformanceDtos.VenueSummary;
import com.seatlock.show.Show;
import com.seatlock.show.ShowRepository;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.BatchPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class PerformanceService {

    /** 예매 오픈 안내가 한국 기준 날짜로 소통되므로 date 필터의 하루 경계도 KST로 고정한다 */
    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    private static final int DEFAULT_SIZE = 20;

    private final VenueRepository venueRepository;
    private final PerformanceRepository performanceRepository;
    private final ShowRepository showRepository;
    private final JdbcTemplate jdbcTemplate;
    private final PerformanceListCache listCache;
    private final ObjectMapper objectMapper;

    @Transactional
    public CreateVenueResponse createVenue(CreateVenueRequest request) {
        Venue venue = venueRepository.save(Venue.builder()
                .name(request.name())
                .address(request.address())
                .build());

        // 좌석 수천 행은 saveAll(N회 INSERT)이 아니라 JDBC 배치 한 번으로 적재한다.
        // IDENTITY 전략에서는 Hibernate가 INSERT 배칭을 못 하기 때문(생성 키를 즉시
        // 받아야 해서) — Prisma createMany와 같은 효과를 JPA 밖에서 얻는 선택.
        var seats = request.seats();
        jdbcTemplate.batchUpdate(
                "INSERT INTO seats (venue_id, section, row_no, seat_no) VALUES (?, ?, ?, ?)",
                new BatchPreparedStatementSetter() {
                    @Override
                    public void setValues(PreparedStatement ps, int i) throws SQLException {
                        ps.setLong(1, venue.getId());
                        ps.setString(2, seats.get(i).section());
                        ps.setString(3, seats.get(i).rowNo());
                        ps.setInt(4, seats.get(i).seatNo());
                    }

                    @Override
                    public int getBatchSize() {
                        return seats.size();
                    }
                });
        return new CreateVenueResponse(venue.getId(), seats.size());
    }

    @Transactional
    public CreatedResponse createPerformance(CreatePerformanceRequest request) {
        Venue venue = venueRepository.findById(request.venueId())
                .orElseThrow(() -> new DomainException(ErrorCode.VENUE_NOT_FOUND));
        Performance performance = performanceRepository.save(Performance.builder()
                .title(request.title())
                .description(request.description())
                .venue(venue)
                .build());
        // 등록 직후 목록에 보여야 한다 — 커밋 후 첫 페이지 캐시를 지운다
        listCache.invalidate();
        return new CreatedResponse(performance.getId());
    }

    @Transactional
    public CreatedResponse createShow(CreateShowRequest request) {
        Performance performance = performanceRepository.findById(request.performanceId())
                .orElseThrow(() -> new DomainException(ErrorCode.PERFORMANCE_NOT_FOUND));
        Show show = showRepository.save(Show.builder()
                .performance(performance)
                .startsAt(request.startsAt())
                .ticketOpenAt(request.ticketOpenAt())
                .build());
        return new CreatedResponse(show.getId());
    }

    public ListResponse list(String q, LocalDate date, Long cursor, Integer size) {
        int limit = size != null ? size : DEFAULT_SIZE;

        // 캐시는 "필터 없는 첫 페이지"만 — 메인 진입 시 전원이 때리는 유일한 핫스팟이다.
        // 검색어·날짜·커서 조합까지 캐시하면 키 수가 폭발하는데 히트율은 바닥이라 실익이 없다.
        boolean cacheable = q == null && date == null && cursor == null && limit == DEFAULT_SIZE;
        if (cacheable) {
            Optional<String> cached = listCache.get();
            if (cached.isPresent()) {
                try {
                    return objectMapper.readValue(cached.get(), ListResponse.class);
                } catch (JsonProcessingException e) {
                    log.warn("공연 목록 캐시 역직렬화 실패 — DB로 폴백: {}", e.getMessage());
                }
            }
        }

        Instant dayStart = date != null ? date.atStartOfDay(KST).toInstant() : null;
        Instant dayEnd = date != null ? date.plusDays(1).atStartOfDay(KST).toInstant() : null;

        var rows = performanceRepository.search(escapeLike(q), cursor, dayStart, dayEnd, limit + 1);
        boolean hasNext = rows.size() > limit;
        List<ListItem> items = (hasNext ? rows.subList(0, limit) : rows).stream()
                .map(r -> new ListItem(r.getId(), r.getTitle(), r.getPosterUrl(), r.getVenueName()))
                .toList();
        ListResponse response =
                new ListResponse(items, hasNext ? String.valueOf(items.get(items.size() - 1).id()) : null);
        if (cacheable) {
            try {
                listCache.set(objectMapper.writeValueAsString(response));
            } catch (JsonProcessingException e) {
                log.warn("공연 목록 캐시 직렬화 실패 — 이번 응답은 캐시 없이 반환: {}", e.getMessage());
            }
        }
        return response;
    }

    @Transactional(readOnly = true)
    public DetailResponse detail(Long id) {
        Performance p = performanceRepository.findDetailById(id)
                .orElseThrow(() -> new DomainException(ErrorCode.PERFORMANCE_NOT_FOUND));
        return new DetailResponse(
                p.getId(),
                p.getTitle(),
                p.getDescription(),
                p.getPosterUrl(),
                new VenueSummary(p.getVenue().getId(), p.getVenue().getName(), p.getVenue().getAddress()),
                p.getShows().stream()
                        .map(s -> new ShowSummary(s.getId(), s.getStartsAt(), s.getTicketOpenAt()))
                        .toList());
    }

    /**
     * 검색어의 LIKE 메타문자(%, _)를 무력화한다 — 바인딩으로 Injection은 막혀도
     * "%%"처럼 패턴 자체를 조작해 전체를 긁는 것은 별개 문제다. (Prisma contains는
     * 자동으로 해 주던 일이라 포팅 시 빠뜨리기 쉬운 지점)
     */
    private static String escapeLike(String q) {
        if (q == null || q.isBlank()) {
            return null;
        }
        return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }
}
