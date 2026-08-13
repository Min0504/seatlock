import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SeatTemplateDto {
  @ApiProperty({ example: 'A' })
  @IsString()
  @MaxLength(20)
  section!: string;

  @ApiProperty({ example: '1' })
  @IsString()
  @MaxLength(10)
  rowNo!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  seatNo!: number;
}

export class CreateVenueDto {
  @ApiProperty({ example: '세종문화회관 대극장' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '서울 종로구 세종대로 175' })
  @IsString()
  @MaxLength(255)
  address!: string;

  @ApiProperty({ type: [SeatTemplateDto], description: '물리 좌석 템플릿 (최대 10,000석)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => SeatTemplateDto)
  seats!: SeatTemplateDto[];
}

export class CreatePerformanceDto {
  @ApiProperty({ example: '오페라의 유령' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: '뮤지컬의 전설, 다시 무대로' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  venueId!: number;
}

export class CreateShowDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  performanceId!: number;

  @ApiProperty({ example: '2026-10-01T19:30:00+09:00' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ example: '2026-09-01T20:00:00+09:00' })
  @IsDateString()
  ticketOpenAt!: string;
}

export class ListPerformancesQuery {
  @ApiPropertyOptional({ description: '제목 검색어' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '해당 날짜에 회차가 있는 공연만 (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  date?: string;

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
