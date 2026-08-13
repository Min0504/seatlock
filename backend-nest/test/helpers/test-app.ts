import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

export interface TestContext {
  app: INestApplication;
  container: StartedPostgreSqlContainer;
  /** redis: false 옵션으로 기동한 경우 null */
  redis: StartedRedisContainer | null;
  /** 동시성 테스트용 실제 리슨 주소 — supertest는 병렬 요청에서 불안정해 fetch를 쓴다 */
  baseUrl: string;
}

export interface TestAppOptions {
  /** false면 접속 불가능한 Redis 주소로 기동 — "Redis가 죽어도 서비스는 산다" 검증용 */
  redis?: boolean;
  /** DI 프로바이더 교체 — mock PG의 타임아웃처럼 실물로 못 만드는 장애를 주입할 때 쓴다 */
  overrideProviders?: Array<{ provide: unknown; useValue: unknown }>;
}

/**
 * e2e 테스트 환경 구성:
 * 1) Testcontainers로 실제 PostgreSQL 16 + Redis 7 기동 — 조건부 UPDATE·유니크 제약·
 *    keyspace 알림처럼 엔진의 실제 동작이 검증 대상이므로 인메모리 대체재를 쓰지 않는다.
 * 2) prisma migrate deploy로 운영과 동일한 마이그레이션 적용
 * 3) 실제 서비스와 동일한 전역 설정(configureApp)으로 Nest 앱 기동
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
  const withRedis = options.redis !== false;
  const [container, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    withRedis
      ? new RedisContainer('redis:7-alpine')
          // 선점 TTL 만료 알림(expired 이벤트) 수신에 필요 — docker-compose.dev.yml과 동일 설정
          .withCommand(['redis-server', '--notify-keyspace-events', 'Ex'])
          .start()
      : Promise.resolve(null),
  ]);

  process.env.DATABASE_URL = container.getConnectionUri();
  // redis:false는 즉시 connection refused가 나는 주소를 준다(외부 네트워크 의존 없이 다운 상황 재현)
  process.env.REDIS_URL = redis ? redis.getConnectionUrl() : 'redis://127.0.0.1:1';
  process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret-32bytes!!!!!';
  process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret-32bytes!!!!';

  const backendRoot = path.resolve(__dirname, '..', '..');
  execSync('npx prisma migrate deploy', {
    cwd: backendRoot,
    env: { ...process.env },
    stdio: 'pipe',
  });

  // 환경변수 세팅 이후에 모듈을 로드해야 ConfigModule이 올바른 값을 읽는다
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/app.setup');

  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const override of options.overrideProviders ?? []) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  return { app, container, redis, baseUrl };
}

/** 앱과 컨테이너를 역순으로 정리한다 — afterAll 한 줄로 쓰기 위한 헬퍼 */
export async function teardownTestApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  // 테스트가 이미 컨테이너를 내렸을 수 있다(Redis 다운 시나리오) — 중복 stop 오류는 무시
  await Promise.allSettled([ctx.container.stop(), ctx.redis?.stop()]);
}

/** 관리자 계정은 가입 API로 만들 수 없으므로(권한 상승 차단) 테스트에서 직접 심는다 */
export async function seedAdmin(
  app: INestApplication,
  email = 'admin@seatlock.test',
  password = 'admin-password-1234',
): Promise<{ email: string; password: string }> {
  const { PrismaService } = await import('../../src/common/prisma/prisma.service');
  const prisma = app.get(PrismaService);
  await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 4), role: Role.ADMIN },
  });
  return { email, password };
}

/**
 * 동시성 테스트용 사용자 대량 생성.
 * 가입 API를 N번 호출하면 bcrypt(cost 12) 해싱만 N×수백ms가 걸리므로,
 * 동일 해시(cost 4)를 한 번만 계산해 createMany로 심는다 — 검증 대상은
 * 선점 로직이지 가입 성능이 아니다.
 */
export async function seedUsers(
  app: INestApplication,
  count: number,
): Promise<Array<{ email: string; password: string }>> {
  const { PrismaService } = await import('../../src/common/prisma/prisma.service');
  const prisma = app.get(PrismaService);
  const password = 'password1234';
  const passwordHash = await bcrypt.hash(password, 4);
  const users = Array.from({ length: count }, (_, i) => ({
    email: `racer${i}@test.com`,
    passwordHash,
    role: Role.USER,
  }));
  await prisma.user.createMany({ data: users });
  return users.map((u) => ({ email: u.email, password }));
}
