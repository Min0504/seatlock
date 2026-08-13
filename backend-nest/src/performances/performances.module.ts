import { Module } from '@nestjs/common';
import { PerformancesAdminController } from './performances.admin.controller';
import { PerformancesController } from './performances.controller';
import { PerformancesService } from './performances.service';

@Module({
  controllers: [PerformancesController, PerformancesAdminController],
  providers: [PerformancesService],
})
export class PerformancesModule {}
