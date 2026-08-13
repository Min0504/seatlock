import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class SignupDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  // bcrypt는 72바이트 이후를 무시하므로 그 이하로 상한을 강제한다
  @ApiProperty({ example: 'password1234', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'password1234' })
  @IsString()
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Refresh Token' })
  @IsString()
  refreshToken!: string;
}
