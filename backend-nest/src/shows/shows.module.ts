import { Module } from '@nestjs/common';
import { ShowsAdminController } from './shows.admin.controller';
import { ShowsController } from './shows.controller';
import { ShowsService } from './shows.service';

@Module({
  controllers: [ShowsController, ShowsAdminController],
  providers: [ShowsService],
  exports: [ShowsService],
})
export class ShowsModule {}
