import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus, Prisma, ReservationStatus, SeatStatus } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { holdKey } from '../holds/hold-keys';
import { MockPgService } from '../payments/mock-pg.service';
import { SeatMapCacheService } from '../shows/seat-map-cache.service';
import { MyReservationsQuery } from './dto/reservations.dto';

/** 공연 시작 24시간 전까지만 취소 가능 (기획서 §6 API 계약) */
export const CANCEL_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** 취소 트랜잭션 도중 예매 상태가 바뀐 경우의 내부 신호 — 롤백 후 재판정 트리거 */
class StateChangedDuringCancel extends Error {}

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

export interface CancelResult {
  id: bigint;
  status: ReservationStatus;
  /** 이번 취소로 판매 가능 상태로 되돌린 좌석 수 (반복 취소·만료 후 취소는 0일 수 있다) */
  releasedSeats: number;
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
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly pg: MockPgService,
    private readonly seatMapCache: SeatMapCacheService,
  ) {}

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

  /**
   * 예매 취소. 상태 기계 전이는 전부 조건부 UPDATE로 원자화한다 —
   * 취소 직후의 신규 선점, 동시 이중 취소, 취소와 결제 승인의 경합(기획서 장애
   * 시나리오 5)이 모두 "WHERE가 곧 판정"인 한 문장으로 직렬화된다.
   */
  async cancel(userId: bigint, reservationId: bigint): Promise<CancelResult> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { show: true },
    });
    // 남의 예매는 존재 자체를 숨긴다(404) — IDOR 차단
    if (!reservation || reservation.userId !== userId) {
      throw Errors.reservationNotFound();
    }
    // 반복 취소는 멱등 — 이미 취소된 상태를 그대로 반환한다 (DELETE의 재시도 안전)
    if (reservation.status === ReservationStatus.CANCELED) {
      return { id: reservation.id, status: reservation.status, releasedSeats: 0 };
    }

    if (reservation.status === ReservationStatus.PENDING) {
      return this.cancelPending(userId, reservationId, reservation.holdGroupId, reservation.showId);
    }
    return this.cancelConfirmed(reservation.id, reservation.show.startsAt, reservation.showId);
  }

  /**
   * 미결제 예매 취소 — 환불이 없으므로 24시간 규칙을 적용하지 않고,
   * 선점 좌석을 즉시 반납해 다른 사람이 살 수 있게 한다.
   *
   * 갱신 순서는 결제 확정 트랜잭션과 동일하게 "좌석 → 예매"다. 순서가 어긋나면
   * 같은 예매에 결제와 취소가 동시에 달릴 때 서로의 행 잠금을 기다리는
   * 교착(deadlock)이 생길 수 있다 — 잠금 순서 통일이 교착 예방의 기본이다.
   */
  private async cancelPending(
    userId: bigint,
    reservationId: bigint,
    holdGroupId: string | null,
    showId: bigint,
  ): Promise<CancelResult> {
    let released: Array<{ id: bigint }>;
    try {
      released = await this.prisma.$transaction(async (tx) => {
        const seats =
          holdGroupId === null
            ? []
            : await tx.showSeat.updateManyAndReturn({
                where: { holdGroupId, holdUserId: userId, status: SeatStatus.HELD },
                data: { status: SeatStatus.AVAILABLE, holdUserId: null, holdGroupId: null, holdExpiresAt: null },
              });
        const transitioned = await tx.reservation.updateMany({
          where: { id: reservationId, status: ReservationStatus.PENDING },
          data: { status: ReservationStatus.CANCELED },
        });
        // 그 사이 결제가 확정됐거나(CONFIRMED) 다른 요청이 취소했다 —
        // 좌석 반납까지 통째로 롤백하고 바깥에서 새 상태 기준으로 재판정한다.
        // 반대로 이 취소가 이기면, 진행 중이던 결제 승인은 확정 트랜잭션의
        // "예매 PENDING→CONFIRMED" 조건부 UPDATE 0건으로 롤백 + 보상 취소(환불)된다.
        if (transitioned.count !== 1) {
          throw new StateChangedDuringCancel();
        }
        return seats;
      });
    } catch (e) {
      if (e instanceof StateChangedDuringCancel) {
        return this.cancel(userId, reservationId);
      }
      throw e;
    }

    if (released.length > 0) {
      await this.redis.tryExec('취소 좌석 TTL 키 삭제', (client) =>
        client.del(...released.map((s) => holdKey(s.id))),
      );
      await this.seatMapCache.invalidate(showId);
    }
    return { id: reservationId, status: ReservationStatus.CANCELED, releasedSeats: released.length };
  }

  /** 결제 완료 예매 취소 — 좌석 원복 + 결제 CANCELED + PG 환불(mock) */
  private async cancelConfirmed(
    reservationId: bigint,
    startsAt: Date,
    showId: bigint,
  ): Promise<CancelResult> {
    if (startsAt.getTime() - Date.now() < CANCEL_DEADLINE_MS) {
      throw Errors.cancelWindowClosed();
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.reservation.updateMany({
        where: { id: reservationId, status: ReservationStatus.CONFIRMED },
        data: { status: ReservationStatus.CANCELED },
      });
      if (transitioned.count !== 1) {
        return null; // 동시 취소 경합에서 진 쪽 — 이미 CANCELED다
      }

      // 확정 연결을 취소 이력으로 남긴다(행 삭제가 아니라 canceled=true) —
      // 부분 유니크 인덱스(WHERE canceled=false)에서 빠지며 좌석 재판매가 열린다
      const links = await tx.reservationSeat.updateManyAndReturn({
        where: { reservationId, canceled: false },
        data: { canceled: true },
      });

      // 취소 직후 신규 선점과의 경합 — RESERVED인 좌석만 되돌리는 조건부 UPDATE라
      // 이미 다른 상태로 넘어간 좌석을 덮어쓸 수 없다
      await tx.showSeat.updateMany({
        where: { id: { in: links.map((l) => l.showSeatId) }, status: SeatStatus.RESERVED },
        data: { status: SeatStatus.AVAILABLE },
      });

      const payment = await tx.payment.findFirst({
        where: { reservationId, status: PaymentStatus.APPROVED },
      });
      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.CANCELED },
        });
      }
      return { releasedSeats: links.length, refundOrderId: payment?.idempotencyKey ?? null };
    });

    if (result === null) {
      return { id: reservationId, status: ReservationStatus.CANCELED, releasedSeats: 0 };
    }
    await this.seatMapCache.invalidate(showId);
    // 환불은 DB 확정 후 실행한다. mock PG의 cancel은 멱등이라 재시도에 안전하지만,
    // 실 PG라면 "DB는 취소됐는데 환불 요청이 유실"될 수 있는 지점 — 아웃박스/재시도가
    // 필요한 주제이며 이 포트폴리오에서는 HookRelay가 그 문제를 전담한다.
    if (result.refundOrderId !== null) {
      await this.pg.cancel(result.refundOrderId);
      this.logger.log(`환불 완료 — reservation=${reservationId}`);
    }
    return { id: reservationId, status: ReservationStatus.CANCELED, releasedSeats: result.releasedSeats };
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
