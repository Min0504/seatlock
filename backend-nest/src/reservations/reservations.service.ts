import { Injectable } from '@nestjs/common';
import { ReservationStatus, SeatStatus } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { holdKey } from '../holds/hold-keys';
import { MyReservationsQuery } from './dto/reservations.dto';

export interface ReservationSummary {
  id: bigint;
  status: ReservationStatus;
  totalPrice: number;
  createdAt: Date;
  show: { id: bigint; startsAt: Date; performanceTitle: string };
  seats: Array<{ section: string; rowNo: string; seatNo: number; price: number }>;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 선점 좌석을 예매로 확정한다.
   * v1: 결제 단계가 아직 없으므로 생성 즉시 CONFIRMED 처리한다.
   * v2에서 mock PG 결제가 도입되면 PENDING 생성 → 결제 승인 시 CONFIRMED로 분리된다.
   */
  async create(userId: bigint, holdGroupId: string): Promise<{ id: bigint; totalPrice: number }> {
    const created = await this.prisma.$transaction(async (tx) => {
      const seats = await tx.showSeat.findMany({
        where: { holdGroupId, holdUserId: userId, status: SeatStatus.HELD },
      });
      if (seats.length === 0) {
        throw Errors.holdNotFound();
      }
      const now = Date.now();
      if (seats.some((s) => s.holdExpiresAt !== null && s.holdExpiresAt.getTime() < now)) {
        throw Errors.holdExpired();
      }

      // 금액은 항상 서버가 DB의 가격으로 계산한다 — 클라이언트 전달 금액은 신뢰하지 않는다
      const totalPrice = seats.reduce((sum, s) => sum + s.price, 0);

      const reservation = await tx.reservation.create({
        data: {
          userId,
          showId: seats[0].showId,
          status: ReservationStatus.CONFIRMED,
          totalPrice,
        },
      });
      await tx.reservationSeat.createMany({
        data: seats.map((s) => ({ reservationId: reservation.id, showSeatId: s.id })),
      });
      // HELD 상태 조건을 다시 건 조건부 UPDATE — 만료 회수(스위퍼·TTL 알림·lazy 재선점)가
      // 이 트랜잭션과 경합해 좌석을 가져갔다면 여기서 count가 어긋나 전체 롤백된다.
      const updated = await tx.showSeat.updateMany({
        where: {
          id: { in: seats.map((s) => s.id) },
          status: SeatStatus.HELD,
          holdGroupId,
        },
        data: {
          status: SeatStatus.RESERVED,
          // 확정 이후의 소유 추적은 reservation_seats가 담당하므로 hold 필드는 비운다
          holdUserId: null,
          holdGroupId: null,
          holdExpiresAt: null,
        },
      });
      if (updated.count !== seats.length) {
        throw Errors.holdExpired();
      }

      return { id: reservation.id, totalPrice, seatIds: seats.map((s) => s.id) };
    });

    // 확정된 좌석의 TTL 키는 더 이상 의미가 없다 — 남겨둬도 만료 알림이 조건부
    // UPDATE(RESERVED라 0건)로 무해하지만, 불필요한 이벤트를 줄이기 위해 정리한다.
    await this.redis.tryExec('확정 좌석 TTL 키 삭제', (client) =>
      client.del(...created.seatIds.map((id) => holdKey(id))),
    );

    return { id: created.id, totalPrice: created.totalPrice };
  }

  async listMine(
    userId: bigint,
    query: MyReservationsQuery,
  ): Promise<{ items: ReservationSummary[]; nextCursor: string | null }> {
    const size = query.size ?? 20;
    const rows = await this.prisma.reservation.findMany({
      where: {
        userId,
        ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: size + 1,
      include: {
        show: { include: { performance: { select: { title: true } } } },
        reservationSeats: { include: { showSeat: { include: { seat: true } } } },
      },
    });

    const hasNext = rows.length > size;
    const items = (hasNext ? rows.slice(0, size) : rows).map((r) => ({
      id: r.id,
      status: r.status,
      totalPrice: r.totalPrice,
      createdAt: r.createdAt,
      show: {
        id: r.show.id,
        startsAt: r.show.startsAt,
        performanceTitle: r.show.performance.title,
      },
      seats: r.reservationSeats.map((rs) => ({
        section: rs.showSeat.seat.section,
        rowNo: rs.showSeat.seat.rowNo,
        seatNo: rs.showSeat.seat.seatNo,
        price: rs.showSeat.price,
      })),
    }));
    return { items, nextCursor: hasNext ? String(items[items.length - 1].id) : null };
  }
}
