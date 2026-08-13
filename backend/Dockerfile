# ── 빌드 스테이지: Gradle로 실행 가능한 부트 JAR 생성
FROM gradle:8.14-jdk17 AS build
WORKDIR /app
# 의존성 레이어 캐시 — 빌드 스크립트만 먼저 복사해 소스 변경 시 재다운로드를 피한다
COPY build.gradle.kts settings.gradle.kts ./
RUN gradle dependencies --no-daemon -q || true
COPY src ./src
RUN gradle bootJar --no-daemon -q

# ── 실행 스테이지: JRE만 포함한 슬림 이미지
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/build/libs/seatlock-*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
