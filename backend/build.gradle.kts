plugins {
    java
    // 기획서 §3: Spring Boot 3.x + Java 17 — 국내 채용 시장의 LTS 표준 조합.
    // (Boot 4가 출시돼 있지만 기획서가 3.x를 명시했고, 3.5는 3.x의 최종 안정 라인)
    id("org.springframework.boot") version "3.5.16"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.seatlock"
version = "0.0.1-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

configurations {
    compileOnly {
        extendsFrom(configurations.annotationProcessor.get())
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    // 좌석맵·목록·통계 캐시 (기획서 §9). 클라이언트는 기본 Lettuce.
    implementation("org.springframework.boot:spring-boot-starter-data-redis")

    // 스키마는 Flyway가 소유한다(V1 = Prisma 마이그레이션 스냅샷). JPA는 validate만.
    implementation("org.flywaydb:flyway-core")
    implementation("org.flywaydb:flyway-database-postgresql")
    runtimeOnly("org.postgresql:postgresql")

    // JWT — Nest 구현과 동일한 HS256 대칭키 서명을 유지한다 (포팅 원칙: 계약 불변)
    implementation("io.jsonwebtoken:jjwt-api:0.13.0")
    runtimeOnly("io.jsonwebtoken:jjwt-impl:0.13.0")
    runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.13.0")

    // OpenAPI — Nest의 Swagger(/docs)와 동일한 경로로 문서를 제공한다
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.8.17")

    compileOnly("org.projectlombok:lombok")
    annotationProcessor("org.projectlombok:lombok")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    // 통합 테스트는 실제 PostgreSQL 16으로 — 조건부 UPDATE·부분 유니크 인덱스처럼
    // 엔진의 실제 동작이 검증 대상이므로 H2 같은 인메모리 대체재를 쓰지 않는다 (기획서 §11)
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:postgresql")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
    useJUnitPlatform()
}
