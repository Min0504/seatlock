import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateReservationDto, MyReservationsQuery } from './dto/reservations.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('reservations')
  @ApiOperation({ summary: '선점 좌석으로 예매 생성' })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReservationDto) {
    return this.reservationsService.create(user.id, dto.holdGroupId);
  }

  @Get('me/reservations')
  @ApiOperation({ summary: '내 예매 목록 (커서 페이지네이션)' })
  async listMine(@CurrentUser() user: AuthenticatedUser, @Query() query: MyReservationsQuery) {
    return this.reservationsService.listMine(user.id, query);
  }
}
