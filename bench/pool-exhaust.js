import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

/**
 * Hikari 풀 고갈 재현 — 풀 2칸·타임아웃 500ms에 300명이 동시에 선점하면
 * 뒤쪽 대기자는 커넥션을 못 받아 503 SERVICE_UNAVAILABLE 을 받는다.
 * "무한 대기" 대신 빠르게 거절하는 것이 기획서 §10 장애 3의 조치다.
 */
const ctx = JSON.parse(open('./out/v4-ctx.json'));
const pool = ctx.poolSeats;

const ok = new Counter('pool_ok');
const busy = new Counter('pool_503');
const other = new Counter('pool_other');
const latency = new Trend('pool_latency', true);

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: 300,
      iterations: 1,
      maxDuration: '20s',
    },
  },
  thresholds: {
    pool_503: ['count>0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'max'],
};

export default function () {
  const token = ctx.tokens[(__VU - 1) % ctx.tokens.length];
  const seatId = pool[(__VU - 1) % pool.length];
  const res = http.post(
    `${ctx.baseUrl}/shows/${ctx.showId}/holds`,
    JSON.stringify({ seatIds: [seatId] }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
  );
  latency.add(res.timings.duration);
  if (res.status === 201 || res.status === 409) ok.add(1);
  else if (res.status === 503) busy.add(1);
  else other.add(1);
}
