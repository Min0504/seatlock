import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

/**
 * 좌석맵 캐시 (기획서 §7 문제 5 — 캐시 정합성).
 *
 * 전략: 상태 변경 트랜잭션 "커밋 후" 키 삭제(invalidate-on-write) + TTL 5초 안전망.
 *
 * - 왜 삭제인가: write-through(변경 시 재작성)는 쓰기마다 좌석맵 전체 직렬화 비용이
 *   들고, 동시 쓰기의 순서가 역전되면 낡은 맵이 최신 맵을 덮는다. 삭제는 순서가
 *   뒤섞여도 "다음 조회가 DB에서 다시 만든다"로 수렴한다 — 단순함이 곧 정확성.
 * - 왜 TTL도 있는가: 삭제 호출이 유실되는 경우(프로세스 크래시, Redis 순단)의
 *   안전망. 최악의 낡음이 5초를 넘지 않는다는 상한 계약이다.
 * - 어디까지 낡아도 되는가: 좌석맵은 표시용이다. 선점·결제의 진실 판정은 항상
 *   DB 조건부 UPDATE가 하므로, 낡은 맵을 보고 눌러도 "이미 선점된 좌석"(409)으로
 *   끝날 뿐 정합성 사고가 아니다 — 도메인 기준으로 staleness 허용선을 정의했다.
 * - Redis 다운: tryExec가 실패를 삼켜 캐시 없이 DB 직행으로 동작한다(성능 저하만).
 *
 * 트레이드오프: 삭제 직후 첫 조회들이 동시에 DB를 때릴 수 있다(cache stampede).
 * 오픈 순간에는 미스가 몰리므로, rebuild를 분산락 1개로 직렬화하는 옵션을 v4에서
 * 실험한다 — 지금 규모에서는 조회 쿼리 1회가 충분히 싸다.
 */
@Injectable()
export class SeatMapCacheService {
  static readonly TTL_SECONDS = 5;

  constructor(private readonly redis: RedisService) {}

  key(showId: bigint | number): string {
    return `show:${showId}:seatmap`;
  }

  async get(showId: bigint): Promise<string | null> {
    return this.redis.tryExec('좌석맵 캐시 조회', (client) => client.get(this.key(showId)));
  }

  async set(showId: bigint, json: string): Promise<void> {
    await this.redis.tryExec('좌석맵 캐시 저장', (client) =>
      client.set(this.key(showId), json, 'EX', SeatMapCacheService.TTL_SECONDS),
    );
  }

  /** 좌석 상태를 바꾼 트랜잭션이 커밋된 뒤에만 호출한다 — 롤백된 변경으로 캐시를 지우지 않게 */
  async invalidate(...showIds: Array<bigint | number>): Promise<void> {
    if (showIds.length === 0) {
      return;
    }
    await this.redis.tryExec('좌석맵 캐시 무효화', (client) =>
      client.del(...showIds.map((id) => this.key(id))),
    );
  }
}
