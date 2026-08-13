import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

/**
 * 공연 목록 첫 페이지 캐시 (기획서 §9 — 공연 목록 TTL 60s).
 *
 * 좌석맵 캐시(5s + 즉시 무효화)와 달리 목록은 60초 신선도로 충분하다:
 * 목록에는 좌석 상태 같은 실시간 정보가 없고, 공연 등록은 ADMIN의 드문 이벤트라
 * 등록 시점의 무효화 한 번이면 정합이 맞는다.
 */
@Injectable()
export class PerformanceListCacheService {
  static readonly TTL_SECONDS = 60;
  private static readonly KEY = 'performances:list:first';

  constructor(private readonly redis: RedisService) {}

  async get(): Promise<string | null> {
    return this.redis.tryExec('공연 목록 캐시 조회', (client) =>
      client.get(PerformanceListCacheService.KEY),
    );
  }

  async set(json: string): Promise<void> {
    await this.redis.tryExec('공연 목록 캐시 저장', (client) =>
      client.set(PerformanceListCacheService.KEY, json, 'EX', PerformanceListCacheService.TTL_SECONDS),
    );
  }

  async invalidate(): Promise<void> {
    await this.redis.tryExec('공연 목록 캐시 무효화', (client) =>
      client.del(PerformanceListCacheService.KEY),
    );
  }
}
