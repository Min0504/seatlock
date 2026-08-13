package com.seatlock.performance;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * 공연장의 물리 좌석 템플릿. 회차별 판매 단위는 show_seats가 따로 가진다.
 * 쓰기는 공연장 등록 시의 bulk insert(JdbcTemplate) 한 번뿐이라
 * 엔티티는 조회 매핑 용도로만 존재한다.
 */
@Entity
@Table(name = "seats", uniqueConstraints = {
        // 같은 공연장에 같은 좌표의 좌석이 중복 생성되는 것을 스키마 수준에서 차단
        @UniqueConstraint(columnNames = {"venue_id", "section", "row_no", "seat_no"})
})
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Seat {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "venue_id", nullable = false)
    private Long venueId;

    @Column(nullable = false, length = 20)
    private String section;

    @Column(name = "row_no", nullable = false, length = 10)
    private String rowNo;

    @Column(name = "seat_no", nullable = false)
    private int seatNo;
}
