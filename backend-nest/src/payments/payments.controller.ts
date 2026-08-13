import { Body, Controller, Headers, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Errors } from '../common/errors/errors';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreatePaymentDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @ApiOperation({
    summary: '결제 실행 (멱등)',
    description:
      '같은 Idempotency-Key 재요청은 결제를 재실행하지 않고 첫 결과를 200으로 반환한다. ' +
      '같은 키에 다른 바디는 422, 처리 중 동시 요청은 409.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: '클라이언트가 생성한 UUID. 재시도 시 반드시 같은 값을 보낸다.',
    required: true,
  })
  async pay(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 키 없는 결제를 허용하면 멱등성 계약 전체가 무너진다 — 헤더를 필수로 강제
    if (idempotencyKey === undefined || !isUUID(idempotencyKey)) {
      throw Errors.idempotencyKeyRequired();
    }
    const result = await this.paymentsService.pay(user.id, idempotencyKey, dto);
    // 이번 요청이 결제를 실행했으면 201, 기존 결과의 재생이면 200 — 재실행 여부를 상태코드로 드러낸다
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result.payment;
  }
}
