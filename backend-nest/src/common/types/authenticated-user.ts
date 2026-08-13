import { Role } from '@prisma/client';

/** 인증 가드가 검증을 마친 뒤 요청에 부착하는 사용자 컨텍스트 */
export interface AuthenticatedUser {
  id: bigint;
  role: Role;
}
