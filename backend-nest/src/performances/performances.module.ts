import { Module } from '@nestjs/common';
import { PerformanceListCacheService } from './performance-list-cache.service';
import { PerformancesAdminController } from './performances.admin.controller';
import { PerformancesController } from './performances.controller';
import { PerformancesService } from './performances.service';

@Module({
  controllers: [PerformancesController, PerformancesAdminController],
  providers: [PerformancesService, PerformanceListCacheService],
})
export class PerformancesModule {}
