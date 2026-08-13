package com.seatlock.performance;

import com.seatlock.show.Show;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import lombok.AccessLevel;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.CreationTimestamp;

@Entity
@Table(name = "performances")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Performance {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 200)
    private String title;

    @Column(columnDefinition = "text")
    private String description;

    @Column(name = "poster_url", length = 500)
    private String posterUrl;

    // 검색 전용 결합 컬럼(title + description) — GIN(gin_trgm_ops) 인덱스 대상.
    // 인덱스는 Flyway 베이스라인에 있다: performances_search_text_trgm_idx
    @Column(name = "search_text", nullable = false, columnDefinition = "text")
    private String searchText;

    // 모든 연관은 LAZY가 기본값이다 — EAGER는 "항상 조인"을 강제해 개별 쿼리 튜닝을
    // 불가능하게 만든다. 필요한 조회가 fetch join으로 명시적으로 가져간다 (N+1 대응).
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "venue_id", nullable = false)
    private Venue venue;

    // 상세 화면의 fetch join 대상 — 소유자는 Show.performance(FK 보유 측)이고
    // 이 컬렉션은 읽기 전용 미러다(mappedBy).
    @OneToMany(mappedBy = "performance")
    private List<Show> shows = new ArrayList<>();

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Builder
    private Performance(String title, String description, Venue venue) {
        this.title = title;
        this.description = description;
        this.venue = venue;
        // 제목/설명(출연진)을 한 컬럼에 모아 GIN 인덱스 하나로 검색 (Nest 구현과 동일 규칙)
        this.searchText = description == null || description.isBlank()
                ? title
                : title + " " + description;
    }
}
