import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
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
  @ApiOperation({ summary: '토큰 재발급' })
  async refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.authService.refresh(dto.refreshToken);
  }
}
