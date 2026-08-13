import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** PG 응답을 받지 못한 상태 — "됐는지 안 됐는지 모른다"를 예외 타입으로 구분한다 */
export class PgTimeoutError extends Error {
  constructor() {
    super('PG 응답 시간 초과');
    this.name = 'PgTimeoutError';
  }
}

export interface PgApproval {
  pgTxId: string;
}

export type PgTxStatus = { status: 'APPROVED'; pgTxId: string } | { status: 'NOT_FOUND' };

/**
 * 실제 PG 연동의 계약만 흉내 낸 mock.
 *
 * 실 PG와 동일하게 유지하는 계약 두 가지:
 * - 가맹점이 주문번호(orderId)를 먼저 정해 보낸다 — 응답을 못 받아도(타임아웃)
 *   orderId로 상태를 역조회(getStatus)할 수 있는 근거가 된다.
 * - 승인 여부의 진실은 PG 쪽 기록이다. 타임아웃은 "실패"가 아니라 "모름"이며,
 *   getStatus로 확인하기 전까지 결제를 실패 처리하면 안 된다(이중 청구·유실의 근원).
 *
 * 카드번호 등 민감정보는 받지 않는다 — 기획서 §보안: mock PG 토큰만 다룬다.
 */
@Injectable()
export class MockPgService {
  private readonly transactions = new Map<string, { pgTxId: string; amount: number; method: string }>();

  async approve(orderId: string, amount: number, method: string): Promise<PgApproval> {
    await this.simulateLatency();
    // 같은 주문번호 재승인 요청은 기존 거래를 반환한다 — 실 PG의 주문번호 중복 방지와 동일
    const existing = this.transactions.get(orderId);
    if (existing) {
      return { pgTxId: existing.pgTxId };
    }
    const pgTxId = `pg_${randomUUID()}`;
    this.transactions.set(orderId, { pgTxId, amount, method });
    return { pgTxId };
  }

  /** 타임아웃 복구용 상태 조회 — 승인 기록이 없으면 그 주문은 PG에 도달하지 않은 것이다 */
  async getStatus(orderId: string): Promise<PgTxStatus> {
    await this.simulateLatency();
    const tx = this.transactions.get(orderId);
    return tx ? { status: 'APPROVED', pgTxId: tx.pgTxId } : { status: 'NOT_FOUND' };
  }

  /** 승인 취소(환불 mock) — 멱등: 이미 취소됐거나 없는 거래여도 오류 없이 끝난다 */
  async cancel(orderId: string): Promise<void> {
    await this.simulateLatency();
    this.transactions.delete(orderId);
  }

  private simulateLatency(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
  }
}
