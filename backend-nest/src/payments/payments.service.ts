import { Injectable, Logger } from '@nestjs/common';
import { Payment, PaymentStatus, Prisma, Reservation, ReservationStatus, SeatStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { DomainException } from '../common/errors/domain.exception';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { holdKey } from '../holds/hold-keys';
import { CreatePaymentDto } from './dto/payments.dto';
import { MockPgService, PgTimeoutError } from './mock-pg.service';

/**
 * PENDING 결제를 "처리 중"으로 간주하는 시간. 이보다 오래된 PENDING은
 * PG 응답을 받지 못하고 죽은 요청(프로세스 크래시·타임아웃 후 미복구)으로 보고,
 * 같은 키의 재시도가 PG 상태조회로 진실을 확인해 마무리한다.
 * PG 왕복 상한보다 충분히 커야 살아있는 요청을 죽은 것으로 오판하지 않는다.
 */
export const PAYMENT_STALE_MS = 30_000;

export interface PaymentView {
  paymentId: bigint;
  reservationId: bigint;
  status: PaymentStatus;
  amount: number;
  method: string;
  pgTxId: string | null;
}

export interface PayResult {
  payment: PaymentView;
  /** true면 이번 요청은 결제를 재실행하지 않고 기존 결과를 재생했다 (HTTP 200) */
  replayed: boolean;
}

/**
 * 멱등 결제 (기획서 §7 문제 3).
 *
 * "한 번만 실행"은 payments.idempotency_key UNIQUE 제약에 INSERT하는 것으로
 * 선점한다 — 애플리케이션 메모리 검사는 서버가 2대가 되는 순간 무너지지만,
 * 유니크 제약은 DB가 보장하는 가장 값싸고 확실한 직렬화 장치다.
 *
 * 상태 기계: PENDING(PG 결과 모름) → APPROVED / FAILED, APPROVED → CANCELED(환불).
 * 타임아웃·크래시로 PENDING에 멈춘 결제는 실패로 단정하지 않고 PG 상태조회로
 * 확인한다 — "모른다"를 상태로 모델링하는 것이 핵심이다 (기획서 장애 시나리오 2).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pg: MockPgService,
    private readonly redis: RedisService,
  ) {}

  async pay(userId: bigint, idempotencyKey: string, dto: CreatePaymentDto): Promise<PayResult> {
    const requestHash = hashRequest(dto);

    const reservation = await this.prisma.reservation.findUnique({
      where: { id: BigInt(dto.reservationId) },
    });
    // 남의 예매는 존재 자체를 숨긴다(404) — ID 순회로 예매 존재를 열거하는 것 차단
    if (!reservation || reservation.userId !== userId) {
      throw Errors.reservationNotFound();
    }

    // 재생 경로를 예매 상태 검사보다 먼저 태운다 — 결제 성공으로 예매가 CONFIRMED가
    // 된 뒤에 도착하는 재시도(더블클릭의 두 번째 클릭)가 멱등 계약의 본론이기 때문이다.
    // 상태 검사를 먼저 하면 그 재시도가 ALREADY_PAID(409)로 튕겨 계약이 깨진다.
    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return this.replayExisting(existing, reservation, requestHash);
    }

    if (reservation.status === ReservationStatus.CONFIRMED) {
      throw Errors.alreadyPaid();
    }
    if (reservation.status !== ReservationStatus.PENDING) {
      throw Errors.reservationNotPayable();
    }

    // 선점이 이미 죽었으면 PG를 부르기 전에 끊는다 — 승인 후 보상 취소(환불)로
    // 가는 낭비 경로를 줄이는 UX 검사일 뿐, 최종 판정은 확정 트랜잭션의 조건부 UPDATE다.
    await this.assertHoldAlive(reservation);

    let payment: Payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          reservationId: reservation.id,
          idempotencyKey,
          requestHash,
          status: PaymentStatus.PENDING,
          // 금액은 서버가 예매에서 읽는다 — 클라이언트 전달 금액은 신뢰하지 않는다
          amount: reservation.totalPrice,
          method: dto.method,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.resolveConflict(reservation, idempotencyKey, requestHash);
      }
      throw e;
    }

    return this.executeApproval(payment, reservation);
  }

  /**
   * INSERT 유니크 충돌의 분기 — 어느 제약에 걸렸는지에 따라 의미가 다르다.
   * ① idempotency_key UNIQUE: 같은 키의 동시 재시도 → 기존 결제의 결과를 재현
   * ② 부분 유니크(reservation_id WHERE PENDING/APPROVED): 다른 키로 같은 예매 결제 시도
   */
  private async resolveConflict(
    reservation: Reservation,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PayResult> {
    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey } });

    if (!existing) {
      // 키는 처음인데 충돌 → 같은 예매에 유효 결제(PENDING/APPROVED)가 이미 있다
      const active = await this.prisma.payment.findFirst({
        where: {
          reservationId: reservation.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.APPROVED] },
        },
      });
      if (active?.status === PaymentStatus.APPROVED) {
        throw Errors.alreadyPaid();
      }
      throw Errors.paymentInProgress();
    }

    return this.replayExisting(existing, reservation, requestHash);
  }

  /** 같은 키로 이미 존재하는 결제의 결과를 재실행 없이 재현한다 */
  private async replayExisting(
    existing: Payment,
    reservation: Reservation,
    requestHash: string,
  ): Promise<PayResult> {
    // 같은 키 + 다른 바디 = 키 재사용 실수. 조용히 캐시된 응답을 주면
    // 클라이언트는 "새 요청이 성공했다"고 오해한다 — 422로 명시적으로 거른다.
    if (existing.requestHash !== requestHash) {
      throw Errors.idempotencyKeyMismatch();
    }

    switch (existing.status) {
      case PaymentStatus.APPROVED:
      case PaymentStatus.CANCELED:
        // 첫 요청의 결과(승인, 또는 승인 후 환불된 상태)를 재실행 없이 반환
        return { payment: toView(existing), replayed: true };
      case PaymentStatus.FAILED:
        // 실패도 "첫 요청의 결과"다 — 같은 키로는 영원히 같은 실패를 재현하고,
        // 재시도는 새 키로 하게 한다(키 = 시도 1회의 식별자)
        throw Errors.paymentFailed();
      case PaymentStatus.PENDING: {
        const age = Date.now() - existing.updatedAt.getTime();
        if (age < PAYMENT_STALE_MS) {
          // 원 요청이 아직 PG 응답을 기다리는 중 — 동시 중복 실행을 차단한다
          throw Errors.paymentInProgress();
        }
        // 응답을 못 받고 죽은 결제 — 이 재시도가 PG 상태조회로 대신 마무리한다
        return this.finalizeFromPgStatus(existing, reservation);
      }
    }
  }

  /** PG 승인 호출 — 타임아웃이면 실패 단정 대신 상태조회 경로로 넘어간다 */
  private async executeApproval(payment: Payment, reservation: Reservation): Promise<PayResult> {
    let pgTxId: string;
    try {
      // 외부 호출은 DB 트랜잭션 밖에서 한다 — PG가 느려질 때 커넥션·행 잠금을
      // 붙들고 있으면 결제 지연이 예매 시스템 전체의 장애로 번진다(장애 격리).
      const approval = await this.pg.approve(payment.idempotencyKey, payment.amount, payment.method);
      pgTxId = approval.pgTxId;
    } catch (e) {
      if (e instanceof PgTimeoutError) {
        return this.finalizeFromPgStatus(payment, reservation);
      }
      // 명시적 거절 등 — 이 키의 결과를 FAILED로 기록하고 실패를 반환
      await this.markFailed(payment.id);
      throw Errors.paymentFailed();
    }
    return this.confirmApproved(payment, reservation, pgTxId);
  }

  /** 결과를 모르는 결제(타임아웃·정체된 PENDING)를 PG 기록 기준으로 마무리한다 */
  private async finalizeFromPgStatus(payment: Payment, reservation: Reservation): Promise<PayResult> {
    const status = await this.pg.getStatus(payment.idempotencyKey);
    if (status.status === 'APPROVED') {
      return this.confirmApproved(payment, reservation, status.pgTxId);
    }
    // PG에 거래 기록이 없다 = 승인은 일어나지 않았다 → 실패 확정 (돈은 안 나갔다)
    await this.markFailed(payment.id);
    throw Errors.paymentFailed();
  }

  /**
   * 승인된 결제의 확정 트랜잭션: 좌석 HELD→RESERVED 전이(조건부 UPDATE),
   * 확정 좌석 연결(reservation_seats) 생성, 예매 PENDING→CONFIRMED, 결제 APPROVED.
   * 하나라도 어긋나면 전체 롤백 — 부분 확정은 존재하지 않는다.
   */
  private async confirmApproved(
    payment: Payment,
    reservation: Reservation,
    pgTxId: string,
  ): Promise<PayResult> {
    try {
      const { finalPayment, seatIds } = await this.prisma.$transaction(async (tx) => {
        // 선점 만료 판정을 겸하는 조건부 UPDATE — WHERE가 곧 검증이다.
        // 만료돼 스위퍼가 회수했거나 다른 사용자가 넘겨받았으면 갱신 0건으로 드러난다.
        const seats = await tx.showSeat.updateManyAndReturn({
          where: {
            holdGroupId: reservation.holdGroupId,
            holdUserId: reservation.userId,
            status: SeatStatus.HELD,
            holdExpiresAt: { gt: new Date() },
          },
          data: {
            status: SeatStatus.RESERVED,
            holdUserId: null,
            holdGroupId: null,
            holdExpiresAt: null,
          },
        });
        // 예매 생성 시점의 좌석 수와 정확히 일치해야 한다 — "2석 중 1석만 확정"은
        // 트랜잭션 롤백으로 되돌리고 전체를 선점 만료로 처리한다
        if (seats.length !== reservation.seatCount) {
          throw Errors.holdExpired();
        }

        // 이중 판매 최후 방어선(부분 유니크 인덱스)이 지키는 확정 연결은 여기서 생긴다
        await tx.reservationSeat.createMany({
          data: seats.map((s) => ({ reservationId: reservation.id, showSeatId: s.id })),
        });

        // 결제 승인 사이에 예매가 취소됐을 수 있다 — 조건부 UPDATE로 원자 판정
        const transitioned = await tx.reservation.updateMany({
          where: { id: reservation.id, status: ReservationStatus.PENDING },
          data: { status: ReservationStatus.CONFIRMED },
        });
        if (transitioned.count !== 1) {
          throw Errors.reservationNotPayable();
        }

        const finalPayment = await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.APPROVED, pgTxId },
        });
        return { finalPayment, seatIds: seats.map((s) => s.id) };
      });

      // 확정된 좌석의 선점 TTL 키는 더 이상 의미가 없다 — 못 지워도 만료 알림이
      // 조건부 UPDATE(HELD가 아니므로 0건)로 무해하게 소멸한다
      await this.redis.tryExec('확정 좌석 TTL 키 삭제', (client) =>
        client.del(...seatIds.map((id) => holdKey(id))),
      );

      return { payment: toView(finalPayment), replayed: false };
    } catch (e) {
      if (e instanceof DomainException) {
        return this.compensate(payment, e);
      }
      throw e;
    }
  }

  /**
   * PG 승인은 났는데 좌석을 확정하지 못한 경우의 보상 처리.
   * 결제를 FAILED로 넘기는 데 성공한 쪽만 PG 취소(환불)를 실행한다 — 정체된 PENDING을
   * 동시에 복구하던 경쟁자가 이미 APPROVED로 확정했다면 그 결과를 그대로 재생해야 하며,
   * 여기서 PG를 취소하면 남의 성공한 결제를 환불하는 사고가 된다.
   */
  private async compensate(payment: Payment, cause: DomainException): Promise<PayResult> {
    const owned = await this.markFailed(payment.id);
    if (owned) {
      await this.pg.cancel(payment.idempotencyKey);
      this.logger.warn(
        `결제 보상 취소 — payment=${payment.id} 사유=${cause.code} (PG 승인 후 좌석 확정 실패)`,
      );
      throw cause;
    }
    const current = await this.prisma.payment.findUnique({ where: { id: payment.id } });
    if (current?.status === PaymentStatus.APPROVED) {
      return { payment: toView(current), replayed: true };
    }
    throw cause;
  }

  /** PENDING→FAILED 조건부 전이. true면 이 요청이 실패 확정의 소유자다 */
  private async markFailed(paymentId: bigint): Promise<boolean> {
    const updated = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED },
    });
    return updated.count === 1;
  }

  /** 선점 좌석이 전부 본인 소유로 살아있는지 — 죽었으면 409 HOLD_EXPIRED */
  private async assertHoldAlive(reservation: Reservation): Promise<void> {
    if (reservation.holdGroupId === null) {
      throw Errors.holdExpired();
    }
    const alive = await this.prisma.showSeat.count({
      where: {
        holdGroupId: reservation.holdGroupId,
        holdUserId: reservation.userId,
        status: SeatStatus.HELD,
        holdExpiresAt: { gt: new Date() },
      },
    });
    if (alive !== reservation.seatCount) {
      throw Errors.holdExpired();
    }
  }
}

/** 요청 바디 지문 — 필드 순서를 고정해 같은 내용이면 항상 같은 해시가 나온다 */
function hashRequest(dto: CreatePaymentDto): string {
  return createHash('sha256')
    .update(JSON.stringify({ reservationId: dto.reservationId, method: dto.method }))
    .digest('hex');
}

function toView(payment: Payment): PaymentView {
  return {
    paymentId: payment.id,
    reservationId: payment.reservationId,
    status: payment.status,
    amount: payment.amount,
    method: payment.method,
    pgTxId: payment.pgTxId,
  };
}
