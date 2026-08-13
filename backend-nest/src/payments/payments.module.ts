import { Module } from '@nestjs/common';
import { MockPgService } from './mock-pg.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, MockPgService],
  // 예매 취소(환불)도 같은 PG 클라이언트를 쓴다 — 인스턴스가 갈리면 mock의
  // 거래 장부가 나뉘어 "승인은 여기, 취소는 저기"가 된다
  exports: [MockPgService],
})
export class PaymentsModule {}
