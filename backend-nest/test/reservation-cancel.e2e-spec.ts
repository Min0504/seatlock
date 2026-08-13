import { INestApplication } from '@nestjs/common';
import { PaymentStatus, ReservationStatus, SeatStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { MockPgService } from '../src/payments/mock-pg.service';
import { FaultInjectablePg } from './helpers/fault-injectable-pg';
import { httpJson, JsonResponse } from './helpers/http';
import { createTestApp, seedAdmin, seedUsers, teardownTestApp, TestContext } from './helpers/test-app';

interface CancelResponse {
  id: number;
  status: string;
  releasedSeats: number;
  code?: string;
}

/**
 * 예매 취소 검증 (기획서 §3 예매 취소, 장애 시나리오 5 — 취소와 신규 선점의 경합).
 *
 * 취소는 결제와 반대 방향의 상태 전이라 경합 상대가 많다: 이중 취소, 취소 직후
 * 신규 선점, 승인 중인 결제. 전부 조건부 UPDATE의 0건 판정으로 직렬화되는지 본다.
 */
describe('예매 취소 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const pg = new FaultInjectablePg();

  let adminToken: string;
  let performanceId: number;
  let showId: number;
  let seatIds: number[];
  let nextSeat = 0;
  const tokens: string[] = [];

  const takeSeats = (n: number): number[] => seatIds.slice(nextSeat, (nextSeat += n));

  const cancel = (token: string, reservationId: number): Promise<JsonResponse<CancelResponse>> =>
    httpJson<CancelResponse>(base, 'DELETE', `/reservations/${reservationId}`, { token });

  const pay = (token: string, key: string, reservationId: number) =>
    httpJson<{ status: string; code?: string }>(base, 'POST', '/payments', {
      token,
      headers: { 'Idempotency-Key': key },
      body: { reservationId, method: 'CARD' },
    });

  async function holdAndReserve(
    token: string,
    seats: number[],
    targetShowId = showId,
  ): Promise<{ reservationId: number; holdGroupId: string }> {
    const hold = await httpJson<{ holdGroupId: string }>(
      base,
      'POST',
      `/shows/${targetShowId}/holds`,
      { token, body: { seatIds: seats } },
    );
    expect(hold.status).toBe(201);
    const reservation = await httpJson<{ id: number }>(base, 'POST', '/reservations', {
      token,
      body: { holdGroupId: hold.body.holdGroupId },
    });
    expect(reservation.status).toBe(201);
    return { reservationId: reservation.body.id, holdGroupId: hold.body.holdGroupId };
  }

  /** 결제까지 끝난 CONFIRMED 예매를 만든다 */
  async function confirmedReservation(
    token: string,
    seats: number[],
  ): Promise<{ reservationId: number; paymentKey: string }> {
    const { reservationId } = await holdAndReserve(token, seats);
    const paymentKey = randomUUID();
    const paid = await pay(token, paymentKey, reservationId);
    expect(paid.status).toBe(201);
    return { reservationId, paymentKey };
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
    adminToken = adminLogin.body.accessToken;

    const venue = await httpJson<{ id: number }>(base, 'POST', '/admin/venues', {
      token: adminToken,
      body: {
        name: '취소 실험장',
        address: '서울',
        seats: Array.from({ length: 16 }, (_, i) => ({ section: 'A', rowNo: '1', seatNo: i + 1 })),
      },
    });
    const performance = await httpJson<{ id: number }>(base, 'POST', '/admin/performances', {
      token: adminToken,
      body: { title: '취소 실험 콘서트', venueId: venue.body.id },
    });
    performanceId = performance.body.id;
    const show = await httpJson<{ id: number }>(base, 'POST', '/admin/shows', {
      token: adminToken,
      body: {
        performanceId,
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

  it('결제 완료 예매 취소 — 좌석 원복·연결 이력화·결제 CANCELED·환불까지 한 번에', async () => {
    const seats = takeSeats(2);
    const { reservationId, paymentKey } = await confirmedReservation(tokens[0], seats);

    const result = await cancel(tokens[0], reservationId);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('CANCELED');
    expect(result.body.releasedSeats).toBe(2);

    // 좌석은 판매 가능으로 원복
    expect(await seatStatuses(seats)).toEqual([SeatStatus.AVAILABLE, SeatStatus.AVAILABLE]);
    // 확정 연결은 삭제가 아니라 취소 이력으로 남는다 — 부분 유니크(WHERE canceled=false)에서 빠진다
    const links = await prisma.reservationSeat.findMany({
      where: { reservationId: BigInt(reservationId) },
    });
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.canceled)).toBe(true);
    // 결제는 CANCELED, PG 거래는 취소(환불)돼 기록이 사라진다
    const payment = await prisma.payment.findUnique({ where: { idempotencyKey: paymentKey } });
    expect(payment?.status).toBe(PaymentStatus.CANCELED);
    expect(await pg.getStatus(paymentKey)).toEqual({ status: 'NOT_FOUND' });

    // 취소된 좌석은 다른 사용자가 즉시 선점·구매할 수 있다 (재판매 — 부분 유니크가 허용)
    const rebuy = await holdAndReserve(tokens[1], seats);
    const repaid = await pay(tokens[1], randomUUID(), rebuy.reservationId);
    expect(repaid.status).toBe(201);
  });

  it('반복 취소는 멱등 — 두 번째 DELETE도 200이고 좌석을 건드리지 않는다', async () => {
    const seats = takeSeats(1);
    const { reservationId } = await confirmedReservation(tokens[0], seats);

    const first = await cancel(tokens[0], reservationId);
    expect(first.status).toBe(200);
    expect(first.body.releasedSeats).toBe(1);

    // 그 사이 다른 사용자가 좌석을 선점해도, 반복 취소가 그 선점을 훼손하면 안 된다
    const hold = await httpJson<{ holdGroupId: string }>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokens[1],
      body: { seatIds: seats },
    });
    expect(hold.status).toBe(201);

    const second = await cancel(tokens[0], reservationId);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('CANCELED');
    expect(second.body.releasedSeats).toBe(0);
    expect(await seatStatuses(seats)).toEqual([SeatStatus.HELD]);
  });

  it('공연 24시간 이내에는 취소할 수 없다 (409 CANCEL_WINDOW_CLOSED)', async () => {
    // 23시간 뒤 시작하는 회차 — 취소 마감선(24h)을 이미 넘었다
    const soonShow = await httpJson<{ id: number }>(base, 'POST', '/admin/shows', {
      token: adminToken,
      body: {
        performanceId,
        startsAt: new Date(Date.now() + 23 * 3600 * 1000).toISOString(),
        ticketOpenAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      },
    });
    await httpJson(base, 'POST', `/admin/shows/${soonShow.body.id}/seats`, {
      token: adminToken,
      body: { prices: [{ section: 'A', price: 50000 }] },
    });
    const seatMap = await httpJson<{ seats: Array<{ id: number }> }>(
      base,
      'GET',
      `/shows/${soonShow.body.id}/seats`,
    );

    const { reservationId } = await holdAndReserve(
      tokens[0],
      [seatMap.body.seats[0].id],
      soonShow.body.id,
    );
    const paid = await pay(tokens[0], randomUUID(), reservationId);
    expect(paid.status).toBe(201);

    const result = await cancel(tokens[0], reservationId);
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('CANCEL_WINDOW_CLOSED');
    // 예매·좌석 모두 그대로여야 한다
    const reservation = await prisma.reservation.findUnique({
      where: { id: BigInt(reservationId) },
    });
    expect(reservation?.status).toBe(ReservationStatus.CONFIRMED);
  });

  it('미결제(PENDING) 예매 취소는 선점을 즉시 반납하고, 그 예매로는 결제할 수 없다', async () => {
    const seats = takeSeats(1);
    const { reservationId } = await holdAndReserve(tokens[0], seats);

    const result = await cancel(tokens[0], reservationId);
    expect(result.status).toBe(200);
    expect(result.body.releasedSeats).toBe(1);
    expect(await seatStatuses(seats)).toEqual([SeatStatus.AVAILABLE]);

    const late = await pay(tokens[0], randomUUID(), reservationId);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('RESERVATION_NOT_PAYABLE');
  });

  it('남의 예매 취소 시도는 404 — 존재 여부조차 노출하지 않는다', async () => {
    const { reservationId } = await confirmedReservation(tokens[0], takeSeats(1));

    const probe = await cancel(tokens[1], reservationId);
    expect(probe.status).toBe(404);

    const reservation = await prisma.reservation.findUnique({
      where: { id: BigInt(reservationId) },
    });
    expect(reservation?.status).toBe(ReservationStatus.CONFIRMED);
  });

  it('승인 진행 중에 취소가 끼어들면 결제는 롤백 + 보상 취소된다 (취소 승리)', async () => {
    const seats = takeSeats(1);
    const { reservationId } = await holdAndReserve(tokens[0], seats);
    const key = randomUUID();

    // PG 왕복을 늦춰 "승인 중" 상태를 만들고, 그 틈에 예매를 취소한다
    pg.delayNextApproveMs = 500;
    const inFlightPay = pay(tokens[0], key, reservationId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const canceled = await cancel(tokens[0], reservationId);
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('CANCELED');

    // 결제는 좌석 확정에 실패해 실패 확정 + PG 승인 취소(환불)
    const payResult = await inFlightPay;
    expect(payResult.status).toBe(409);
    const payment = await prisma.payment.findUnique({ where: { idempotencyKey: key } });
    expect(payment?.status).toBe(PaymentStatus.FAILED);
    expect(await pg.getStatus(key)).toEqual({ status: 'NOT_FOUND' });

    // 최종 상태: 예매 CANCELED, 좌석은 반납됨
    const reservation = await prisma.reservation.findUnique({
      where: { id: BigInt(reservationId) },
    });
    expect(reservation?.status).toBe(ReservationStatus.CANCELED);
    expect(await seatStatuses(seats)).toEqual([SeatStatus.AVAILABLE]);
  });
});
