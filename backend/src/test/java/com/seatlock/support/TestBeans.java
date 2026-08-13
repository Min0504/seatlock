package com.seatlock.support;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/**
 * 전 통합 테스트가 공유하는 테스트 빈. 클래스별 오버라이드(@MockBean 등)는 컨텍스트
 * 캐시 키를 갈라 Spring 부팅을 반복시키므로, 공용 대체 빈은 여기 한 곳에 모아
 * 단일 컨텍스트를 유지한다.
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestBeans {

    /** 장애 주입이 필요 없는 테스트에는 평범한 MockPgClient처럼 동작한다 */
    @Bean
    @Primary
    public FaultInjectablePg faultInjectablePg() {
        return new FaultInjectablePg();
    }
}
