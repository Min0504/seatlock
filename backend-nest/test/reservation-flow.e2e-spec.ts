import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { createTestApp, seedAdmin } from './helpers/test-app';

/**
 * v1 happy path 전 경로 검증:
 * 가입 → 로그인 → (ADMIN) 공연장/공연/회차/좌석 생성 → 좌석맵 → 선점 → 예매 → 내 예매
 */
describe('예매 전체 흐름 (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let adminToken: string;
  let userToken: string;
  let showId: number;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    container = ctx.container;
    server = app.getHttpServer();

    const admin = await seedAdmin(app);
    const adminLogin = await request(server)
      .post('/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    adminToken = adminLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('회원가입/로그인이 동작하고, 중복 이메일은 409를 반환한다', async () => {
    await request(server)
      .post('/auth/signup')
      .send({ email: 'user@test.com', password: 'password1234' })
      .expect(201);

    const dup = await request(server)
      .post('/auth/signup')
      .send({ email: 'user@test.com', password: 'password1234' })
      .expect(409);
    expect(dup.body.code).toBe('EMAIL_EXISTS');

    const login = await request(server)
      .post('/auth/login')
      .send({ email: 'user@test.com', password: 'password1234' })
      .expect(200);
    userToken = login.body.accessToken;
    expect(userToken).toBeTruthy();
  });

  it('일반 사용자는 관리자 API에 접근할 수 없다 (403)', async () => {
    await request(server)
      .post('/admin/performances')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ title: 'x', venueId: 1 })
      .expect(403);
  });

  it('ADMIN이 공연장·공연·회차·좌석을 생성한다', async () => {
    const venue = await request(server)
      .post('/admin/venues')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: '테스트 아트홀',
        address: '서울시 어딘가 1',
        seats: [
          { section: 'A', rowNo: '1', seatNo: 1 },
          { section: 'A', rowNo: '1', seatNo: 2 },
          { section: 'B', rowNo: '1', seatNo: 1 },
        ],
      })
      .expect(201);
    expect(venue.body.seatCount).toBe(3);

    const performance = await request(server)
      .post('/admin/performances')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '테스트 콘서트', description: '설명', venueId: venue.body.id })
      .expect(201);

    const show = await request(server)
      .post('/admin/shows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        performanceId: performance.body.id,
        startsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        ticketOpenAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      })
      .expect(201);
    showId = show.body.id;

    const seats = await request(server)
      .post(`/admin/shows/${showId}/seats`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prices: [{ section: 'A', price: 150000 }, { section: 'B', price: 90000 }] })
      .expect(201);
    expect(seats.body.count).toBe(3);

    // 같은 회차에 좌석 재생성은 UNIQUE(show_id, seat_id)가 차단
    const dup = await request(server)
      .post(`/admin/shows/${showId}/seats`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prices: [{ section: 'A', price: 150000 }] })
      .expect(409);
    expect(dup.body.code).toBe('SEATS_ALREADY_CREATED');
  });

  it('공연 목록·검색과 좌석맵을 조회한다 (비로그인 허용)', async () => {
    const list = await request(server).get('/performances?q=테스트').expect(200);
    expect(list.body.items).toHaveLength(1);

    const seatMap = await request(server).get(`/shows/${showId}/seats`).expect(200);
    expect(seatMap.body.seats).toHaveLength(3);
    expect(seatMap.body.seats.every((s: { status: string }) => s.status === 'AVAILABLE')).toBe(true);
  });

  it('선점 → 예매 → 내 예매 조회까지 완료된다', async () => {
    const seatMap = await request(server).get(`/shows/${showId}/seats`).expect(200);
    const seatIds = seatMap.body.seats
      .filter((s: { section: string }) => s.section === 'A')
      .map((s: { id: number }) => s.id);

    const hold = await request(server)
      .post(`/shows/${showId}/holds`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ seatIds })
      .expect(201);
    expect(hold.body.holdGroupId).toBeTruthy();

    // 이미 선점된 좌석 재선점은 409
    const conflict = await request(server)
      .post(`/shows/${showId}/holds`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ seatIds: [seatIds[0]] })
      .expect(409);
    expect(conflict.body.code).toBe('SEAT_ALREADY_TAKEN');

    const reservation = await request(server)
      .post('/reservations')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ holdGroupId: hold.body.holdGroupId })
      .expect(201);
    expect(reservation.body.totalPrice).toBe(300000);

    const mine = await request(server)
      .get('/me/reservations')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].seats).toHaveLength(2);
    expect(mine.body.items[0].status).toBe('CONFIRMED');

    // 예매 완료 좌석은 좌석맵에서 RESERVED로 보인다
    const afterMap = await request(server).get(`/shows/${showId}/seats`).expect(200);
    const reserved = afterMap.body.seats.filter((s: { status: string }) => s.status === 'RESERVED');
    expect(reserved).toHaveLength(2);
  });

  it('선점 취소 시 좌석이 AVAILABLE로 돌아온다', async () => {
    const seatMap = await request(server).get(`/shows/${showId}/seats`).expect(200);
    const available = seatMap.body.seats.find((s: { status: string }) => s.status === 'AVAILABLE');

    const hold = await request(server)
      .post(`/shows/${showId}/holds`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ seatIds: [available.id] })
      .expect(201);

    await request(server)
      .delete(`/holds/${hold.body.holdGroupId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    const afterMap = await request(server).get(`/shows/${showId}/seats`).expect(200);
    const after = afterMap.body.seats.find((s: { id: number }) => s.id === available.id);
    expect(after.status).toBe('AVAILABLE');
  });
});
