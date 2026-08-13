import { INestApplication } from '@nestjs/common';
import { SeatStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PerformanceListCacheService } from '../src/performances/performance-list-cache.service';
import { SeatMapCacheService } from '../src/shows/seat-map-cache.service';
import { createTestApp, seedAdmin, teardownTestApp, TestContext } from './helpers/test-app';

/**
 * 읽기 경로 성능 3종 검증 — 기획서 §9(캐시 전략)·§4(공연 검색, 관리자 판매 통계).
 *
 * 캐시 테스트의 공통 기법: "DB를 직접 바꿔도 응답이 안 바뀌면 캐시가 일하고 있는 것".
 * 캐시 히트는 응답만 보면 미스와 구분되지 않으므로, 무효화를 우회한 변경(직접 UPDATE)이
 * 보이지 않는 것으로 히트를 증명하고, 무효화 후 보이는 것으로 정합 복구를 증명한다.
 */
describe('좌석맵 캐시·pg_trgm 검색·판매 통계 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    const admin = await seedAdmin(app);
    const adminLogin = await request(server)
      .post('/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    adminToken = adminLogin.body.accessToken;

    await request(server)
      .post('/auth/signup')
      .send({ email: 'cache-user@test.com', password: 'password1234' })
      .expect(201);
    const userLogin = await request(server)
      .post('/auth/login')
      .send({ email: 'cache-user@test.com', password: 'password1234' })
      .expect(200);
    userToken = userLogin.body.accessToken;
  });

  afterAll(async () => {
    await teardownTestApp(ctx);
  });

  // ── 카탈로그 생성 헬퍼 ──────────────────────────────────────────────

  async function createVenue(name: string, seatCount: number): Promise<number> {
    const res = await request(server)
      .post('/admin/venues')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name,
        address: '서울시 어딘가',
        seats: Array.from({ length: seatCount }, (_, i) => ({
          section: 'A',
          rowNo: '1',
          seatNo: i + 1,
        })),
      })
      .expect(201);
    return res.body.id as number;
  }

  async function createPerformance(
    venueId: number,
    title: string,
    description?: string,
  ): Promise<number> {
    const res = await request(server)
      .post('/admin/performances')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title, description, venueId })
      .expect(201);
    return res.body.id as number;
  }

  async function createShowWithSeats(performanceId: number, price: number): Promise<number> {
    const show = await request(server)
      .post('/admin/shows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        performanceId,
        startsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        ticketOpenAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      })
      .expect(201);
    await request(server)
      .post(`/admin/shows/${show.body.id}/seats`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prices: [{ section: 'A', price }] })
      .expect(201);
    return show.body.id as number;
  }

  async function getSeatMap(showId: number): Promise<Array<{ id: number; status: string }>> {
    const res = await request(server).get(`/shows/${showId}/seats`).expect(200);
    return res.body.seats;
  }

  // ── 1. 좌석맵 캐시 ──────────────────────────────────────────────────

  describe('좌석맵 캐시 (TTL 5s + 쓰기 시 무효화)', () => {
    let showId: number;

    beforeAll(async () => {
      const venueId = await createVenue('캐시 검증 홀', 3);
      const perfId = await createPerformance(venueId, '캐시 검증 공연');
      showId = await createShowWithSeats(perfId, 50000);
    });

    it('조회 결과가 캐시에서 나온다 — 무효화를 우회한 DB 변경은 보이지 않는다', async () => {
      const first = await getSeatMap(showId);
      expect(first.every((s) => s.status === 'AVAILABLE')).toBe(true);

      // 서비스 계층을 우회한 직접 UPDATE — 무효화가 일어나지 않는 유일한 경로
      await prisma.showSeat.update({
        where: { id: BigInt(first[0].id) },
        data: { status: SeatStatus.RESERVED },
      });

      // 여전히 전석 AVAILABLE = 응답이 DB가 아니라 캐시에서 왔다는 증거
      const stale = await getSeatMap(showId);
      expect(stale.every((s) => s.status === 'AVAILABLE')).toBe(true);

      // 무효화하면 즉시 최신 상태가 보인다
      await app.get(SeatMapCacheService).invalidate(showId);
      const fresh = await getSeatMap(showId);
      expect(fresh.find((s) => s.id === first[0].id)?.status).toBe('RESERVED');

      // 원상 복구
      await prisma.showSeat.update({
        where: { id: BigInt(first[0].id) },
        data: { status: SeatStatus.AVAILABLE },
      });
      await app.get(SeatMapCacheService).invalidate(showId);
    });

    it('선점과 해제가 캐시를 무효화한다 — TTL을 기다리지 않고 즉시 반영된다', async () => {
      const before = await getSeatMap(showId); // 캐시를 심는다
      const target = before.find((s) => s.status === 'AVAILABLE');
      expect(target).toBeDefined();
      const targetId = (target as { id: number }).id;

      const hold = await request(server)
        .post(`/shows/${showId}/holds`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ seatIds: [targetId] })
        .expect(201);

      // 캐시 TTL(5초)이 남아 있어도 HELD가 즉시 보인다 = 선점이 무효화를 수행했다
      const afterHold = await getSeatMap(showId);
      expect(afterHold.find((s) => s.id === targetId)?.status).toBe('HELD');

      await request(server)
        .delete(`/holds/${hold.body.holdGroupId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const afterRelease = await getSeatMap(showId);
      expect(afterRelease.find((s) => s.id === targetId)?.status).toBe('AVAILABLE');
    });

    it('무효화가 없어도 TTL(5초)이 지나면 최신 상태로 수렴한다', async () => {
      const first = await getSeatMap(showId); // 캐시를 심는다
      const seatId = first[0].id;
      await prisma.showSeat.update({
        where: { id: BigInt(seatId) },
        data: { status: SeatStatus.RESERVED },
      });

      // TTL 안: 캐시가 옛 상태를 답한다 (의도된 최대 5초의 신선도 창)
      const withinTtl = await getSeatMap(showId);
      expect(withinTtl.find((s) => s.id === seatId)?.status).toBe('AVAILABLE');

      await new Promise((r) => setTimeout(r, (SeatMapCacheService.TTL_SECONDS + 1) * 1000));

      const afterTtl = await getSeatMap(showId);
      expect(afterTtl.find((s) => s.id === seatId)?.status).toBe('RESERVED');

      // 원상 복구
      await prisma.showSeat.update({
        where: { id: BigInt(seatId) },
        data: { status: SeatStatus.AVAILABLE },
      });
      await app.get(SeatMapCacheService).invalidate(showId);
    }, 30000);
  });

  // ── 2. pg_trgm 검색 ────────────────────────────────────────────────

  describe('공연 검색 (pg_trgm — 중간 일치도 인덱스를 탄다)', () => {
    let searchVenueId: number;

    beforeAll(async () => {
      searchVenueId = await createVenue('검색 검증 홀', 1);
      await createPerformance(searchVenueId, '오페라의 유령', '앤드루 로이드 웨버 걸작, 출연: 김성우');
      await createPerformance(searchVenueId, '팬텀: 디 오페라', '출연: 홍길동, 김민지');
      await createPerformance(searchVenueId, '레미제라블', '출연: 박정현');
      await createPerformance(searchVenueId, 'Hamilton', 'An American Musical');
    });

    it('제목 중간 일치로 검색된다 (선행 와일드카드 LIKE)', async () => {
      const res = await request(server).get('/performances?q=오페라').expect(200);
      const titles = res.body.items.map((i: { title: string }) => i.title);
      expect(titles).toContain('오페라의 유령');
      expect(titles).toContain('팬텀: 디 오페라');
      expect(titles).not.toContain('레미제라블');
    });

    it('제목만이 아니라 설명(출연진)도 검색 대상이다', async () => {
      const res = await request(server).get('/performances?q=홍길동').expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].title).toBe('팬텀: 디 오페라');
    });

    it('대소문자를 무시한다 (ILIKE)', async () => {
      const res = await request(server).get('/performances?q=hamilton').expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].title).toBe('Hamilton');
    });

    it('검색 결과에도 커서 페이지네이션이 적용된다 (중복·누락 없음)', async () => {
      const page1 = await request(server).get('/performances?q=오페라&size=1').expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toBeTruthy();

      const page2 = await request(server)
        .get(`/performances?q=오페라&size=1&cursor=${page1.body.nextCursor}`)
        .expect(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
      expect(page2.body.nextCursor).toBeNull();

      const both = new Set([page1.body.items[0].title, page2.body.items[0].title]);
      expect(both).toEqual(new Set(['오페라의 유령', '팬텀: 디 오페라']));
    });

    it('ILIKE 검색이 GIN(gin_trgm_ops) 인덱스를 사용할 수 있다 (EXPLAIN 검증)', async () => {
      // 소규모 테이블에서는 플래너가 seq scan을 선호하므로 seqscan을 꺼서
      // "이 연산자가 이 인덱스로 처리 가능한가"라는 사실 자체를 검증한다
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
          EXPLAIN SELECT id FROM performances WHERE search_text ILIKE '%오페라%'`;
      });
      const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
      expect(planText).toContain('performances_search_text_trgm_idx');
    });
  });

  // ── 3. 공연 목록 캐시 ──────────────────────────────────────────────

  describe('공연 목록 캐시 (필터 없는 첫 페이지만, TTL 60s)', () => {
    let listVenueId: number;

    beforeAll(async () => {
      listVenueId = await createVenue('목록 캐시 홀', 1);
    });

    it('첫 페이지가 캐시된다 — 무효화를 우회한 직접 INSERT는 보이지 않는다', async () => {
      const before = await request(server).get('/performances').expect(200);
      const countBefore = before.body.items.length;

      await prisma.performance.create({
        data: {
          title: '직접 삽입 공연',
          venueId: BigInt(listVenueId),
          searchText: '직접 삽입 공연',
        },
      });

      const stale = await request(server).get('/performances').expect(200);
      expect(stale.body.items).toHaveLength(countBefore);

      await app.get(PerformanceListCacheService).invalidate();
      const fresh = await request(server).get('/performances').expect(200);
      expect(fresh.body.items).toHaveLength(countBefore + 1);
    });

    it('검색·커서 요청은 캐시를 우회한다 — 방금 만든 공연이 바로 검색된다', async () => {
      await request(server).get('/performances').expect(200); // 첫 페이지 캐시를 심는다
      await prisma.performance.create({
        data: {
          title: '우회 검증 공연',
          venueId: BigInt(listVenueId),
          searchText: '우회 검증 공연',
        },
      });

      // 검색 경로는 캐시가 없으므로 즉시 보인다
      const search = await request(server).get('/performances?q=우회 검증').expect(200);
      expect(search.body.items).toHaveLength(1);

      // 반면 캐시된 첫 페이지에는 아직 없다
      const list = await request(server).get('/performances').expect(200);
      const titles = list.body.items.map((i: { title: string }) => i.title);
      expect(titles).not.toContain('우회 검증 공연');

      await app.get(PerformanceListCacheService).invalidate();
    });

    it('공연 등록 API는 목록 캐시를 무효화한다 — 등록 직후 목록에 보인다', async () => {
      await request(server).get('/performances').expect(200); // 캐시를 심는다
      await createPerformance(listVenueId, '등록 직후 보이는 공연');

      const list = await request(server).get('/performances').expect(200);
      const titles = list.body.items.map((i: { title: string }) => i.title);
      expect(titles).toContain('등록 직후 보이는 공연');
    });
  });

  // ── 4. 판매 통계 ───────────────────────────────────────────────────

  describe('관리자 판매 통계 (실시간 집계 + TTL 5m 캐시)', () => {
    let showId: number;
    let extraHoldGroupId: string;

    beforeAll(async () => {
      const venueId = await createVenue('통계 검증 홀', 4);
      const perfId = await createPerformance(venueId, '통계 검증 공연');
      showId = await createShowWithSeats(perfId, 100000);

      const seats = await getSeatMap(showId);
      const seatIds = seats.map((s) => s.id);

      // 2석: 선점 → 예매 → 결제 (RESERVED, 매출 20만)
      const paidHold = await request(server)
        .post(`/shows/${showId}/holds`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ seatIds: seatIds.slice(0, 2) })
        .expect(201);
      const reservation = await request(server)
        .post('/reservations')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ holdGroupId: paidHold.body.holdGroupId })
        .expect(201);
      await request(server)
        .post('/payments')
        .set('Authorization', `Bearer ${userToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ reservationId: reservation.body.id, method: 'CARD' })
        .expect(201);

      // 1석: 선점만 (HELD)
      const extraHold = await request(server)
        .post(`/shows/${showId}/holds`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ seatIds: [seatIds[2]] })
        .expect(201);
      extraHoldGroupId = extraHold.body.holdGroupId;
    });

    it('판매율·매출·좌석 상태 분포를 집계한다', async () => {
      const res = await request(server)
        .get(`/admin/shows/${showId}/stats`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        showId,
        totalSeats: 4,
        reservedSeats: 2,
        heldSeats: 1,
        availableSeats: 1,
        salesRate: 0.5,
        revenue: 200000,
      });
      expect(res.body.generatedAt).toBeTruthy();
    });

    it('통계는 5분 캐시된다 — 직후의 상태 변화는 다음 TTL까지 보이지 않는다', async () => {
      // 위 테스트가 캐시를 심었다. 선점을 해제해도…
      await request(server)
        .delete(`/holds/${extraHoldGroupId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      // …통계는 캐시된 스냅샷을 답한다 (관리자 대시보드에 5분 신선도는 충분)
      const res = await request(server)
        .get(`/admin/shows/${showId}/stats`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.heldSeats).toBe(1);
    });

    it('일반 사용자는 통계에 접근할 수 없다 (403)', async () => {
      await request(server)
        .get(`/admin/shows/${showId}/stats`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('존재하지 않는 회차는 404를 반환한다', async () => {
      await request(server)
        .get('/admin/shows/999999/stats')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
