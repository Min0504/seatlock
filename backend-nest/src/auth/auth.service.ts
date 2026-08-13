import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { JwtAccessPayload, JwtRefreshPayload } from './jwt-payloads';

// cost 12: 2026년 기준 해싱 1회 ~250ms 수준 — 온라인 로그인 UX를 해치지 않으면서
// 오프라인 무차별 대입 비용을 충분히 올리는 업계 권장 균형점.
const BCRYPT_COST = 12;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  // 존재하지 않는 이메일로 로그인 시도할 때도 bcrypt 비교를 수행하기 위한 더미 해시.
  // 이메일 존재 여부에 따라 응답 시간이 달라지면(타이밍 공격) 계정 존재가 노출된다.
  private readonly dummyHash: string = bcrypt.hashSync('timing-attack-guard', BCRYPT_COST);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async signup(email: string, password: string): Promise<{ id: bigint; email: string }> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash, role: Role.USER },
      });
      return { id: user.id, email: user.email };
    } catch (e) {
      // 이메일 중복은 UNIQUE 제약(P2002)으로 판정한다.
      // 사전 조회(check-then-act)는 동시 가입 요청 사이에 뚫릴 수 있기 때문.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.emailExists();
      }
      throw e;
    }
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const hash = user?.passwordHash ?? this.dummyHash;
    const matches = await bcrypt.compare(password, hash);
    if (!user || !matches) {
      // 이메일/비밀번호 중 무엇이 틀렸는지 구분해 주지 않는다 — 계정 열거 방지
      throw Errors.invalidCredentials();
    }
    return this.issueTokens(user);
  }

  /**
   * v1: 서명 검증만으로 새 토큰 쌍을 재발급하는 stateless refresh.
   * 탈취된 refresh 토큰의 재사용을 서버가 감지할 수 없다는 한계가 있으며,
   * v2에서 rotation + 재사용 탐지(family 폐기)로 고도화한다.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: JwtRefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtRefreshPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw Errors.unauthorized();
    }
    if (payload.type !== 'refresh') {
      throw Errors.unauthorized();
    }
    const user = await this.prisma.user.findUnique({ where: { id: BigInt(payload.sub) } });
    if (!user) {
      throw Errors.unauthorized();
    }
    return this.issueTokens(user);
  }

  private async issueTokens(user: User): Promise<TokenPair> {
    const accessPayload: JwtAccessPayload = { sub: user.id.toString(), role: user.role };
    const refreshPayload: JwtRefreshPayload = { sub: user.id.toString(), type: 'refresh' };

    // TTL은 초 단위 숫자로 관리한다 — "15m" 같은 문자열 포맷은 파서 구현마다
    // 해석이 갈릴 수 있어 설정 오류를 만들기 쉽다 (기본: access 15분, refresh 14일)
    const accessTtlSec = Number(this.config.get<string>('JWT_ACCESS_TTL_SEC') ?? 900);
    const refreshTtlSec = Number(this.config.get<string>('JWT_REFRESH_TTL_SEC') ?? 1209600);

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessTtlSec,
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshTtlSec,
      }),
    ]);
    return { accessToken, refreshToken };
  }
}
