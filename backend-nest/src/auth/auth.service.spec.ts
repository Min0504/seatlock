import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { DomainException } from '../common/errors/domain.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  const prismaMock = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    // 토큰 발급은 rotation 상태 행을 남긴다 — 단위 테스트의 관심사가 아니므로 항상 성공 처리
    prismaMock.refreshToken.create.mockResolvedValue({});
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: JwtService, useValue: new JwtService({}) },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_ACCESS_SECRET: 'test-access-secret',
            JWT_REFRESH_SECRET: 'test-refresh-secret',
          }),
        },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('회원가입 시 비밀번호는 bcrypt 해시로 저장된다 (원문 저장 금지)', async () => {
    prismaMock.user.create.mockImplementation(({ data }: { data: { passwordHash: string } }) =>
      Promise.resolve({ id: 1n, email: 'a@b.com', passwordHash: data.passwordHash }),
    );

    await service.signup('a@b.com', 'password1234');

    const saved = prismaMock.user.create.mock.calls[0][0].data;
    expect(saved.passwordHash).not.toBe('password1234');
    expect(await bcrypt.compare('password1234', saved.passwordHash)).toBe(true);
  });

  it('이메일 중복(P2002)은 409 EMAIL_EXISTS로 변환된다', async () => {
    prismaMock.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.signup('a@b.com', 'password1234')).rejects.toMatchObject({
      code: 'EMAIL_EXISTS',
    });
  });

  it('존재하지 않는 이메일도 비밀번호 불일치와 같은 401을 반환한다 (계정 열거 방지)', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const error = await service.login('ghost@b.com', 'whatever').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe('INVALID_CREDENTIALS');
  });

  it('로그인 성공 시 access/refresh 토큰 쌍을 발급한다', async () => {
    const passwordHash = await bcrypt.hash('password1234', 4);
    prismaMock.user.findUnique.mockResolvedValue({
      id: 1n,
      email: 'a@b.com',
      passwordHash,
      role: Role.USER,
    });

    const tokens = await service.login('a@b.com', 'password1234');
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.accessToken).not.toBe(tokens.refreshToken);
  });

  it('access 토큰으로는 refresh 할 수 없다 (type 클레임 검증)', async () => {
    const passwordHash = await bcrypt.hash('password1234', 4);
    prismaMock.user.findUnique.mockResolvedValue({
      id: 1n,
      email: 'a@b.com',
      passwordHash,
      role: Role.USER,
    });
    const { accessToken } = await service.login('a@b.com', 'password1234');

    await expect(service.refresh(accessToken)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('소모된(used) 토큰이 재사용되면 그 family 전체를 폐기한다', async () => {
    const passwordHash = await bcrypt.hash('password1234', 4);
    prismaMock.user.findUnique.mockResolvedValue({
      id: 1n,
      email: 'a@b.com',
      passwordHash,
      role: Role.USER,
    });
    const { refreshToken } = await service.login('a@b.com', 'password1234');

    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 10n,
      userId: 1n,
      familyId: 'stolen-family',
      used: true,
      revoked: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    await expect(service.refresh(refreshToken)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'stolen-family', revoked: false },
      data: { revoked: true },
    });
  });
});
