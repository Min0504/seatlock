import { Injectable } from '@nestjs/common';
import { ReservationStatus, SeatStatus } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 선점 좌석을 예매로 확정한다.
   * v1: 결제 단계가 아직 없으므로 생성 즉시 CONFIRMED 처리한다.
   * v2에서 mock PG 결제가 도입되면 PENDING 생성 → 결제 승인 시 CONFIRMED로 분리된다.
   */
  async create(userId: bigint, holdGroupId: string): Promise<{ id: bigint; totalPrice: number }> {
    return this.prisma.$transaction(async (tx) => {
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
      await tx.showSeat.updateMany({
        where: { id: { in: seats.map((s) => s.id) } },
        data: {
          status: SeatStatus.RESERVED,
          // 확정 이후의 소유 추적은 reservation_seats가 담당하므로 hold 필드는 비운다
          holdUserId: null,
          holdGroupId: null,
          holdExpiresAt: null,
        },
      });

      return { id: reservation.id, totalPrice };
    });
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
