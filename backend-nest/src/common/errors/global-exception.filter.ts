import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from './domain.exception';

/**
 * 모든 예외를 { code, message } 형태의 단일 계약으로 변환한다.
 * 5xx는 스택을 로그로만 남기고 응답에는 내부 정보를 노출하지 않는다.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? (body as { message: string | string[] }).message
          : exception.message;
      res.status(status).json({
        code: status === 400 ? 'VALIDATION_FAILED' : `HTTP_${status}`,
        message,
      });
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' });
  }
}
