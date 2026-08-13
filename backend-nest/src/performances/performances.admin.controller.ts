import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CreatePerformanceDto, CreateShowDto, CreateVenueDto } from './dto/performances.dto';
import { PerformancesService } from './performances.service';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('admin')
export class PerformancesAdminController {
  constructor(private readonly performancesService: PerformancesService) {}

  @Post('venues')
  @ApiOperation({ summary: '공연장 + 좌석 템플릿 등록 (ADMIN)' })
  async createVenue(@Body() dto: CreateVenueDto) {
    return this.performancesService.createVenue(dto);
  }

  @Post('performances')
  @ApiOperation({ summary: '공연 등록 (ADMIN)' })
  async createPerformance(@Body() dto: CreatePerformanceDto) {
    return this.performancesService.createPerformance(dto);
  }

  @Post('shows')
  @ApiOperation({ summary: '회차 등록 (ADMIN)' })
  async createShow(@Body() dto: CreateShowDto) {
    return this.performancesService.createShow(dto);
  }
}
