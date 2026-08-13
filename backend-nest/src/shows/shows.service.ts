import { Injectable } from '@nestjs/common';
import { Prisma, SeatStatus, Show } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateShowSeatsDto } from './dto/shows.dto';
import { SeatMapCacheService } from './seat-map-cache.service';

export interface SeatMapEntry {
  /** 캐시 왕복(JSON 직렬화)을 거치므로 BigInt가 아닌 number로 고정 */
  id: number;
  section: string;
  rowNo: string;
  seatNo: number;
  price: number;
  status: SeatStatus;
}

export interface SeatMapPayload {
  showId: number;
  seats: SeatMapEntry[];
}

@Injectable()
export class ShowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seatMapCache: SeatMapCacheService,
  ) {}

  async getShowOrThrow(showId: bigint): Promise<Show> {
    const show = await this.prisma.show.findUnique({ where: { id: showId } });
    if (!show) {
      throw Errors.showNotFound();
    }
    return show;
  }

  /**
   * 공연장 좌석 템플릿 → 회차 좌석 인스턴스 일괄 생성.
   * 수천 행이므로 createMany 1회로 적재한다(개별 INSERT 대비 왕복 횟수 절감).
   */
  async createShowSeats(showId: bigint, dto: CreateShowSeatsDto): Promise<{ count: number }> {
    const show = await this.prisma.show.findUnique({
      where: { id: showId },
      include: { performance: { select: { venueId: true } } },
    });
    if (!show) {
      throw Errors.showNotFound();
    }

    const priceBySection = new Map(dto.prices.map((p) => [p.section, p.price]));
    const templateSeats = await this.prisma.seat.findMany({
      where: { venueId: show.performance.venueId, section: { in: [...priceBySection.keys()] } },
    });
    if (templateSeats.length === 0) {
      throw Errors.seatNotFound();
    }

    try {
      const created = await this.prisma.showSeat.createMany({
        data: templateSeats.map((seat) => ({
          showId: show.id,
          seatId: seat.id,
          // priceBySection에서 조회한 구역은 위 findMany 조건과 동일하므로 반드시 존재한다
          price: priceBySection.get(seat.section) as number,
        })),
      });
      return { count: created.count };
    } catch (e) {
      // UNIQUE(show_id, seat_id) 위반 = 이미 생성된 회차 — 중복 생성을 스키마가 차단
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.seatsAlreadyCreated();
      }
      throw e;
    }
  }

  /**
   * 좌석맵 조회 — 오픈 순간 조회가 폭주하는 이 시스템의 읽기 병목 지점.
   * 캐시 히트 시 DB를 전혀 만지지 않고, 미스 시 DB에서 만들어 5초 TTL로 심는다.
   * 무효화는 좌석 상태를 바꾸는 쪽(선점·해제·결제 확정·취소·만료 회수)의 책임이다.
   */
  async getSeatMap(showId: bigint): Promise<SeatMapPayload> {
    const cached = await this.seatMapCache.get(showId);
    if (cached !== null) {
      return JSON.parse(cached) as SeatMapPayload;
    }

    await this.getShowOrThrow(showId);
    const seats = await this.prisma.showSeat.findMany({
      where: { showId },
      include: { seat: true },
      orderBy: [{ seat: { section: 'asc' } }, { seat: { rowNo: 'asc' } }, { seat: { seatNo: 'asc' } }],
    });
    const now = Date.now();
    const payload: SeatMapPayload = {
      showId: Number(showId),
      seats: seats.map((s) => ({
        id: Number(s.id),
        section: s.seat.section,
        rowNo: s.seat.rowNo,
        seatNo: s.seat.seatNo,
        price: s.price,
        status: displayStatus(s, now),
      })),
    };
    // 존재하는 회차만 캐시된다 — 404는 위에서 던져져 미스 경로가 캐시를 오염시키지 않는다
    await this.seatMapCache.set(showId, JSON.stringify(payload));
    return payload;
  }
}

/**
 * 조회 응답용 상태 판정 — 만료됐지만 아직 회수되지 않은 HELD는 AVAILABLE로 보여준다.
 * 실제 회수는 스위퍼·TTL 알림·재선점(lazy)이 하고, 여기서는 표시만 바꾼다:
 * 조회 때마다 UPDATE를 하면 읽기 경로가 쓰기 경합에 끌려들어가기 때문.
 */
function displayStatus(seat: { status: SeatStatus; holdExpiresAt: Date | null }, now: number): SeatStatus {
  const expired =
    seat.status === SeatStatus.HELD &&
    seat.holdExpiresAt !== null &&
    seat.holdExpiresAt.getTime() <= now;
  return expired ? SeatStatus.AVAILABLE : seat.status;
}
