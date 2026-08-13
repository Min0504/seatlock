import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
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

  @Delete('reservations/:id')
  @ApiOperation({
    summary: '예매 취소 (본인만, 공연 24시간 전까지)',
    description:
      '미결제(PENDING) 예매는 선점 좌석을 즉시 반납하고, 결제 완료(CONFIRMED) 예매는 ' +
      '좌석 원복과 환불까지 한 트랜잭션으로 처리한다. 반복 호출해도 안전하다(멱등).',
  })
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.reservationsService.cancel(user.id, BigInt(id));
  }

  @Get('me/reservations')
  @ApiOperation({ summary: '내 예매 목록 (커서 페이지네이션)' })
  async listMine(@CurrentUser() user: AuthenticatedUser, @Query() query: MyReservationsQuery) {
    return this.reservationsService.listMine(user.id, query);
  }
}
