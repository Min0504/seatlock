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
}
