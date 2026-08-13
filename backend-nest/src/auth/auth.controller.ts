import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { AuthService, TokenPair } from './auth.service';
import { LoginDto, RefreshDto, SignupDto } from './dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('signup')
  @ApiOperation({ summary: '회원가입' })
  async signup(@Body() dto: SignupDto): Promise<{ id: bigint; email: string }> {
    return this.authService.signup(dto.email, dto.password);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: '로그인 — Access(15m) + Refresh(14d) 발급' })
  async login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.authService.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: '토큰 재발급 (Rotation)',
    description:
      '새 쌍을 발급하고 이전 refresh 토큰을 소모 처리한다. ' +
      '소모된 토큰이 재사용되면 탈취로 판정해 로그인 단위(family) 전체를 폐기한다.',
  })
  async refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: '로그아웃 — 이 기기의 refresh 토큰 family 폐기' })
  async logout(@CurrentUser() user: AuthenticatedUser, @Body() dto: RefreshDto): Promise<void> {
    await this.authService.logout(user.id, dto.refreshToken);
  }
}
