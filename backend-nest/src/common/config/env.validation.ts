import { plainToInstance } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, validateSync } from 'class-validator';

class EnvVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_TTL_SEC?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_TTL_SEC?: string;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsOptional()
  @IsString()
  PORT?: string;
}

/**
 * 필수 환경변수는 부팅 시점에 검증한다.
 * 런타임 중간에 undefined secret으로 토큰을 서명하는 사고보다
 * 시작 실패가 훨씬 싸다(fail-fast).
 */
export function validateEnv(config: Record<string, unknown>): EnvVariables {
  const validated = plainToInstance(EnvVariables, config);
  const errors = validateSync(validated, { skipMissingProperties: false, whitelist: false });
  if (errors.length > 0) {
    const missing = errors.map((e) => e.property).join(', ');
    throw new Error(`환경변수 검증 실패: ${missing}`);
  }
  return validated;
}
