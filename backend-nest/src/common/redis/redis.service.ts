import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis 연결 관리자.
 *
 * 원칙(기획서 §아키텍처): Redis는 성능·편의(캐시, 선점 TTL 알림)를 담당하고,
 * 좌석 상태의 최종 권위는 항상 PostgreSQL이다. 그래서 이 서비스의 tryExec는
 * "Redis가 죽어도 호출부가 계속 진행"하도록 실패를 삼키고 경고만 남긴다 —
 * 성능 저하는 허용하되 장애 전파는 금지. (카오스 테스트로 검증)
 *
 * - enableOfflineQueue=false: 연결이 끊긴 동안 명령을 큐에 쌓아 재연결을 기다리는
 *   대신 즉시 실패시킨다. 선점 API 응답이 Redis 복구를 기다리며 지연되면 안 된다.
 * - 구독 전용 연결 분리: Redis 프로토콜상 subscribe 모드에 들어간 연결은
 *   일반 명령을 실행할 수 없으므로, keyspace 알림 구독자는 연결을 따로 받는다.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly url: string;
  private readonly connections: Redis[] = [];
  private lastErrorLogAt = 0;

  readonly client: Redis;

  constructor(config: ConfigService) {
    this.url = config.get<string>('REDIS_URL') ?? 'redis://localhost:63790';
    this.client = this.createConnection();
  }

  /** keyspace 알림 구독처럼 subscribe 모드가 필요한 곳에 전용 연결을 내어준다 */
  createSubscriber(): Redis {
    return this.createConnection();
  }

  /** 연결된 DB 인덱스 — keyspace 이벤트 채널명(`__keyevent@{db}__:expired`)에 필요 */
  get db(): number {
    return this.client.options.db ?? 0;
  }

  /**
   * 실패를 전파하지 않는 실행 래퍼. Redis 장애 시 경고 로그만 남기고 null을 반환한다.
   * 정합성이 걸린 작업(좌석 상태 변경 등)은 절대 이 래퍼로 실행하지 않는다 — DB의 몫.
   */
  async tryExec<T>(label: string, fn: (client: Redis) => Promise<T>): Promise<T | null> {
    try {
      return await fn(this.client);
    } catch (e) {
      this.warnThrottled(`${label} 실패 — DB 경로로 계속 진행: ${(e as Error).message}`);
      return null;
    }
  }

  private createConnection(): Redis {
    const conn = new Redis(this.url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    // 'error' 리스너가 없으면 Node가 unhandled error로 프로세스를 죽인다 — 반드시 부착
    conn.on('error', (e: Error) => this.warnThrottled(`연결 오류: ${e.message}`));
    this.connections.push(conn);
    return conn;
  }

  /** 재연결 시도마다 반복되는 동일 오류로 로그가 폭주하지 않도록 30초 1회로 제한 */
  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt > 30_000) {
      this.lastErrorLogAt = now;
      this.logger.warn(message);
    }
  }

  async onModuleDestroy(): Promise<void> {
    // 연결이 이미 끊긴 상태라면 quit이 거부될 수 있다 — 종료 경로에서는 강제 종료로 마무리
    await Promise.allSettled(this.connections.map((c) => c.quit()));
    for (const c of this.connections) {
      c.disconnect();
    }
  }
}
