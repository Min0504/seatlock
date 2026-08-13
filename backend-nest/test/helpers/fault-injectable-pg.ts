import { MockPgService, PgTimeoutError } from '../../src/payments/mock-pg.service';

/**
 * 실물 PG로는 재현할 수 없는 장애를 주입하는 확장 mock. DI로 MockPgService 자리를
 * 대체한다 (createTestApp의 overrideProviders).
 *
 * - timeoutNextApprove: 승인은 PG 쪽에 기록되지만 응답이 유실되는 상황
 *   (가맹점 입장에서 "됐는지 안 됐는지 모르는" 타임아웃)
 * - delayNextApproveMs: PG 왕복이 느려지는 상황 — 승인이 진행되는 동안
 *   선점 만료·예매 취소가 끼어드는 경합 구간을 결정적으로 만들 수 있다
 */
export class FaultInjectablePg extends MockPgService {
  timeoutNextApprove = false;
  delayNextApproveMs = 0;

  override async approve(orderId: string, amount: number, method: string) {
    const delay = this.delayNextApproveMs;
    this.delayNextApproveMs = 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const result = await super.approve(orderId, amount, method);
    if (this.timeoutNextApprove) {
      this.timeoutNextApprove = false;
      throw new PgTimeoutError();
    }
    return result;
  }
}
