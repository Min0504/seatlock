package com.seatlock.common.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 스케줄러 활성화를 본체(@SpringBootApplication)가 아닌 별도 설정으로 분리 —
 * 통합 테스트에서 슬라이스만 띄우거나 스케줄링을 끌 때 조립 지점이 명확해진다.
 */
@Configuration
@EnableScheduling
public class SchedulingConfig {
}
