import { Body, Controller, Delete, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { HoldSeatsDto } from './dto/holds.dto';
import { HoldsService } from './holds.service';

@ApiTags('holds')
@ApiBearerAuth()
@Controller()
export class HoldsController {
  constructor(private readonly holdsService: HoldsService) {}

  @Post('shows/:showId/holds')
  @ApiOperation({ summary: '좌석 선점 (5분) — 하나라도 실패하면 그룹 전체 실패' })
  async hold(
    @Param('showId', ParseIntPipe) showId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: HoldSeatsDto,
  ) {
    return this.holdsService.hold(BigInt(showId), user.id, dto.seatIds);
  }

  @Delete('holds/:holdGroupId')
  @HttpCode(200)
  @ApiOperation({ summary: '선점 취소 (본인만)' })
  async release(
    @Param('holdGroupId', ParseUUIDPipe) holdGroupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.holdsService.release(holdGroupId, user.id);
  }
}
