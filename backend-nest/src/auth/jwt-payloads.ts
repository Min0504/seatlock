import { Role } from '@prisma/client';

export interface JwtAccessPayload {
  /** user id (BigInt는 JWT 표준 클레임에 못 실으므로 string) */
  sub: string;
  role: Role;
}

export interface JwtRefreshPayload {
  sub: string;
  /** access 토큰이 refresh 엔드포인트에 오용되는 것을 구분하기 위한 타입 태그 */
  type: 'refresh';
  /**
   * 토큰 고유 식별자. 같은 사용자가 같은 초에 두 번 로그인하면 sub/iat/exp가
   * 전부 같아 JWT 문자열까지 동일해진다 — token_hash UNIQUE와 충돌하므로
   * 발급마다 난수를 심어 토큰의 유일성을 보장한다.
   */
  jti: string;
}
