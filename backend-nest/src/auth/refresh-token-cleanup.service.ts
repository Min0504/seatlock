import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * refresh_tokens 만료 행 정리 배치 (기획서 §7 문제 4 트레이드오프).
 *
 * Rotation은 refresh마다 행을 하나씩 남기므로 테이블이 단조 증가한다 —
 * 상태를 갖기로 한 설계의 유지비용이며, 정리는 하루 1회면 충분하다(만료 행은
 * 조회 시점에 이미 무효 판정되므로 정리가 늦어도 보안에는 영향이 없다).
 *
 * 만료된 행만 지운다: revoked·used 행도 만료 전까지는 남긴다 — used 행은
 * 재사용 탐지의 인계철선(tripwire)이라 지우는 순간 탐지가 무너진다.
 *
 * DELETE는 멱등이라 다중 인스턴스 중복 실행에도 안전하다(ShedLock 불필요 근거 —
 * 홀드 스위퍼와 같은 논리).
 */
@Injectable()
export class RefreshTokenCleanupService {
  private readonly logger = new Logger(RefreshTokenCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanup(): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) {
      this.logger.log(`만료 refresh 토큰 ${count}행 정리`);
    }
    return count;
  }
}
