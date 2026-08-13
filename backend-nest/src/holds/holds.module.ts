import { Module } from '@nestjs/common';
import { ShowsModule } from '../shows/shows.module';
import { HoldExpiryListener } from './hold-expiry.listener';
import { HoldSweeperService } from './hold-sweeper.service';
import { HoldsController } from './holds.controller';
import { HoldsService } from './holds.service';

@Module({
  imports: [ShowsModule],
  controllers: [HoldsController],
  providers: [HoldsService, HoldSweeperService, HoldExpiryListener],
  exports: [HoldsService],
})
export class HoldsModule {}
