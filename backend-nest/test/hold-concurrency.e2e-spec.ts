import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { httpJson } from './helpers/http';
import { createTestApp, seedAdmin, seedUsers } from './helpers/test-app';

interface SeatMapResponse {
  seats: Array<{ id: number; status: string }>;
}

/**
 * 이 프로젝트의 존재 증명 — 동일 좌석 동시 선점 테스트.
 *
 * 시나리오: 좌석 1개를 서로 다른 사용자 100명이 동시에 선점 요청한다.
 * 요구 불변식: 성공은 정확히 1건, 나머지 99건은 409 SEAT_ALREADY_TAKEN.
 *
 * check-then-act 구현(v1)에서는 여러 트랜잭션이 같은 좌석을 동시에
 * AVAILABLE로 읽기 때문에 성공이 2건 이상 발생한다(초과판매 재현).
 */
describe('동일 좌석 동시 선점 — 초과판매 방지 (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let base: string;

  let showId: number;
  let seatMapIds: number[];

  const USERS = 100;
  const userTokens: string[] = [];

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    container = ctx.container;
    base = ctx.baseUrl;

    const admin = await seedAdmin(app);
    const adminLogin = await httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.body.accessToken;

    // 좌석 4개짜리 회차 준비
    const venue = await httpJson<{ id: number }>(base, 'POST', '/admin/venues', {
      token: adminToken,
      body: {
        name: '동시성 실험장',
        address: '서울',
        seats: [1, 2, 3, 4].map((n) => ({ section: 'A', rowNo: '1', seatNo: n })),
      },
    });
    const performance = await httpJson<{ id: number }>(base, 'POST', '/admin/performances', {
      token: adminToken,
      body: { title: '매진 임박 콘서트', venueId: venue.body.id },
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

    const seatMap = await httpJson<SeatMapResponse>(base, 'GET', `/shows/${showId}/seats`);
    seatMapIds = seatMap.body.seats.map((s) => s.id);

    // 사용자 100명 준비 후 병렬 로그인 (선점 API는 인증 필수)
    const users = await seedUsers(app, USERS);
    const logins = await Promise.all(
      users.map((u) =>
        httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
          body: { email: u.email, password: u.password },
        }),
      ),
    );
    for (const login of logins) {
      expect(login.status).toBe(200);
      userTokens.push(login.body.accessToken);
    }
  }, 180000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it(`같은 좌석에 ${USERS}명이 동시 선점 요청하면 성공은 정확히 1건이어야 한다`, async () => {
    const targetSeatId = seatMapIds[0];

    const responses = await Promise.all(
      userTokens.map((token) =>
        httpJson<{ code?: string }>(base, 'POST', `/shows/${showId}/holds`, {
          token,
          body: { seatIds: [targetSeatId] },
        }),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    // 실패 시 원인 분석이 가능하도록 응답 분포를 남긴다
    const distribution = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    // eslint-disable-next-line no-console
    console.log(`[동시 선점 분포] ${JSON.stringify(distribution)} — 성공 ${successes.length}건`);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(USERS - 1);
    expect(conflicts.every((r) => r.body.code === 'SEAT_ALREADY_TAKEN')).toBe(true);

    // DB 최종 상태 검증: HELD는 정확히 1좌석
    const seatMap = await httpJson<SeatMapResponse>(base, 'GET', `/shows/${showId}/seats`);
    const held = seatMap.body.seats.filter((s) => s.status === 'HELD');
    expect(held).toHaveLength(1);
    expect(held[0].id).toBe(targetSeatId);
  });

  it('여러 좌석 중 하나라도 실패하면 그룹 전체가 롤백된다 (부분 선점 금지)', async () => {
    const [, seatB, seatC] = seatMapIds;

    // 사용자0이 seatB를 먼저 선점
    const first = await httpJson(base, 'POST', `/shows/${showId}/holds`, {
      token: userTokens[0],
      body: { seatIds: [seatB] },
    });
    expect(first.status).toBe(201);

    // 사용자1이 [seatB, seatC]를 요청 → seatB 충돌로 전체 실패해야 한다
    const conflict = await httpJson<{ code: string }>(base, 'POST', `/shows/${showId}/holds`, {
      token: userTokens[1],
      body: { seatIds: [seatB, seatC] },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('SEAT_ALREADY_TAKEN');

    // seatC는 여전히 AVAILABLE — "2좌석 중 1좌석만 잡힘"이 없어야 한다
    const seatMap = await httpJson<SeatMapResponse>(base, 'GET', `/shows/${showId}/seats`);
    const seatCState = seatMap.body.seats.find((s) => s.id === seatC);
    expect(seatCState?.status).toBe('AVAILABLE');
  });
});
