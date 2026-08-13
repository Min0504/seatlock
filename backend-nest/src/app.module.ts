import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { HoldsModule } from './holds/holds.module';
import { PerformancesModule } from './performances/performances.module';
import { ReservationsModule } from './reservations/reservations.module';
import { ShowsModule } from './shows/shows.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    PerformancesModule,
    ShowsModule,
    HoldsModule,
    ReservationsModule,
  ],
  providers: [
    // 인증을 기본값(deny-by-default)으로 두고 공개 라우트만 @Public으로 여는 구조 —
    // 가드 누락으로 보호가 빠지는 실수를 원천 차단한다.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
