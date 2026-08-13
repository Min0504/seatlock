import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ListPerformancesQuery } from './dto/performances.dto';
import { PerformancesService } from './performances.service';

@ApiTags('performances')
@Controller('performances')
export class PerformancesController {
  constructor(private readonly performancesService: PerformancesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '공연 목록/검색 (커서 페이지네이션)' })
  async list(@Query() query: ListPerformancesQuery) {
    return this.performancesService.list(query);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: '공연 상세 (회차 목록 포함)' })
  async detail(@Param('id', ParseIntPipe) id: number) {
    return this.performancesService.detail(BigInt(id));
  }
}
