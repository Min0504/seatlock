import { Module } from '@nestjs/common';
import { MockPgService } from './mock-pg.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, MockPgService],
})
export class PaymentsModule {}
