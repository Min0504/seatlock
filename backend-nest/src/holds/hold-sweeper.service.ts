import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';

export const HOLD_SWEEPER_INTERVAL = 'hold-sweeper';

/**
 * 만료 선점 회수 스케줄러 — 3중 방어의 "최종 권위" (기획서 문제 2).
 *
 * Redis TTL 알림(빠른 경로)은 전달 보장이 없다: pub/sub은 유실될 수 있고,
 * 구독이 끊긴 동안의 이벤트는 소실된다. 그래서 정합성의 책임은 DB를 주기적으로
 * 스캔하는 이 스위퍼가 진다 — 알림은 UX(즉시성)용, 스위퍼가 권위.
 */
@Injectable()
export class HoldSweeperService {
  private readonly logger = new Logger(HoldSweeperService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Interval(HOLD_SWEEPER_INTERVAL, 30_000)
  async sweep(): Promise<number> {
    // 만료 판정 시계는 앱이 아니라 DB의 now()다 — 서버가 여러 대일 때 시계가 서로
    // 달라도 hold_expires_at을 기록한 DB 자신이 판정하면 기준이 하나로 유지된다.
    // 이 UPDATE는 멱등이라 서버 2대가 동시에 실행해도 안전하다(두 번째는 0건 갱신).
    // 비멱등 배치가 생기면 그때 ShedLock 같은 분산 잠금이 필요해진다 — PointLedger에서 다룬다.
    const reclaimed = await this.prisma.$executeRaw`
      UPDATE show_seats
         SET status = 'AVAILABLE', hold_user_id = NULL, hold_group_id = NULL, hold_expires_at = NULL
       WHERE status = 'HELD' AND hold_expires_at < now()`;
    if (reclaimed > 0) {
      this.logger.log(`만료 선점 ${reclaimed}석 회수`);
    }
    return reclaimed;
  }
}
