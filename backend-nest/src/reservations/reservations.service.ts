import { Injectable } from '@nestjs/common';
import { Prisma, ReservationStatus, SeatStatus } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { MyReservationsQuery } from './dto/reservations.dto';

export interface CreatedReservation {
  id: bigint;
  status: ReservationStatus;
  totalPrice: number;
  seatCount: number;
  /** 이 시각 전에 결제해야 한다 — 프론트 카운트다운의 기준 */
  payUntil: Date | null;
}

export interface ReservationSummary {
  id: bigint;
  status: ReservationStatus;
  totalPrice: number;
  createdAt: Date;
  show: { id: bigint; startsAt: Date; performanceTitle: string };
  seats: Array<{ section: string; rowNo: string; seatNo: number; price: number }>;
}

interface SeatInfo {
  section: string;
  rowNo: string;
  seatNo: number;
  price: number;
}

/**
 * 예매 수명주기: PENDING(미결제) → CONFIRMED(결제 승인) / CANCELED.
 *
 * 좌석-예매의 확정 연결(reservation_seats)은 결제 승인 시점에 만든다.
 * PENDING 단계는 hold_group_id로 선점을 참조만 하므로, 선점이 만료돼 좌석이
 * 다른 사람에게 팔려도 죽은 참조가 될 뿐 어떤 제약과도 충돌하지 않는다 —
 * "이중 판매 방어선(부분 유니크)"은 확정 좌석만 지키면 된다.
 */
@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 선점 좌석으로 미결제(PENDING) 예매를 생성한다. 좌석 상태는 바꾸지 않는다. */
  async create(userId: bigint, holdGroupId: string): Promise<CreatedReservation> {
    const seats = await this.prisma.showSeat.findMany({
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
    const payUntil = seats.reduce<Date | null>(
      (min, s) => (s.holdExpiresAt !== null && (min === null || s.holdExpiresAt < min) ? s.holdExpiresAt : min),
      null,
    );

    try {
      const reservation = await this.prisma.reservation.create({
        data: {
          userId,
          showId: seats[0].showId,
          status: ReservationStatus.PENDING,
          totalPrice,
          seatCount: seats.length,
          holdGroupId,
        },
      });
      return { id: reservation.id, status: reservation.status, totalPrice, seatCount: seats.length, payUntil };
    } catch (e) {
      // 부분 유니크(hold_group_id WHERE status='PENDING') 충돌 = 같은 선점으로 이미
      // 만든 미결제 예매가 있다 → 새로 만들지 않고 그대로 반환(생성의 멱등화).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.reservation.findFirst({
          where: { holdGroupId, userId, status: ReservationStatus.PENDING },
        });
        if (existing) {
          return {
            id: existing.id,
            status: existing.status,
            totalPrice: existing.totalPrice,
            seatCount: existing.seatCount,
            payUntil,
          };
        }
      }
      throw e;
    }
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
    const page = hasNext ? rows.slice(0, size) : rows;

    // PENDING 예매의 좌석은 아직 reservation_seats가 없다 — 선점 그룹으로 일괄 조회
    // (행마다 조회하면 N+1). 선점이 만료돼 회수됐다면 빈 배열 = 결제 불가능한 예매.
    const pendingGroupIds = page
      .filter((r) => r.status === ReservationStatus.PENDING && r.holdGroupId !== null)
      .map((r) => r.holdGroupId as string);
    const heldSeats =
      pendingGroupIds.length > 0
        ? await this.prisma.showSeat.findMany({
            where: { holdGroupId: { in: pendingGroupIds } },
            include: { seat: true },
          })
        : [];
    const seatsByGroup = new Map<string, SeatInfo[]>();
    for (const s of heldSeats) {
      const list = seatsByGroup.get(s.holdGroupId as string) ?? [];
      list.push({ section: s.seat.section, rowNo: s.seat.rowNo, seatNo: s.seat.seatNo, price: s.price });
      seatsByGroup.set(s.holdGroupId as string, list);
    }

    const items = page.map((r) => ({
      id: r.id,
      status: r.status,
      totalPrice: r.totalPrice,
      createdAt: r.createdAt,
      show: {
        id: r.show.id,
        startsAt: r.show.startsAt,
        performanceTitle: r.show.performance.title,
      },
      seats:
        r.status === ReservationStatus.PENDING
          ? (seatsByGroup.get(r.holdGroupId ?? '') ?? [])
          : r.reservationSeats.map((rs) => ({
              section: rs.showSeat.seat.section,
              rowNo: rs.showSeat.seat.rowNo,
              seatNo: rs.showSeat.seat.seatNo,
              price: rs.showSeat.price,
            })),
    }));
    return { items, nextCursor: hasNext ? String(items[items.length - 1].id) : null };
  }
}
