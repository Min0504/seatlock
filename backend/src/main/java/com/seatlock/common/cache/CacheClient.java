package com.seatlock.common.cache;

import java.time.Duration;
import java.util.Arrays;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Redis 캐시 접근의 단일 창구 (Nest RedisService.tryExec 포팅).
 *
 * 모든 연산이 예외를 삼킨다 — 캐시는 보조 수단이고 진실은 항상 DB이므로,
 * Redis 순단·타임아웃은 "캐시 없이 DB 직행"(성능 저하)으로 강등될 뿐
 * API 실패로 번지면 안 된다. 좌석 선점·결제의 정합성은 애초에 캐시가 아니라
 * DB 조건부 UPDATE가 지키므로 이 강등은 기능 손실이 없다.
 *
 * {@code CACHE_ENABLED=false}는 부하 비교용이다. Redis를 죽여 측정하면 연결
 * 타임아웃(300ms)이 지연에 섞여 "캐시 없음"이 아니라 "캐시 장애"를 재게 된다.
 */
@Slf4j
@Component
public class CacheClient {

    private final StringRedisTemplate redis;
    private final boolean enabled;

    public CacheClient(
            StringRedisTemplate redis,
            @Value("${seatlock.cache.enabled:true}") boolean enabled) {
        this.redis = redis;
        this.enabled = enabled;
    }

    public Optional<String> tryGet(String label, String key) {
        if (!enabled) {
            return Optional.empty();
        }
        try {
            return Optional.ofNullable(redis.opsForValue().get(key));
        } catch (RuntimeException e) {
            log.warn("{} 실패 — 캐시 없이 진행: {}", label, e.getMessage());
            return Optional.empty();
        }
    }

    public void trySet(String label, String key, String value, Duration ttl) {
        if (!enabled) {
            return;
        }
        try {
            redis.opsForValue().set(key, value, ttl);
        } catch (RuntimeException e) {
            log.warn("{} 실패 — 다음 조회는 DB 직행: {}", label, e.getMessage());
        }
    }

    public void tryDelete(String label, String... keys) {
        if (!enabled || keys.length == 0) {
            return;
        }
        try {
            redis.delete(Arrays.asList(keys));
        } catch (RuntimeException e) {
            // 삭제 유실은 TTL 안전망이 흡수한다 — 최악의 낡음이 TTL을 넘지 않는다
            log.warn("{} 실패 — TTL 만료가 대신 정리한다: {}", label, e.getMessage());
        }
    }

    /**
     * 트랜잭션이 진행 중이면 "커밋 후" 삭제를 예약하고, 아니면 즉시 삭제한다.
     *
     * 순서가 중요한 이유: 트랜잭션 안에서 지우면 ① 롤백된 변경 때문에 캐시만 날리거나
     * ② 삭제→커밋 사이의 다른 조회가 아직-옛-상태인 DB를 읽어 낡은 값을 다시 심는다.
     * 커밋 뒤에 지우면 그 창이 사라진다 (남는 건 조회가 read-modify-set 하는 짧은 창뿐,
     * 그건 TTL이 상한을 보장).
     */
    public void deleteAfterCommit(String label, String... keys) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            tryDelete(label, keys);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                tryDelete(label, keys);
            }
        });
    }
}
