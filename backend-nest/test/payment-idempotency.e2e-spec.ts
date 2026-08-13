import { INestApplication } from '@nestjs/common';
import { PaymentStatus, SeatStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { MockPgService, PgTimeoutError } from '../src/payments/mock-pg.service';
import { httpJson, JsonResponse } from './helpers/http';
import { createTestApp, seedAdmin, seedUsers, teardownTestApp, TestContext } from './helpers/test-app';

interface PaymentResponse {
  paymentId: number;
  reservationId: number;
  status: string;
  amount: number;
  pgTxId: string | null;
  code?: string;
}

/**
 * 실물 PG로는 재현할 수 없는 장애를 주입하는 확장 mock.
 * - timeoutNextApprove: 승인은 PG 쪽에 기록되지만 응답이 유실되는 상황
 *   (가맹점 입장에서 "됐는지 안 됐는지 모르는" 타임아웃)
 * - delayNextApproveMs: PG 왕복이 느려지는 상황 — 승인 도중 선점이 만료되는
 *   경합 구간을 테스트가 결정적으로 만들 수 있게 한다
 */
class FaultInjectablePg extends MockPgService {
  timeoutNextApprove = false;
  delayNextApproveMs = 0;

  override async approve(orderId: string, amount: number, method: string) {
    const delay = this.delayNextApproveMs;
    this.delayNextApproveMs = 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const result = await super.approve(orderId, amount, method);
    if (this.timeoutNextApprove) {
      this.timeoutNextApprove = false;
      throw new PgTimeoutError();
    }
    return result;
  }
}

/**
 * 결제 멱등성 계약 검증 (기획서 §6 대표 API, §7 문제 3).
 *
 * 계약:
 * - 같은 키 재요청 → 첫 요청의 결과를 재실행 없이 반환 (200)
 * - 같은 키 + 다른 바디 → 422 IDEMPOTENCY_KEY_MISMATCH
 * - 처리 중 동시 요청 → 409 PAYMENT_IN_PROGRESS
 * - 선점 만료 후 결제 → 409 HOLD_EXPIRED
 * - 타임아웃/크래시로 정체된 PENDING은 PG 상태조회로 복구
 */
describe('결제 멱등성 — 이중 결제 방지 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const pg = new FaultInjectablePg();

  let showId: number;
  let seatIds: number[];
  let nextSeat = 0;
  const tokens: string[] = [];

  const takeSeats = (n: number): number[] => seatIds.slice(nextSeat, (nextSeat += n));

  const pay = (
    token: string,
    key: string,
    body: unknown,
  ): Promise<JsonResponse<PaymentResponse>> =>
    httpJson<PaymentResponse>(base, 'POST', '/payments', {
      token,
      headers: { 'Idempotency-Key': key },
      body,
    });

  /** 선점 → PENDING 예매까지 만드는 지름길 — 각 테스트를 독립된 예매로 시작한다 */
  async function holdAndReserve(
    token: string,
    seats: number[],
  ): Promise<{ reservationId: number; holdGroupId: string; totalPrice: number }> {
    const hold = await httpJson<{ holdGroupId: string }>(base, 'POST', `/shows/${showId}/holds`, {
      token,
      body: { seatIds: seats },
    });
    expect(hold.status).toBe(201);
    const reservation = await httpJson<{ id: number; totalPrice: number }>(
      base,
      'POST',
      '/reservations',
      { token, body: { holdGroupId: hold.body.holdGroupId } },
    );
    expect(reservation.status).toBe(201);
    return {
      reservationId: reservation.body.id,
      holdGroupId: hold.body.holdGroupId,
      totalPrice: reservation.body.totalPrice,
    };
  }

  const seatStatuses = async (ids: number[]): Promise<string[]> => {
    const rows = await prisma.showSeat.findMany({ where: { id: { in: ids.map(BigInt) } } });
    return rows.map((r) => r.status);
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: MockPgService, useValue: pg }],
    });
    app = ctx.app;
    base = ctx.baseUrl;
    prisma = app.get(PrismaService);

    const admin = await seedAdmin(app);
    const adminLogin = await httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });
    const adminToken = adminLogin.body.accessToken;

    const venue = await httpJson<{ id: number }>(base, 'POST', '/admin/venues', {
      token: adminToken,
      body: {
        name: '멱등성 실험장',
        address: '서울',
        seats: Array.from({ length: 16 }, (_, i) => ({ section: 'A', rowNo: '1', seatNo: i + 1 })),
      },
    });
    const performance = await httpJson<{ id: number }>(base, 'POST', '/admin/performances', {
      token: adminToken,
      body: { title: '결제 실험 콘서트', venueId: venue.body.id },
    });
    const show = await httpJson<{ id: number }>(base, 'POST', '/admin/shows', {
      token: adminToken,
      body: {
        performanceId: performance.body.id,
        startsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        ticketOpenAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      },
    });
    showId = show.body.id;
    await httpJson(base, 'POST', `/admin/shows/${showId}/seats`, {
      token: adminToken,
      body: { prices: [{ section: 'A', price: 100000 }] },
    });
    const seatMap = await httpJson<{ seats: Array<{ id: number }> }>(
      base,
      'GET',
      `/shows/${showId}/seats`,
    );
    seatIds = seatMap.body.seats.map((s) => s.id);

    const users = await seedUsers(app, 3);
    for (const u of users) {
      const login = await httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
        body: { email: u.email, password: u.password },
      });
      tokens.push(login.body.accessToken);
    }
  }, 180000);

  afterAll(async () => {
    await teardownTestApp(ctx);
  });

  it('Idempotency-Key 헤더가 없거나 UUID가 아니면 400 — 키 없는 결제는 계약 위반', async () => {
    const { reservationId } = await holdAndReserve(tokens[0], takeSeats(1));

    const missing = await httpJson<{ code: string }>(base, 'POST', '/payments', {
      token: tokens[0],
      body: { reservationId, method: 'CARD' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const malformed = await pay(tokens[0], 'not-a-uuid', { reservationId, method: 'CARD' });
    expect(malformed.status).toBe(400);
  });

  it('같은 키 재요청은 200으로 첫 결과를 재생하고, 결제 레코드는 1건만 생긴다', async () => {
    const { reservationId } = await holdAndReserve(tokens[0], takeSeats(1));
    const key = randomUUID();

    const first = await pay(tokens[0], key, { reservationId, method: 'CARD' });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('APPROVED');

    const replay = await pay(tokens[0], key, { reservationId, method: 'CARD' });
    expect(replay.status).toBe(200);
    expect(replay.body.paymentId).toBe(first.body.paymentId);
    expect(replay.body.pgTxId).toBe(first.body.pgTxId);

    const count = await prisma.payment.count({ where: { reservationId: BigInt(reservationId) } });
    expect(count).toBe(1);
  });

  it('같은 키 + 다른 바디는 422 — 캐시된 응답을 조용히 돌려주면 안 된다', async () => {
    const { reservationId } = await holdAndReserve(tokens[0], takeSeats(1));
    const other = await holdAndReserve(tokens[0], takeSeats(1));
    const key = randomUUID();

    await pay(tokens[0], key, { reservationId, method: 'CARD' });

    const mismatch = await pay(tokens[0], key, {
      reservationId: other.reservationId,
      method: 'CARD',
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('같은 키 동시 10발 — 결제 실행은 정확히 1번, 나머지는 처리중(409) 또는 재생(200)', async () => {
    const { reservationId } = await holdAndReserve(tokens[0], takeSeats(2));
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => pay(tokens[0], key, { reservationId, method: 'CARD' })),
    );

    const distribution = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[동시 결제 분포] ${JSON.stringify(distribution)}`);

    // 201(실행됨)은 정확히 1건 — 2건 이상이면 이중 결제다
    const executed = responses.filter((r) => r.status === 201);
    expect(executed).toHaveLength(1);
    // 나머지는 "처리 중"(409) 또는 완료 후 재생(200) — 둘 다 재실행 없음
    for (const r of responses) {
      expect([200, 201, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.code).toBe('PAYMENT_IN_PROGRESS');
      if (r.status === 200) expect(r.body.pgTxId).toBe(executed[0].body.pgTxId);
    }

    // 최종 상태: 결제 1건, 처리중이던 요청도 재시도하면 같은 결과를 200으로 받는다
    const count = await prisma.payment.count({ where: { reservationId: BigInt(reservationId) } });
    expect(count).toBe(1);
    const retry = await pay(tokens[0], key, { reservationId, method: 'CARD' });
    expect(retry.status).toBe(200);
    expect(retry.body.pgTxId).toBe(executed[0].body.pgTxId);
  });

  it('이미 결제된 예매에 다른 키로 결제하면 409 ALREADY_PAID', async () => {
    const { reservationId } = await holdAndReserve(tokens[0], takeSeats(1));
    await pay(tokens[0], randomUUID(), { reservationId, method: 'CARD' });

    const second = await pay(tokens[0], randomUUID(), { reservationId, method: 'CARD' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_PAID');
  });

  it('남의 예매 결제 시도는 404 — 예매 존재 여부조차 노출하지 않는다', async () => {
    const victim = await holdAndReserve(tokens[0], takeSeats(1));
    const victimKey = randomUUID();
    await pay(tokens[0], victimKey, { reservationId: victim.reservationId, method: 'CARD' });

    // 공격자가 피해자의 예매 ID를 알아내도 404 (IDOR 차단)
    const probe = await pay(tokens[1], randomUUID(), {
      reservationId: victim.reservationId,
      method: 'CARD',
    });
    expect(probe.status).toBe(404);

    // 피해자의 키를 탈취해 자기 예매에 재사용해도 바디 지문이 달라 422
    const own = await holdAndReserve(tokens[1], takeSeats(1));
    const reuse = await pay(tokens[1], victimKey, {
      reservationId: own.reservationId,
      method: 'CARD',
    });
    expect(reuse.status).toBe(422);
  });

  it('선점 만료 후 결제는 409 HOLD_EXPIRED — PG 호출 전에 끊는다', async () => {
    const seats = takeSeats(1);
    const { reservationId, holdGroupId } = await holdAndReserve(tokens[0], seats);

    // 선점 만료를 강제로 재현 (5분 대기 대신 만료시각을 과거로)
    await prisma.$executeRaw`
      UPDATE show_seats SET hold_expires_at = now() - interval '1 second'
       WHERE hold_group_id = ${holdGroupId}::uuid`;

    const expired = await pay(tokens[0], randomUUID(), { reservationId, method: 'CARD' });
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('HOLD_EXPIRED');

    // PG 호출 전에 차단됐으므로 결제 레코드 자체가 없어야 한다
    const count = await prisma.payment.count({ where: { reservationId: BigInt(reservationId) } });
    expect(count).toBe(0);
  });

  it('승인 도중 선점이 만료되면 보상 취소(환불)하고 409 — 돈만 나가는 상태를 남기지 않는다', async () => {
    const seats = takeSeats(1);
    const { reservationId, holdGroupId } = await holdAndReserve(tokens[0], seats);
    const key = randomUUID();

    // PG 왕복을 500ms로 늦춰, 승인이 진행되는 동안 선점이 만료되는 경합을 재현
    pg.delayNextApproveMs = 500;
    const inFlight = pay(tokens[0], key, { reservationId, method: 'CARD' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await prisma.$executeRaw`
      UPDATE show_seats SET hold_expires_at = now() - interval '1 second'
       WHERE hold_group_id = ${holdGroupId}::uuid`;

    const result = await inFlight;
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('HOLD_EXPIRED');

    // 결제는 FAILED로 확정되고, PG 승인 건은 취소(환불)돼 기록이 없어야 한다
    const payment = await prisma.payment.findUnique({ where: { idempotencyKey: key } });
    expect(payment?.status).toBe(PaymentStatus.FAILED);
    expect(await pg.getStatus(key)).toEqual({ status: 'NOT_FOUND' });

    // 좌석은 확정되지 않았다 — RESERVED가 아니어야 한다
    const statuses = await seatStatuses(seats);
    expect(statuses.every((s) => s !== SeatStatus.RESERVED)).toBe(true);
  });

  it('PG 타임아웃(승인은 기록됨) → 상태조회로 복구해 결제를 확정한다', async () => {
    const seats = takeSeats(1);
    const { reservationId } = await holdAndReserve(tokens[0], seats);
    const key = randomUUID();

    // 승인은 PG에 도달했지만 응답이 유실되는 상황 — 실패로 단정하면 고객 돈만 나간다
    pg.timeoutNextApprove = true;
    const result = await pay(tokens[0], key, { reservationId, method: 'CARD' });

    expect(result.status).toBe(201);
    expect(result.body.status).toBe('APPROVED');
    const statuses = await seatStatuses(seats);
    expect(statuses.every((s) => s === SeatStatus.RESERVED)).toBe(true);
  });

  it('정체된 PENDING(크래시 흔적)은 재시도가 PG 상태조회로 마무리한다 — 승인 기록 없으면 FAILED', async () => {
    const { reservationId, totalPrice } = await holdAndReserve(tokens[0], takeSeats(1));
    const key = randomUUID();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ reservationId, method: 'CARD' }))
      .digest('hex');

    // "INSERT 후 PG 응답 전에 프로세스가 죽은" 흔적을 직접 심는다
    const stale = await prisma.payment.create({
      data: {
        reservationId: BigInt(reservationId),
        idempotencyKey: key,
        requestHash,
        status: PaymentStatus.PENDING,
        amount: totalPrice,
        method: 'CARD',
      },
    });
    await prisma.$executeRaw`
      UPDATE payments SET updated_at = now() - interval '60 seconds' WHERE id = ${stale.id}`;

    // 같은 키 재시도 → PG에 승인 기록이 없으므로 FAILED 확정 (돈은 나가지 않았다)
    const retry = await pay(tokens[0], key, { reservationId, method: 'CARD' });
    expect(retry.status).toBe(402);
    expect(retry.body.code).toBe('PAYMENT_FAILED');

    // 같은 키의 이후 요청도 같은 실패를 재현한다 (키 = 시도 1회의 식별자)
    const again = await pay(tokens[0], key, { reservationId, method: 'CARD' });
    expect(again.status).toBe(402);

    // FAILED는 부분 유니크 인덱스 범위 밖 — 새 키로는 정상 결제된다
    const fresh = await pay(tokens[0], randomUUID(), { reservationId, method: 'CARD' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.status).toBe('APPROVED');
  });
});
