import { Injectable } from '@nestjs/common';
import { SeatStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { ShowsService } from '../shows/shows.service';
import { MAX_SEATS_PER_HOLD } from './dto/holds.dto';

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

      // 1인 보유 상한 — 같은 회차에서 이미 유효하게 HELD 중인 좌석 + 이번 요청 ≤ 상한.
      // 이 검사는 UX 규칙이라 근사 검증으로 충분하다(초과판매처럼 돈이 걸린 불변식이 아님).
      const heldCount = await tx.showSeat.count({
        where: {
          showId,
          holdUserId: userId,
          status: SeatStatus.HELD,
          holdExpiresAt: { gt: new Date() },
        },
      });
      if (heldCount + ids.length > MAX_SEATS_PER_HOLD) {
        throw Errors.holdLimitExceeded(MAX_SEATS_PER_HOLD);
      }

      // SELECT 후 UPDATE로 나누면 두 트랜잭션이 그 틈에 같은 좌석을 통과한다(check-then-act race)
      // → WHERE status='AVAILABLE' 조건부 UPDATE 한 문장으로 검사와 변경을 원자화한다.
      //   PostgreSQL(READ COMMITTED)은 행 잠금 후 조건을 재평가하므로, 경쟁에서 진 트랜잭션은
      //   갱신 0건을 보고 즉시 실패한다 — 락 대기가 없고 코드가 단순하다.
      //   비관적/낙관적/분산락과의 비교는 docs/lock-benchmark.md 참조.
      const updated = await tx.showSeat.updateManyAndReturn({
        where: { id: { in: ids }, status: SeatStatus.AVAILABLE },
        data: {
          status: SeatStatus.HELD,
          holdUserId: userId,
          holdGroupId,
          holdExpiresAt: expiresAt,
        },
      });

      if (updated.length !== ids.length) {
        // 하나라도 선점 실패 → 예외로 트랜잭션 전체 롤백 (부분 선점 금지 —
        // "2좌석 중 1좌석만 잡힘"은 사용자에게 최악의 상태다)
        const wonIds = new Set(updated.map((s) => s.id));
        const takenIds = ids.filter((id) => !wonIds.has(id)).map((id) => Number(id));
        throw Errors.seatAlreadyTaken(takenIds);
      }

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

  /** 선점 취소 — 본인 소유의 HELD 좌석만 원복한다 (조건부 UPDATE라 중복 호출에도 안전) */
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
