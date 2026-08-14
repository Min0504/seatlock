import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

/**
 * 기획서 §8 시나리오 ② — 좌석맵 조회 RPS/p95.
 *
 * 캐시 on: Redis HIT (DB 미접촉). 캐시 off: Redis stop 후 DB 직행.
 * 두 런을 같은 RPS로 비교하는 것이 측정 목적이다. LABEL은 파일명 구분용.
 */
const ctx = JSON.parse(open('./out/v4-ctx.json'));
const ok = new Rate('seatmap_ok');
const latency = new Trend('seatmap_ms', true);

export const options = {
  scenarios: {
    read: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '15s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    seatmap_ok: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  // 캐시 on 런은 워밍이 필요하다. off 런은 Redis가 죽어 HIT가 불가능하다.
  http.get(`${ctx.baseUrl}/shows/${ctx.showId}/seats`);
}

export default function () {
  const res = http.get(`${ctx.baseUrl}/shows/${ctx.showId}/seats`);
  latency.add(res.timings.duration);
  ok.add(res.status === 200);
  check(res, { '200': (r) => r.status === 200 });
}
