import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateReservationDto {
  @ApiProperty({ description: '좌석 선점 시 발급된 holdGroupId' })
  @IsUUID()
  holdGroupId!: string;
}

export class MyReservationsQuery {
  @ApiPropertyOptional({ description: '커서(이전 응답의 nextCursor)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number;
}
