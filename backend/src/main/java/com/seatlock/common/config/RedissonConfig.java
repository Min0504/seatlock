package com.seatlock.common.config;

import org.redisson.Redisson;
import org.redisson.api.RedissonClient;
import org.redisson.config.Config;
import org.springframework.boot.autoconfigure.data.redis.RedisProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * [실험 브랜치 전용] Redisson 클라이언트 설정.
 *
 * 캐시(Lettuce, spring-data-redis)와 별도 커넥션을 쓰는 이유: Redisson의 락 구현은
 * pub/sub 기반 대기(unlock 알림 구독)를 쓰므로 커넥션 사용 패턴이 캐시와 다르다.
 * 접속 정보는 spring.data.redis 프로퍼티를 그대로 재사용해 설정 소스를 하나로 유지한다
 * (Testcontainers의 @DynamicPropertySource 주입도 그대로 통한다).
 */
@Configuration
public class RedissonConfig {

    @Bean(destroyMethod = "shutdown")
    public RedissonClient redissonClient(RedisProperties props) {
        Config config = new Config();
        config.useSingleServer()
                .setAddress("redis://%s:%d".formatted(props.getHost(), props.getPort()))
                // 락은 캐시와 달리 "조용히 실패"하면 안 된다 — 하지만 무한 대기도 안 된다.
                // 짧은 타임아웃으로 끊고, 실패는 호출부에서 도메인 에러로 번역한다.
                .setConnectTimeout(1000)
                .setTimeout(1000)
                .setRetryAttempts(1);
        return Redisson.create(config);
    }
}
