import { INestApplication } from '@nestjs/common';
import { httpJson } from './helpers/http';
import { createTestApp, seedAdmin, seedUsers, teardownTestApp, TestContext } from './helpers/test-app';

interface HoldResponse {
  holdGroupId: string;
  expiresAt: string;
  code?: string;
}

interface SeatMapResponse {
  seats: Array<{ id: number; status: string }>;
}

/**
 * 기획서 문제 2 — 선점 만료 처리: 유령 좌석 방지.
 *
 * 선점은 좌석을 HELD로 바꾸지만, "5분 뒤"라는 미래 시점에 되돌릴 주체가 없으면
 * 결제 없이 이탈한 좌석이 영구 HELD로 남는다(유령 좌석). 인기 공연이라면
 * 팔 수 있는 좌석이 조용히 사라지는 매출 사고다.
 *
 * 이 스펙이 고정하는 계약:
 *   1) 만료된 선점 좌석은 다른 사용자가 "즉시" 재선점할 수 있다
 *   2) 만료된 선점은 좌석맵에서 AVAILABLE로 보인다
 *   3) 만료된 선점으로는 예매를 확정할 수 없다
 *
 * 테스트는 5분을 기다리는 대신 hold_expires_at을 과거로 되돌려 만료를 재현한다.
 */
describe('선점 만료 — 유령 좌석 방지 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let base: string;

  let showId: number;
  let seatIds: number[];
  let tokenA: string;
  let tokenB: string;

  /** 지정 좌석의 선점 만료 시각을 과거로 되돌린다 — 시간 경과의 테스트 대역 */
  async function forceExpire(targetSeatIds: number[]): Promise<void> {
    const { PrismaService } = await import('../src/common/prisma/prisma.service');
    const prisma = app.get(PrismaService);
    await prisma.showSeat.updateMany({
      where: { id: { in: targetSeatIds.map(BigInt) } },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    base = ctx.baseUrl;

    const admin = await seedAdmin(app);
    const adminLogin = await httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });
    const adminToken = adminLogin.body.accessToken;

    const venue = await httpJson<{ id: number }>(base, 'POST', '/admin/venues', {
      token: adminToken,
      body: {
        name: '만료 실험장',
        address: '서울',
        seats: [1, 2, 3].map((n) => ({ section: 'A', rowNo: '1', seatNo: n })),
      },
    });
    const performance = await httpJson<{ id: number }>(base, 'POST', '/admin/performances', {
      token: adminToken,
      body: { title: '유령 좌석 극장', venueId: venue.body.id },
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
      body: { prices: [{ section: 'A', price: 80000 }] },
    });

    const seatMap = await httpJson<SeatMapResponse>(base, 'GET', `/shows/${showId}/seats`);
    seatIds = seatMap.body.seats.map((s) => s.id);

    const users = await seedUsers(app, 2);
    const [loginA, loginB] = await Promise.all(
      users.map((u) =>
        httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
          body: { email: u.email, password: u.password },
        }),
      ),
    );
    tokenA = loginA.body.accessToken;
    tokenB = loginB.body.accessToken;
  }, 180000);

  afterAll(async () => {
    await teardownTestApp(ctx);
  });

  it('만료된 선점 좌석은 다른 사용자가 즉시 재선점할 수 있다', async () => {
    const seat = seatIds[0];

    const holdA = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokenA,
      body: { seatIds: [seat] },
    });
    expect(holdA.status).toBe(201);

    // A가 결제 없이 이탈, 5분 경과
    await forceExpire([seat]);

    // 만료됐으므로 B가 곧바로 가져갈 수 있어야 한다 — 스위퍼 주기를 기다리게 해서는 안 된다
    const holdB = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokenB,
      body: { seatIds: [seat] },
    });
    expect(holdB.status).toBe(201);
    expect(holdB.body.holdGroupId).toBeDefined();
  });

  it('만료된 선점은 좌석맵에서 AVAILABLE로 보인다', async () => {
    const seat = seatIds[1];

    const holdA = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokenA,
      body: { seatIds: [seat] },
    });
    expect(holdA.status).toBe(201);
    await forceExpire([seat]);

    // 실제 회수(UPDATE)가 아직 안 됐더라도 사용자에게는 판매 가능 좌석이어야 한다
    const seatMap = await httpJson<SeatMapResponse>(base, 'GET', `/shows/${showId}/seats`);
    const entry = seatMap.body.seats.find((s) => s.id === seat);
    expect(entry?.status).toBe('AVAILABLE');
  });

  it('만료된 선점으로는 예매를 확정할 수 없다 (409 HOLD_EXPIRED)', async () => {
    const seat = seatIds[2];

    const holdA = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokenA,
      body: { seatIds: [seat] },
    });
    expect(holdA.status).toBe(201);
    await forceExpire([seat]);

    const reservation = await httpJson<{ code: string }>(base, 'POST', '/reservations', {
      token: tokenA,
      body: { holdGroupId: holdA.body.holdGroupId },
    });
    expect(reservation.status).toBe(409);
    expect(reservation.body.code).toBe('HOLD_EXPIRED');
  });
});
