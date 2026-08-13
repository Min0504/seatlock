import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  // 시크릿은 access/refresh가 서로 다르므로 모듈 기본값을 두지 않고
  // 서명·검증 시점에 명시적으로 지정한다(잘못된 시크릿으로 통과되는 사고 방지).
  imports: [JwtModule.register({ global: true })],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
