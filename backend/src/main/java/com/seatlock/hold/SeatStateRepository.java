package com.seatlock.hold;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 좌석 상태 전이 전담 저장소 — 전부 조건부 UPDATE다 (기획서 §7 문제 1·2).
 *
 * JPA 변경 감지(엔티티 읽기 → setStatus → flush)를 쓰지 않는 이유: 두 트랜잭션이
 * 같은 AVAILABLE 행을 읽는 틈이 생긴다(check-then-act race). WHERE 절이 곧 판정인
 * UPDATE 한 문장은 PostgreSQL(READ COMMITTED)이 행 잠금 후 조건을 재평가하므로
 * 경쟁 패자는 갱신 0건으로 즉시 실패한다 — 락 대기 없음, 코드 단순.
 * 비관적(@Lock)·낙관적(@Version) 락과의 비교는 experiment/* 브랜치와
 * docs/lock-benchmark.md에서 다룬다.
 *
 * JdbcTemplate을 쓰는 이유: JPQL @Modifying은 RETURNING을 못 받고(실패 좌석 식별,
 * 해제 좌석 수 필요), 영속성 컨텍스트를 우회하는 벌크 UPDATE는 1차 캐시와 어긋날
 * 수 있다 — 이 클래스는 처음부터 엔티티를 만들지 않는 것으로 그 문제를 제거한다.
 * (스프링 트랜잭션 동기화로 JPA와 같은 커넥션을 쓰므로 원자성은 유지된다)
 */
@Repository
@RequiredArgsConstructor
public class SeatStateRepository {

    private final NamedParameterJdbcTemplate jdbc;

    /**
     * 선점 시도 — 이긴 좌석 id 목록을 돌려준다(요청 수보다 적으면 호출자가 롤백).
     *
     * 선점 가능 조건 두 가지:
     *   ① AVAILABLE — 평범한 빈 좌석
     *   ② HELD인데 만료시각이 지난 좌석 — 스위퍼(30초 주기)가 아직 회수하지 않았어도
     *      요청 시점에 만료로 판정해 즉시 넘겨받는다(3중 방어의 lazy 판정 층).
     *
     * 만료 판정 시계는 DB의 now()다 — 기록(hold_expires_at)과 판정이 같은 시계를
     * 쓰면 앱 서버가 여러 대여도 기준이 하나로 유지된다.
     */
    public List<Long> acquire(long showId, List<Long> seatIds, long userId, UUID holdGroupId, Instant expiresAt) {
        return jdbc.queryForList("""
                UPDATE show_seats
                   SET status = 'HELD', hold_user_id = :userId,
                       hold_group_id = :groupId, hold_expires_at = :expiresAt
                 WHERE id IN (:seatIds) AND show_id = :showId
                   AND (status = 'AVAILABLE'
                        OR (status = 'HELD' AND hold_expires_at <= now()))
                 RETURNING id
                """,
                new MapSqlParameterSource()
                        .addValue("userId", userId)
                        .addValue("groupId", holdGroupId)
                        .addValue("expiresAt", Timestamp.from(expiresAt))
                        .addValue("seatIds", seatIds)
                        .addValue("showId", showId),
                Long.class);
    }

    /** 선점 해제 — 본인 소유의 HELD만 원복한다. 조건부라 중복 호출·만료 후 호출에도 안전. */
    public List<Long> releaseByGroup(UUID holdGroupId, long userId) {
        return jdbc.queryForList("""
                UPDATE show_seats
                   SET status = 'AVAILABLE', hold_user_id = NULL,
                       hold_group_id = NULL, hold_expires_at = NULL
                 WHERE hold_group_id = :groupId AND hold_user_id = :userId AND status = 'HELD'
                 RETURNING id
                """,
                new MapSqlParameterSource()
                        .addValue("groupId", holdGroupId)
                        .addValue("userId", userId),
                Long.class);
    }

    /**
     * 만료 선점 일괄 회수 (스위퍼용). 멱등이라 서버 여러 대가 동시에 돌려도 안전하다 —
     * 두 번째 실행은 0건 갱신. WHERE는 부분 인덱스(show_seats_expired_hold_scan_idx,
     * status='HELD'인 행만 수록)를 탄다.
     */
    public int reclaimExpired() {
        return jdbc.update("""
                UPDATE show_seats
                   SET status = 'AVAILABLE', hold_user_id = NULL,
                       hold_group_id = NULL, hold_expires_at = NULL
                 WHERE status = 'HELD' AND hold_expires_at < now()
                """, new MapSqlParameterSource());
    }
}
