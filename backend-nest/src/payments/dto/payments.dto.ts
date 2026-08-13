import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsPositive } from 'class-validator';

export const PAYMENT_METHODS = ['CARD', 'EASY_PAY'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export class CreatePaymentDto {
  @ApiProperty({ description: '결제할 예매 ID (PENDING 상태)' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  reservationId!: number;

  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethod;
}
