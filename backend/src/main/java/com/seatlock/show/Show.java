package com.seatlock.show;

import com.seatlock.performance.Performance;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.Instant;
import lombok.AccessLevel;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "shows")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Show {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "performance_id", nullable = false)
    private Performance performance;

    @Column(name = "starts_at", nullable = false)
    private Instant startsAt;

    @Column(name = "ticket_open_at", nullable = false)
    private Instant ticketOpenAt;

    @Builder
    private Show(Performance performance, Instant startsAt, Instant ticketOpenAt) {
        this.performance = performance;
        this.startsAt = startsAt;
        this.ticketOpenAt = ticketOpenAt;
    }
}
