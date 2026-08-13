import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SectionPriceDto {
  @ApiProperty({ example: 'A' })
  @IsString()
  @MaxLength(20)
  section!: string;

  @ApiProperty({ example: 150000 })
  @IsInt()
  @Min(0)
  price!: number;
}

export class CreateShowSeatsDto {
  @ApiProperty({ type: [SectionPriceDto], description: '구역별 가격 — 공연장 템플릿 전 좌석에 적용' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SectionPriceDto)
  prices!: SectionPriceDto[];
}
