import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SeatStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { SeatMapCacheService } from '../shows/seat-map-cache.service';
import { parseHoldKey } from './hold-keys';

/**
 * 선점 TTL 만료 알림 리스너 — 3중 방어의 "빠른 경로" (기획서 문제 2).
 *
 * hold:{showSeatId} 키가 만료되는 순간 keyspace 알림(`__keyevent@{db}__:expired`)을
 * 받아 좌석을 즉시 회수한다. 스위퍼 주기(30초)를 기다리지 않으므로 사용자 체감이
 * 빨라진다 — 단 pub/sub은 전달 보장이 없으므로 이 경로가 놓친 좌석은 스위퍼가 줍는다.
 */
@Injectable()
export class HoldExpiryListener implements OnModuleInit {
  private readonly logger = new Logger(HoldExpiryListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly seatMapCache: SeatMapCacheService,
  ) {}

  async onModuleInit(): Promise<void> {
    // 만료 이벤트(Ex)가 서버 설정에 없더라도 동작하도록 기동 시 켠다.
    // 관리형 Redis는 CONFIG를 막는 경우가 있어 실패를 허용한다 — 그 환경에서는
    // 파라미터 그룹으로 켜야 하며, 못 켜도 스위퍼가 있으므로 정합성은 무손상.
    await this.redis.tryExec('notify-keyspace-events 활성화', (c) =>
      c.config('SET', 'notify-keyspace-events', 'Ex'),
    );

    const channel = `__keyevent@${this.redis.db}__:expired`;
    const subscriber = this.redis.createSubscriber();
    subscriber.on('message', (_channel: string, key: string) => {
      void this.onKeyExpired(key);
    });
    // 구독 전용 연결은 오프라인 큐를 켜 두었으므로(redis.service 참조) Redis가
    // 나중에 떠도 구독이 자동 성립하고, 재연결 시에는 ioredis가 재구독한다.
    subscriber.subscribe(channel).catch((e: Error) => {
      this.logger.warn(`만료 알림 구독 실패(스위퍼가 대신 회수): ${e.message}`);
    });
  }

  private async onKeyExpired(key: string): Promise<void> {
    const showSeatId = parseHoldKey(key);
    if (showSeatId === null) {
      return;
    }
    try {
      // 알림이 지연 도착해 좌석이 이미 재선점(미래 만료시각)·확정(RESERVED)됐을 수 있다.
      // status·만료시각을 다시 확인하는 조건부 UPDATE라 늦거나 중복된 알림은 0건 갱신으로 무해하다.
      const released = await this.prisma.showSeat.updateManyAndReturn({
        where: { id: showSeatId, status: SeatStatus.HELD, holdExpiresAt: { lte: new Date() } },
        data: { status: SeatStatus.AVAILABLE, holdUserId: null, holdGroupId: null, holdExpiresAt: null },
      });
      if (released.length > 0) {
        await this.seatMapCache.invalidate(released[0].showId);
        this.logger.log(`TTL 알림으로 좌석 ${showSeatId} 즉시 회수`);
      }
    } catch (e) {
      // 여기서 실패해도 스위퍼가 최종적으로 회수한다 — 알림 경로는 최선 노력(best-effort)
      this.logger.warn(`좌석 ${showSeatId} 알림 회수 실패(스위퍼가 처리): ${(e as Error).message}`);
    }
  }
}
