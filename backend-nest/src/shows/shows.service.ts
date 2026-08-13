import { Injectable } from '@nestjs/common';
import { Prisma, SeatStatus, Show } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateShowSeatsDto } from './dto/shows.dto';

export interface SeatMapEntry {
  id: bigint;
  section: string;
  rowNo: string;
  seatNo: number;
  price: number;
  status: SeatStatus;
}

@Injectable()
export class ShowsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async getSeatMap(showId: bigint): Promise<{ showId: bigint; seats: SeatMapEntry[] }> {
    await this.getShowOrThrow(showId);
    const seats = await this.prisma.showSeat.findMany({
      where: { showId },
      include: { seat: true },
      orderBy: [{ seat: { section: 'asc' } }, { seat: { rowNo: 'asc' } }, { seat: { seatNo: 'asc' } }],
    });
    const now = Date.now();
    return {
      showId,
      seats: seats.map((s) => ({
        id: s.id,
        section: s.seat.section,
        rowNo: s.seat.rowNo,
        seatNo: s.seat.seatNo,
        price: s.price,
        status: displayStatus(s, now),
      })),
    };
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
