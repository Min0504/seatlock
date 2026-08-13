import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, seedAdmin, teardownTestApp, TestContext } from './helpers/test-app';

/**
 * v1 happy path 전 경로 검증:
 * 가입 → 로그인 → (ADMIN) 공연장/공연/회차/좌석 생성 → 좌석맵 → 선점 → 예매 → 내 예매
 */
describe('예매 전체 흐름 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let adminToken: string;
  let userToken: string;
  let showId: number;
  let reservationId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();

    const admin = await seedAdmin(app);
    const adminLogin = await request(server)
      .post('/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    adminToken = adminLogin.body.accessToken;
  });

  afterAll(async () => {
    await teardownTestApp(ctx);
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

  it('선점 → 예매(미결제) → 내 예매 조회까지 완료된다', async () => {
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

    // 예매 생성 = 미결제(PENDING) 단계 — 좌석 확정은 결제 승인 시점이다
    const reservation = await request(server)
      .post('/reservations')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ holdGroupId: hold.body.holdGroupId })
      .expect(201);
    expect(reservation.body.totalPrice).toBe(300000);
    expect(reservation.body.status).toBe('PENDING');
    expect(reservation.body.payUntil).toBeTruthy();
    reservationId = reservation.body.id;

    // 같은 선점으로 다시 생성해도 새 예매가 생기지 않는다 (부분 유니크 → 기존 반환)
    const dupReservation = await request(server)
      .post('/reservations')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ holdGroupId: hold.body.holdGroupId })
      .expect(201);
    expect(dupReservation.body.id).toBe(reservation.body.id);

    const mine = await request(server)
      .get('/me/reservations')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].seats).toHaveLength(2);
    expect(mine.body.items[0].status).toBe('PENDING');

    // 결제 전이므로 좌석은 여전히 HELD다 (RESERVED 전이는 결제 승인 때)
    const afterMap = await request(server).get(`/shows/${showId}/seats`).expect(200);
    const held = afterMap.body.seats.filter((s: { status: string }) => s.status === 'HELD');
    expect(held).toHaveLength(2);
  });

  it('결제(멱등 키)하면 예매가 CONFIRMED, 좌석이 RESERVED로 전이된다', async () => {
    const idempotencyKey = crypto.randomUUID();
    const pay = await request(server)
      .post('/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ reservationId, method: 'CARD' })
      .expect(201);
    expect(pay.body.status).toBe('APPROVED');
    expect(pay.body.amount).toBe(300000);
    expect(pay.body.pgTxId).toBeTruthy();

    // 같은 키 재요청 = 재실행 없이 첫 결과를 200으로 재생 (더블클릭·네트워크 재시도 안전)
    const replay = await request(server)
      .post('/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ reservationId, method: 'CARD' })
      .expect(200);
    expect(replay.body.paymentId).toBe(pay.body.paymentId);
    expect(replay.body.pgTxId).toBe(pay.body.pgTxId);

    const mine = await request(server)
      .get('/me/reservations')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(mine.body.items[0].status).toBe('CONFIRMED');
    expect(mine.body.items[0].seats).toHaveLength(2);

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
