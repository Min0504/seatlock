import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt } from 'class-validator';

export const MAX_SEATS_PER_HOLD = 4;

export class HoldSeatsDto {
  @ApiProperty({ example: [101, 102], description: `선점할 좌석 ID (최대 ${MAX_SEATS_PER_HOLD}석)` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SEATS_PER_HOLD)
  @IsInt({ each: true })
  seatIds!: number[];
}
