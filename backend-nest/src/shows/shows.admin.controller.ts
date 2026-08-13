import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateShowSeatsDto } from './dto/shows.dto';
import { ShowStatsService } from './show-stats.service';
import { ShowsService } from './shows.service';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('admin/shows')
export class ShowsAdminController {
  constructor(
    private readonly showsService: ShowsService,
    private readonly showStatsService: ShowStatsService,
  ) {}

  @Post(':id/seats')
  @ApiOperation({ summary: '회차 좌석 인스턴스 일괄 생성 (ADMIN)' })
  async createSeats(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateShowSeatsDto) {
    return this.showsService.createShowSeats(BigInt(id), dto);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: '회차 판매 통계 — 판매율·매출 (ADMIN, 5분 캐시)' })
  async stats(@Param('id', ParseIntPipe) id: number) {
    return this.showStatsService.getStats(BigInt(id));
  }
}
