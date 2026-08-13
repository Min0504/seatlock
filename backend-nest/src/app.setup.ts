import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter';

// Prisma의 BigInt(BIGSERIAL PK)를 JSON으로 내보낼 때의 직렬화 정책.
// id가 2^53을 넘기 전까지는 number 변환이 안전하며 이 서비스 규모에서는 충분하다.
// (id 고갈이 예상되는 시스템이라면 string 직렬화로 바꿔야 한다)
// main.ts가 아닌 여기 두는 이유: e2e 테스트도 동일한 직렬화 정책으로 돌아야 하기 때문.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

/**
 * 앱 전역 설정을 main.ts와 e2e 테스트가 공유한다.
 * 테스트가 실제 서비스와 동일한 파이프/필터 구성으로 돌아야
 * "테스트 통과 = 실제 동작 보장"이 성립하기 때문.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('SeatLock API')
    .setDescription('좌석 선점형 공연 예매 API — NestJS 구현 (v1~v2)')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  return app;
}
