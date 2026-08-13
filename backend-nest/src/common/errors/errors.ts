import { DomainException } from './domain.exception';

/**
 * 에러 코드 레지스트리 — 코드 문자열을 한 곳에서 관리해
 * API 문서·프론트엔드 분기·테스트가 같은 계약을 바라보게 한다.
 */
export const Errors = {
  // auth
  emailExists: (): DomainException =>
    new DomainException(409, 'EMAIL_EXISTS', '이미 가입된 이메일입니다.'),
  invalidCredentials: (): DomainException =>
    new DomainException(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.'),
  unauthorized: (): DomainException =>
    new DomainException(401, 'UNAUTHORIZED', '유효한 인증 토큰이 필요합니다.'),
  forbidden: (): DomainException =>
    new DomainException(403, 'FORBIDDEN', '이 리소스에 접근할 권한이 없습니다.'),

  // catalog
  venueNotFound: (): DomainException =>
    new DomainException(404, 'VENUE_NOT_FOUND', '공연장을 찾을 수 없습니다.'),
  performanceNotFound: (): DomainException =>
    new DomainException(404, 'PERFORMANCE_NOT_FOUND', '공연을 찾을 수 없습니다.'),
  showNotFound: (): DomainException =>
    new DomainException(404, 'SHOW_NOT_FOUND', '회차를 찾을 수 없습니다.'),
  seatsAlreadyCreated: (): DomainException =>
    new DomainException(409, 'SEATS_ALREADY_CREATED', '이미 좌석이 생성된 회차입니다.'),

  // hold / reservation
  ticketNotOpen: (openAt: Date): DomainException =>
    new DomainException(403, 'TICKET_NOT_OPEN', '아직 예매 오픈 전입니다.', {
      ticketOpenAt: openAt.toISOString(),
    }),
  seatNotFound: (): DomainException =>
    new DomainException(404, 'SEAT_NOT_FOUND', '요청한 좌석을 찾을 수 없습니다.'),
  seatAlreadyTaken: (seatIds: number[]): DomainException =>
    new DomainException(409, 'SEAT_ALREADY_TAKEN', '이미 선점되었거나 판매된 좌석이 포함되어 있습니다.', {
      seatIds,
    }),
  holdLimitExceeded: (limit: number): DomainException =>
    new DomainException(400, 'HOLD_LIMIT_EXCEEDED', `1인당 최대 ${limit}석까지 선점할 수 있습니다.`),
  holdNotFound: (): DomainException =>
    new DomainException(404, 'HOLD_NOT_FOUND', '유효한 선점 내역을 찾을 수 없습니다.'),
  holdExpired: (): DomainException =>
    new DomainException(409, 'HOLD_EXPIRED', '선점 유효시간이 만료되었습니다. 좌석을 다시 선택해 주세요.'),
  reservationNotFound: (): DomainException =>
    new DomainException(404, 'RESERVATION_NOT_FOUND', '예매 내역을 찾을 수 없습니다.'),

  // payment
  idempotencyKeyRequired: (): DomainException =>
    new DomainException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 헤더(UUID)가 필요합니다.'),
  idempotencyKeyMismatch: (): DomainException =>
    new DomainException(
      422,
      'IDEMPOTENCY_KEY_MISMATCH',
      '같은 Idempotency-Key로 다른 내용의 요청이 들어왔습니다. 새 키로 요청해 주세요.',
    ),
  paymentInProgress: (): DomainException =>
    new DomainException(409, 'PAYMENT_IN_PROGRESS', '같은 결제가 처리 중입니다. 잠시 후 같은 키로 다시 시도해 주세요.'),
  paymentFailed: (): DomainException =>
    new DomainException(402, 'PAYMENT_FAILED', '결제가 승인되지 않았습니다. 새 키로 다시 시도해 주세요.'),
  alreadyPaid: (): DomainException =>
    new DomainException(409, 'ALREADY_PAID', '이미 결제가 완료된 예매입니다.'),
  reservationNotPayable: (): DomainException =>
    new DomainException(409, 'RESERVATION_NOT_PAYABLE', '결제할 수 없는 상태의 예매입니다.'),
  cancelWindowClosed: (): DomainException =>
    new DomainException(409, 'CANCEL_WINDOW_CLOSED', '공연 시작 24시간 전까지만 취소할 수 있습니다.'),
} as const;
