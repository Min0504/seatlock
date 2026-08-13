import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

export interface TestContext {
  app: INestApplication;
  container: StartedPostgreSqlContainer;
  /** 동시성 테스트용 실제 리슨 주소 — supertest는 병렬 요청에서 불안정해 fetch를 쓴다 */
  baseUrl: string;
}

/**
 * e2e 테스트 환경 구성:
 * 1) Testcontainers로 실제 PostgreSQL 16 기동 — 조건부 UPDATE·유니크 제약처럼
 *    DB 엔진의 실제 동작이 검증 대상이므로 인메모리 대체재를 쓰지 않는다.
 * 2) prisma migrate deploy로 운영과 동일한 마이그레이션 적용
 * 3) 실제 서비스와 동일한 전역 설정(configureApp)으로 Nest 앱 기동
 */
export async function createTestApp(): Promise<TestContext> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  process.env.DATABASE_URL = container.getConnectionUri();
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

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  return { app, container, baseUrl };
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
