import { INestApplication } from '@nestjs/common';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { createTestApp, seedUsers, teardownTestApp, TestContext } from './helpers/test-app';

/**
 * DB 최후 방어선 검증 — 애플리케이션 로직을 우회해 DB에 직접 쓰더라도
 * 부분 유니크 인덱스(reservation_seats_active_unique)가 이중 판매를 막는지 확인한다.
 */
describe('스키마 제약 — 이중 판매 최후 방어선', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    prisma = app.get(PrismaService);
  }, 180000);

  afterAll(async () => {
    await teardownTestApp(ctx);
  });

  it('같은 좌석에 유효 예매 행이 2개 생기는 INSERT는 DB가 거부한다', async () => {
    const [u1, u2] = await seedUsers(app, 2);
    const user1 = await prisma.user.findUniqueOrThrow({ where: { email: u1.email } });
    const user2 = await prisma.user.findUniqueOrThrow({ where: { email: u2.email } });

    const venue = await prisma.venue.create({ data: { name: 'v', address: 'a' } });
    const seat = await prisma.seat.create({
      data: { venueId: venue.id, section: 'A', rowNo: '1', seatNo: 1 },
    });
    const performance = await prisma.performance.create({
      data: { title: 'p', venueId: venue.id, searchText: 'p' },
    });
    const show = await prisma.show.create({
      data: { performanceId: performance.id, startsAt: new Date(), ticketOpenAt: new Date() },
    });
    const showSeat = await prisma.showSeat.create({
      data: { showId: show.id, seatId: seat.id, price: 1000 },
    });

    const makeReservation = (userId: bigint) =>
      prisma.reservation.create({
        data: {
          userId,
          showId: show.id,
          status: ReservationStatus.CONFIRMED,
          totalPrice: 1000,
          seatCount: 1,
        },
      });

    const r1 = await makeReservation(user1.id);
    await prisma.reservationSeat.create({
      data: { reservationId: r1.id, showSeatId: showSeat.id },
    });

    // 두 번째 유효 예매 행 — 부분 유니크 인덱스 위반(P2002)이어야 한다
    const r2 = await makeReservation(user2.id);
    await expect(
      prisma.reservationSeat.create({ data: { reservationId: r2.id, showSeatId: showSeat.id } }),
    ).rejects.toMatchObject({ code: 'P2002' } satisfies Partial<Prisma.PrismaClientKnownRequestError>);

    // 단, 취소된 예매(canceled=true)는 같은 좌석에 공존할 수 있어야 한다 (취소 후 재판매 이력)
    await expect(
      prisma.reservationSeat.create({
        data: { reservationId: r2.id, showSeatId: showSeat.id, canceled: true },
      }),
    ).resolves.toBeTruthy();
  });
});
