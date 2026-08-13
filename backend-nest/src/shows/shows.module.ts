import { Module } from '@nestjs/common';
import { SeatMapCacheService } from './seat-map-cache.service';
import { ShowsAdminController } from './shows.admin.controller';
import { ShowsController } from './shows.controller';
import { ShowsService } from './shows.service';

@Module({
  controllers: [ShowsController, ShowsAdminController],
  providers: [ShowsService, SeatMapCacheService],
  // SeatMapCacheService는 좌석 상태를 바꾸는 모든 모듈(선점·결제·예매)이 무효화에 쓴다
  exports: [ShowsService, SeatMapCacheService],
})
export class ShowsModule {}
