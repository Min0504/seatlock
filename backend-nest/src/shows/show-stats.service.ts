import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ShowsService } from './shows.service';

export interface ShowStats {
  showId: number;
  totalSeats: number;
  /** 결제 확정된 좌석 수 (판매 완료) */
  reservedSeats: number;
  /** 유효한(미만료) 선점 좌석 수 */
  heldSeats: number;
  /** 판매 가능 좌석 수 — 만료됐지만 아직 회수 전인 HELD 포함 */
  availableSeats: number;
  /** reservedSeats / totalSeats, 소수 4자리 */
  salesRate: number;
  /** 승인 상태 결제 금액 합계 — 취소(환불)된 결제는 자동 제외 */
  revenue: number;
  generatedAt: string;
}

/**
 * 회차별 판매 통계 (기획서 §4 관리자 판매 통계, §9 캐시 전략 — 통계 TTL 5m).
 *
 * 집계는 실시간 GROUP BY로 계산하고 5분 캐시로 감싼다. 배치 사전 집계(별도 테이블)와
 * 비교하면: 회차당 좌석 수천 행의 단일 인덱스 스캔 집계는 캐시 미스 시에도 수 ms라
 * 사전 집계가 해결할 문제(수억 행 스캔)가 아직 없다 — 단순한 쪽을 선택했다.
 * 관리자 대시보드는 5분 신선도로 충분하므로 무효화 없이 TTL 만료에만 맡긴다.
 */
@Injectable()
export class ShowStatsService {
  static readonly TTL_SECONDS = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly showsService: ShowsService,
  ) {}

  key(showId: bigint | number): string {
    return `show:${showId}:stats`;
  }

  async getStats(showId: bigint): Promise<ShowStats> {
    const cached = await this.redis.tryExec('통계 캐시 조회', (client) =>
      client.get(this.key(showId)),
    );
    if (cached !== null) {
      return JSON.parse(cached) as ShowStats;
    }

    await this.showsService.getShowOrThrow(showId);

    // 좌석 집계와 매출을 한 왕복으로: FILTER 절은 조건별 count를 단일 스캔에서 뽑고,
    // 매출은 payments(APPROVED)의 합 — 좌석 수 × 가격으로 역산하지 않는 이유는
    // 환불·부분 취소가 생겨도 "돈의 사실"은 결제 원장에만 있기 때문이다.
    const [row] = await this.prisma.$queryRaw<
      Array<{
        total_seats: number;
        reserved_seats: number;
        held_seats: number;
        revenue: number;
      }>
    >`
      SELECT
        count(*)::int                                                            AS total_seats,
        count(*) FILTER (WHERE status = 'RESERVED')::int                         AS reserved_seats,
        count(*) FILTER (WHERE status = 'HELD' AND hold_expires_at > now())::int AS held_seats,
        (SELECT coalesce(sum(p.amount), 0)::int
           FROM payments p
           JOIN reservations r ON r.id = p.reservation_id
          WHERE r.show_id = ${showId} AND p.status = 'APPROVED')                 AS revenue
      FROM show_seats
      WHERE show_id = ${showId}`;

    const stats: ShowStats = {
      showId: Number(showId),
      totalSeats: row.total_seats,
      reservedSeats: row.reserved_seats,
      heldSeats: row.held_seats,
      availableSeats: row.total_seats - row.reserved_seats - row.held_seats,
      salesRate: row.total_seats === 0 ? 0 : Math.round((row.reserved_seats / row.total_seats) * 10000) / 10000,
      revenue: row.revenue,
      generatedAt: new Date().toISOString(),
    };
    await this.redis.tryExec('통계 캐시 저장', (client) =>
      client.set(this.key(showId), JSON.stringify(stats), 'EX', ShowStatsService.TTL_SECONDS),
    );
    return stats;
  }
}
