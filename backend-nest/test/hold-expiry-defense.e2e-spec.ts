import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SeatStatus } from '@prisma/client';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { holdKey } from '../src/holds/hold-keys';
import { HOLD_SWEEPER_INTERVAL, HoldSweeperService } from '../src/holds/hold-sweeper.service';
import { httpJson } from './helpers/http';
import { createTestApp, seedAdmin, seedUsers, teardownTestApp, TestContext } from './helpers/test-app';

interface HoldResponse {
  holdGroupId: string;
  code?: string;
}

/**
 * 만료 3중 방어의 "각 층"을 분리해서 검증한다.
 * (층이 서로를 가려주면 어느 층이 실제로 일했는지 알 수 없다 — 그래서
 *  스위퍼 주기 실행은 끄고 시작하고, 각 테스트가 검증 대상 경로만 남긴다)
 *
 * ① 스위퍼: 만료 HELD를 회수하고, 중복 실행해도 안전(멱등)해야 한다
 * ② TTL 알림: 스위퍼 없이도 키 만료 즉시 좌석이 회수돼야 한다
 * ③ Redis 다운 폴백은 별도 describe — 부팅부터 Redis가 없는 앱으로 검증한다
 *
 * 참고: 이 스위트는 종료 직후 "Jest did not exit" 경고가 간헐적으로 뜰 수 있다.
 * 계측 결과 +1초 시점에 남는 핸들은 stdio뿐이며, 원인은 testcontainers의 도커
 * 데몬 소켓이 닫히는 타이밍(수백 ms 지연)이다 — 앱 코드의 누수가 아니다.
 */
describe('선점 만료 3중 방어 각개 검증 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  let showId: number;
  let seatIds: number[];
  let tokenA: string;
  let tokenB: string;

  async function forceExpire(targetSeatIds: number[]): Promise<void> {
    await prisma.showSeat.updateMany({
      where: { id: { in: targetSeatIds.map(BigInt) } },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
  }

  async function seatRow(seatId: number) {
    return prisma.showSeat.findUniqueOrThrow({ where: { id: BigInt(seatId) } });
  }

  async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    base = ctx.baseUrl;
    prisma = app.get(PrismaService);

    // 주기 실행을 제거해 "스위퍼가 몰래 회수해서 통과"하는 오염을 차단한다.
    // 스위퍼 로직 자체는 아래에서 직접 호출로 검증한다.
    app.get(SchedulerRegistry).deleteInterval(HOLD_SWEEPER_INTERVAL);

    const admin = await seedAdmin(app);
    const adminLogin = await httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });
    const adminToken = adminLogin.body.accessToken;

    const venue = await httpJson<{ id: number }>(base, 'POST', '/admin/venues', {
      token: adminToken,
      body: {
        name: '방어층 실험장',
        address: '서울',
        seats: [1, 2, 3, 4, 5, 6].map((n) => ({ section: 'A', rowNo: '1', seatNo: n })),
      },
    });
    const performance = await httpJson<{ id: number }>(base, 'POST', '/admin/performances', {
      token: adminToken,
      body: { title: '3중 방어 극장', venueId: venue.body.id },
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
      body: { prices: [{ section: 'A', price: 50000 }] },
    });
    const seatMap = await httpJson<{ seats: Array<{ id: number }> }>(
      base,
      'GET',
      `/shows/${showId}/seats`,
    );
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

  it('① 스위퍼는 만료 HELD만 회수하고, 재실행해도 안전하다(멱등)', async () => {
    const [expiredSeat1, expiredSeat2, aliveSeat] = seatIds;

    // 만료 2석 + 유효 1석 준비
    const holdExpired = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokenA,
      body: { seatIds: [expiredSeat1, expiredSeat2] },
    });
    expect(holdExpired.status).toBe(201);
    const holdAlive = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokenB,
      body: { seatIds: [aliveSeat] },
    });
    expect(holdAlive.status).toBe(201);
    await forceExpire([expiredSeat1, expiredSeat2]);

    const sweeper = app.get(HoldSweeperService);
    const reclaimed = await sweeper.sweep();
    expect(reclaimed).toBe(2);

    // 회수된 좌석: 상태와 선점 흔적이 모두 초기화된다
    for (const id of [expiredSeat1, expiredSeat2]) {
      const row = await seatRow(id);
      expect(row.status).toBe(SeatStatus.AVAILABLE);
      expect(row.holdUserId).toBeNull();
      expect(row.holdGroupId).toBeNull();
      expect(row.holdExpiresAt).toBeNull();
    }
    // 유효 선점은 건드리지 않는다
    expect((await seatRow(aliveSeat)).status).toBe(SeatStatus.HELD);

    // 멱등성: 서버 2대가 겹쳐 실행하는 상황과 동일한 재실행 — 0건, 부작용 없음
    expect(await sweeper.sweep()).toBe(0);
  });

  it('② TTL 알림은 스위퍼 없이도 만료 즉시 좌석을 회수한다 (빠른 경로)', async () => {
    const seat = seatIds[3];

    const hold = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token: tokenA,
      body: { seatIds: [seat] },
    });
    expect(hold.status).toBe(201);

    // 5분을 기다리는 대신: DB 만료시각을 과거로 되돌리고(회수 조건 충족),
    // Redis 키의 TTL만 250ms로 줄여 만료 이벤트를 곧 발생시킨다.
    await forceExpire([seat]);
    await app
      .get(RedisService)
      .tryExec('테스트 TTL 단축', (c) => c.set(holdKey(BigInt(seat)), 'test', 'PX', 250));

    // 주기 스위퍼는 beforeAll에서 제거됐다 — 회수됐다면 알림 리스너가 한 것이다
    const released = await waitFor(async () => (await seatRow(seat)).status === SeatStatus.AVAILABLE);
    expect(released).toBe(true);
    expect((await seatRow(seat)).holdUserId).toBeNull();
  });

});

/**
 * ③ Redis 완전 다운 — 부팅 시점부터 Redis가 없어도(접속 불가 주소) 앱이 뜨고,
 * 선점·해제·예매 확정이 DB만으로 전부 동작해야 한다. TTL 알림이라는 "빠른 경로"만
 * 잃고, 만료 회수는 스위퍼·lazy 판정이 이어받는다 — 기획서의 장애 시나리오 1번.
 */
describe('Redis 다운 폴백 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  let showId: number;
  let seatId: number;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp({ redis: false });
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
      body: { name: '무Redis 극장', address: '서울', seats: [{ section: 'A', rowNo: '1', seatNo: 1 }] },
    });
    const performance = await httpJson<{ id: number }>(base, 'POST', '/admin/performances', {
      token: adminToken,
      body: { title: '폴백 공연', venueId: venue.body.id },
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
      body: { prices: [{ section: 'A', price: 50000 }] },
    });
    const seatMap = await httpJson<{ seats: Array<{ id: number }> }>(
      base,
      'GET',
      `/shows/${showId}/seats`,
    );
    seatId = seatMap.body.seats[0].id;

    const [user] = await seedUsers(app, 1);
    const login = await httpJson<{ accessToken: string }>(base, 'POST', '/auth/login', {
      body: { email: user.email, password: user.password },
    });
    token = login.body.accessToken;
  }, 180000);

  afterAll(async () => {
    await teardownTestApp(ctx);
  });

  it('선점·해제·예매 생성이 전부 동작한다 (DB 폴백, 성능만 저하)', async () => {
    const hold = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token,
      body: { seatIds: [seatId] },
    });
    expect(hold.status).toBe(201);

    const release = await httpJson(base, 'DELETE', `/holds/${hold.body.holdGroupId}`, { token });
    expect(release.status).toBe(200);

    const holdAgain = await httpJson<HoldResponse>(base, 'POST', `/shows/${showId}/holds`, {
      token,
      body: { seatIds: [seatId] },
    });
    expect(holdAgain.status).toBe(201);
    const reservation = await httpJson<{ id: number; status: string }>(base, 'POST', '/reservations', {
      token,
      body: { holdGroupId: holdAgain.body.holdGroupId },
    });
    expect(reservation.status).toBe(201);
    expect(reservation.body.status).toBe('PENDING');

    // 좌석은 결제 전까지 HELD로 유지된다
    const row = await prisma.showSeat.findUniqueOrThrow({ where: { id: BigInt(seatId) } });
    expect(row.status).toBe(SeatStatus.HELD);
  });
});
