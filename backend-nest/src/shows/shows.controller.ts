import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ShowsService } from './shows.service';

@ApiTags('shows')
@Controller('shows')
export class ShowsController {
  constructor(private readonly showsService: ShowsService) {}

  @Public()
  @Get(':id/seats')
  @ApiOperation({ summary: '회차 좌석맵 조회' })
  async seatMap(@Param('id', ParseIntPipe) id: number) {
    return this.showsService.getSeatMap(BigInt(id));
  }
}
