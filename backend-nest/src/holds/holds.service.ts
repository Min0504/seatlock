import { Injectable } from '@nestjs/common';
import { SeatStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { ShowsService } from '../shows/shows.service';

export const HOLD_TTL_MS = 5 * 60 * 1000;

export interface HoldResult {
  holdGroupId: string;
  expiresAt: Date;
  seats: Array<{ id: bigint; section: string; rowNo: string; seatNo: number; price: number }>;
}

@Injectable()
export class HoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly showsService: ShowsService,
  ) {}

  async hold(showId: bigint, userId: bigint, seatIds: number[]): Promise<HoldResult> {
    const show = await this.showsService.getShowOrThrow(showId);
    if (show.ticketOpenAt.getTime() > Date.now()) {
      throw Errors.ticketNotOpen(show.ticketOpenAt);
    }

    const holdGroupId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS);
    const ids = seatIds.map((id) => BigInt(id));

    return this.prisma.$transaction(async (tx) => {
      const seats = await tx.showSeat.findMany({
        where: { id: { in: ids }, showId },
        include: { seat: true },
      });
      if (seats.length !== ids.length) {
        throw Errors.seatNotFound();
      }

      const taken = seats.filter((s) => s.status !== SeatStatus.AVAILABLE);
      if (taken.length > 0) {
        throw Errors.seatAlreadyTaken(taken.map((s) => Number(s.id)));
      }

      // NOTE(v1): 위 조회(check)와 아래 갱신(act)이 분리된 check-then-act 구조 —
      // 두 트랜잭션이 같은 좌석을 동시에 AVAILABLE로 읽으면 둘 다 성공해 초과판매가 난다.
      // v2에서 동시성 테스트로 이 결함을 재현한 뒤 원자적 조건부 UPDATE로 교체한다.
      await tx.showSeat.updateMany({
        where: { id: { in: ids } },
        data: {
          status: SeatStatus.HELD,
          holdUserId: userId,
          holdGroupId,
          holdExpiresAt: expiresAt,
        },
      });

      return {
        holdGroupId,
        expiresAt,
        seats: seats.map((s) => ({
          id: s.id,
          section: s.seat.section,
          rowNo: s.seat.rowNo,
          seatNo: s.seat.seatNo,
          price: s.price,
        })),
      };
    });
  }

  /** 선점 취소 — 본인 소유의 HELD 좌석만 원복한다 */
  async release(holdGroupId: string, userId: bigint): Promise<{ releasedSeats: number }> {
    const result = await this.prisma.showSeat.updateMany({
      where: { holdGroupId, holdUserId: userId, status: SeatStatus.HELD },
      data: { status: SeatStatus.AVAILABLE, holdUserId: null, holdGroupId: null, holdExpiresAt: null },
    });
    if (result.count === 0) {
      throw Errors.holdNotFound();
    }
    return { releasedSeats: result.count };
  }
}
