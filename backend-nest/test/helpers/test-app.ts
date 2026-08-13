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

  return { app, container };
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
