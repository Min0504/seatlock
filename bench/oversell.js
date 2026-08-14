import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

/**
 * 기획서 §8 시나리오 ① — 1,000 VU가 같은 좌석 10개에 선점.
 *
 * VU i 는 좌석 i%10 을 친다. 좌석당 100명이 동시에 돌진하므로
 * 조건부 UPDATE의 승자는 좌석당 정확히 1명, 전체 성공은 정확히 10이어야 한다.
 * 409는 정상 패배. 그 외(5xx·타임아웃)는 초과판매와 별개의 누수다.
 */
const ctx = JSON.parse(open('./out/v4-ctx.json'));

const wins = new Counter('oversell_win');
const conflicts = new Counter('oversell_conflict');
const errors = new Counter('oversell_error');
const latency = new Trend('oversell_latency', true);

export const options = {
  scenarios: {
    rush: {
      executor: 'per-vu-iterations',
      vus: 1000,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    oversell_win: ['count==10'],
    oversell_error: ['count==0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const token = ctx.tokens[(__VU - 1) % ctx.tokens.length];
  const seatId = ctx.hotSeatIds[(__VU - 1) % ctx.hotSeatIds.length];
  const res = http.post(
    `${ctx.baseUrl}/shows/${ctx.showId}/holds`,
    JSON.stringify({ seatIds: [seatId] }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
  );
  latency.add(res.timings.duration);
  if (res.status === 201) wins.add(1);
  else if (res.status === 409) conflicts.add(1);
  else errors.add(1);
}
