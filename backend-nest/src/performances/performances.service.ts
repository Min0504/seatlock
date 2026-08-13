import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  CreatePerformanceDto,
  CreateShowDto,
  CreateVenueDto,
  ListPerformancesQuery,
} from './dto/performances.dto';

@Injectable()
export class PerformancesService {
  constructor(private readonly prisma: PrismaService) {}

  async createVenue(dto: CreateVenueDto): Promise<{ id: bigint; seatCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      const venue = await tx.venue.create({ data: { name: dto.name, address: dto.address } });
      // 좌석 수천 행은 개별 INSERT N회가 아니라 createMany 한 번으로 적재한다
      // (왕복 횟수가 곧 지연 — bulk insert가 회차 좌석 생성(ShowsService)에서도 동일하게 쓰인다)
      const created = await tx.seat.createMany({
        data: dto.seats.map((s) => ({
          venueId: venue.id,
          section: s.section,
          rowNo: s.rowNo,
          seatNo: s.seatNo,
        })),
      });
      return { id: venue.id, seatCount: created.count };
    });
  }

  async createPerformance(dto: CreatePerformanceDto): Promise<{ id: bigint }> {
    const venue = await this.prisma.venue.findUnique({ where: { id: BigInt(dto.venueId) } });
    if (!venue) {
      throw Errors.venueNotFound();
    }
    const performance = await this.prisma.performance.create({
      data: {
        title: dto.title,
        description: dto.description,
        venueId: venue.id,
      },
    });
    return { id: performance.id };
  }

  async createShow(dto: CreateShowDto): Promise<{ id: bigint }> {
    const performance = await this.prisma.performance.findUnique({
      where: { id: BigInt(dto.performanceId) },
    });
    if (!performance) {
      throw Errors.performanceNotFound();
    }
    const show = await this.prisma.show.create({
      data: {
        performanceId: performance.id,
        startsAt: new Date(dto.startsAt),
        ticketOpenAt: new Date(dto.ticketOpenAt),
      },
    });
    return { id: show.id };
  }

  async list(query: ListPerformancesQuery): Promise<{
    items: Array<{ id: bigint; title: string; posterUrl: string | null; venueName: string }>;
    nextCursor: string | null;
  }> {
    const size = query.size ?? 20;
    const where: Prisma.PerformanceWhereInput = {};
    if (query.q) {
      // v1: ILIKE 부분 일치. '%검색어%'는 B-Tree 인덱스를 못 타므로
      // v2에서 pg_trgm GIN 인덱스로 개선한다 (EXPLAIN 전후 비교 예정)
      where.title = { contains: query.q, mode: 'insensitive' };
    }
    if (query.date) {
      const dayStart = new Date(`${query.date}T00:00:00+09:00`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      where.shows = { some: { startsAt: { gte: dayStart, lt: dayEnd } } };
    }
    // 커서 기반 페이지네이션: offset은 뒤 페이지로 갈수록 스캔량이 늘고
    // 페이지 사이 삽입 시 중복/누락이 생긴다 — id 내림차순 커서로 고정
    if (query.cursor) {
      where.id = { lt: BigInt(query.cursor) };
    }

    const rows = await this.prisma.performance.findMany({
      where,
      orderBy: { id: 'desc' },
      take: size + 1,
      include: { venue: { select: { name: true } } },
    });

    const hasNext = rows.length > size;
    const items = (hasNext ? rows.slice(0, size) : rows).map((p) => ({
      id: p.id,
      title: p.title,
      posterUrl: p.posterUrl,
      venueName: p.venue.name,
    }));
    return {
      items,
      nextCursor: hasNext ? String(items[items.length - 1].id) : null,
    };
  }

  async detail(id: bigint): Promise<{
    id: bigint;
    title: string;
    description: string | null;
    posterUrl: string | null;
    venue: { id: bigint; name: string; address: string };
    shows: Array<{ id: bigint; startsAt: Date; ticketOpenAt: Date }>;
  }> {
    const performance = await this.prisma.performance.findUnique({
      where: { id },
      include: {
        venue: true,
        shows: { orderBy: { startsAt: 'asc' } },
      },
    });
    if (!performance) {
      throw Errors.performanceNotFound();
    }
    return {
      id: performance.id,
      title: performance.title,
      description: performance.description,
      posterUrl: performance.posterUrl,
      venue: {
        id: performance.venue.id,
        name: performance.venue.name,
        address: performance.venue.address,
      },
      shows: performance.shows.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        ticketOpenAt: s.ticketOpenAt,
      })),
    };
  }
}
