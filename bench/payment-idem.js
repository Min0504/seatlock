import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

/**
 * 기획서 §8 시나리오 ③ — 같은 Idempotency-Key 동시 재시도.
 *
 * 클라이언트 타임아웃 재시도 폭주를 흉내 낸다. 201은 결제 실행 1회,
 * 200은 재생, 409는 처리 중. 결제 행은 1건이어야 하며 SQL로 한 번 더 확인한다.
 */
const ctx = JSON.parse(open('./out/v4-ctx.json'));
const p = ctx.payment;

const created = new Counter('pay_created');
const replayed = new Counter('pay_replayed');
const inProgress = new Counter('pay_in_progress');
const errors = new Counter('pay_error');
const latency = new Trend('pay_latency', true);

export const options = {
  scenarios: {
    storm: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.VUS || 50),
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    pay_created: ['count==1'],
    pay_error: ['count==0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.post(
    `${ctx.baseUrl}/payments`,
    JSON.stringify({ reservationId: p.reservationId, method: 'CARD' }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.token}`,
        'Idempotency-Key': p.idempotencyKey,
      },
    },
  );
  latency.add(res.timings.duration);
  if (res.status === 201) created.add(1);
  else if (res.status === 200) replayed.add(1);
  else if (res.status === 409) inProgress.add(1);
  else errors.add(1);
}
