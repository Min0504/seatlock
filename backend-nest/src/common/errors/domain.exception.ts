import { HttpException } from '@nestjs/common';

/**
 * 도메인 에러의 표준형.
 * HTTP 상태코드만으로는 "왜 실패했는가"를 구분할 수 없으므로(409가 좌석 선점 실패인지
 * 이메일 중복인지), 기계가 분기할 수 있는 안정적인 code를 계약으로 제공한다.
 */
export class DomainException extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, ...(details !== undefined ? { details } : {}) }, status);
  }
}
