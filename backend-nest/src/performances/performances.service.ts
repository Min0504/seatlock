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
import { PerformanceListCacheService } from './performance-list-cache.service';

export interface PerformanceListPayload {
  /** 캐시 왕복(JSON 직렬화)을 거치므로 BigInt가 아닌 number로 고정 */
  items: Array<{ id: number; title: string; posterUrl: string | null; venueName: string }>;
  nextCursor: string | null;
}

@Injectable()
export class PerformancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly listCache: PerformanceListCacheService,
  ) {}

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
        // 검색 결합 컬럼 — 제목/설명(출연진 포함)을 한 컬럼에 모아 GIN 인덱스 하나로 검색
        searchText: [dto.title, dto.description].filter(Boolean).join(' '),
      },
    });
    await this.listCache.invalidate();
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

  async list(query: ListPerformancesQuery): Promise<PerformanceListPayload> {
    const size = query.size ?? 20;

    // 캐시는 "필터 없는 첫 페이지"만 — 메인 진입 시 전원이 때리는 유일한 핫스팟이다.
    // 검색어·날짜·커서 조합까지 캐시하면 키 수가 폭발하는데 히트율은 바닥이라 실익이 없다.
    const cacheable = !query.q && !query.date && !query.cursor && size === 20;
    if (cacheable) {
      const cached = await this.listCache.get();
      if (cached !== null) {
        return JSON.parse(cached) as PerformanceListPayload;
      }
    }

    const where: Prisma.PerformanceWhereInput = {};
    if (query.q) {
      // '%검색어%' 부분 일치. Prisma의 contains/insensitive는 ILIKE로 컴파일되고,
      // search_text의 GIN(gin_trgm_ops) 인덱스가 이를 인덱스 스캔으로 처리한다
      // (제목만이 아니라 설명·출연진까지 한 컬럼으로 검색 — 스키마 주석 참조)
      where.searchText = { contains: query.q, mode: 'insensitive' };
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
      id: Number(p.id),
      title: p.title,
      posterUrl: p.posterUrl,
      venueName: p.venue.name,
    }));
    const payload: PerformanceListPayload = {
      items,
      nextCursor: hasNext ? String(items[items.length - 1].id) : null,
    };
    if (cacheable) {
      await this.listCache.set(JSON.stringify(payload));
    }
    return payload;
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
