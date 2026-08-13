import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
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

/** 토큰 원문 대신 저장·조회에 쓰는 지문 — DB가 유출돼도 토큰을 복원할 수 없다 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
   * Refresh Token Rotation (기획서 §7 문제 4).
   *
   * refresh 1회 = 토큰 쌍 교체. 이전 토큰은 그 자리에서 소모(used)되고, 소모된
   * 토큰이 다시 오면 "정상 사용자와 탈취범 둘 다 썼다"는 유일한 해석만 남으므로
   * family 전체를 폐기해 양쪽 모두 재로그인시킨다. 완전 stateless JWT는 이 탐지가
   * 원리적으로 불가능하다 — 서명은 "누가 이미 썼는가"를 모른다.
   *
   * 모든 실패는 동일한 401이다. 실패 사유(위조/만료/재사용 탐지)를 구분해 주면
   * 공격자에게 탐지 시스템의 동작을 알려주는 오라클이 된다.
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

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    // 서명은 유효한데 기록이 없다 = rotation 도입 전 토큰이거나 정리된 만료 행 — 재로그인
    if (!stored || stored.revoked || stored.expiresAt.getTime() <= Date.now()) {
      throw Errors.unauthorized();
    }

    if (stored.used) {
      // 재사용 탐지 — 이 토큰은 이미 rotation으로 소모됐다. 지금 이 요청과 과거의
      // 정상 갱신, 둘 중 하나는 반드시 탈취범이다. 누가 도둑인지 알 수 없으므로
      // family의 모든 토큰을 폐기해 도둑이 이어받은 세션까지 끊는다.
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revoked: false },
        data: { revoked: true },
      });
      this.logger.warn(
        `refresh 토큰 재사용 탐지 — user=${stored.userId} family=${stored.familyId} 전체 폐기`,
      );
      throw Errors.unauthorized();
    }

    // 소모 처리를 조건부 UPDATE로 원자화 — 같은 토큰의 동시 refresh(두 탭 경합)에서
    // 정확히 한 요청만 이 관문을 통과한다. 패자는 새 쌍 없이 401로 끝나며(이중 발급
    // 금지), 프론트는 refresh 호출을 단일화(single-flight)해 경합 자체를 줄인다.
    const consumed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, used: false },
      data: { used: true },
    });
    if (consumed.count !== 1) {
      throw Errors.unauthorized();
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) {
      throw Errors.unauthorized();
    }
    // 새 토큰은 같은 family를 잇는다 — 로그인부터 이어지는 rotation 사슬의 식별자
    return this.issueTokens(user, stored.familyId);
  }

  /**
   * 로그아웃 — 제출된 refresh 토큰이 속한 family를 폐기한다.
   * 본인 소유 토큰만 유효하며, 이미 폐기됐거나 모르는 토큰이어도 같은 결과(204)로
   * 끝난다(멱등). access 토큰은 stateless라 만료(15분)까지 유효한데, 이를 즉시
   * 죽이려면 모든 요청에 블랙리스트 조회가 붙는다 — 15분 노출을 받아들이는 것이
   * 이 설계의 트레이드오프다.
   */
  async logout(userId: bigint, refreshToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!stored || stored.userId !== userId) {
      return;
    }
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revoked: false },
      data: { revoked: true },
    });
  }

  private async issueTokens(user: User, familyId?: string): Promise<TokenPair> {
    const accessPayload: JwtAccessPayload = { sub: user.id.toString(), role: user.role };
    const refreshPayload: JwtRefreshPayload = {
      sub: user.id.toString(),
      type: 'refresh',
      jti: randomUUID(),
    };

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

    // 로그인(familyId 없음)은 새 family를 연다 — 기기마다 독립된 rotation 사슬을
    // 가져야 한 기기의 탈취·폐기가 다른 기기의 세션을 죽이지 않는다.
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId: familyId ?? randomUUID(),
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtlSec * 1000),
      },
    });

    return { accessToken, refreshToken };
  }
}
