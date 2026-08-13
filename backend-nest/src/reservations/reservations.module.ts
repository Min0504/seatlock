import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ShowsModule } from '../shows/shows.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [PaymentsModule, ShowsModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
