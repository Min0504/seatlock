import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

/**
 * 좌석 선점 경합 벤치마크 — 락 전략 비교의 측정 도구 (docs/lock-benchmark.md).
 *
 * 시나리오 두 개를 순차 실행한다:
 * - single_seat: 100명이 "같은 좌석 1개"에 동시 돌진 — 티케팅 오픈 순간의 최악 경합.
 *   성공은 정확히 1이어야 하고(초과판매 0의 재확인), 관심사는 "패자 99명이 얼마나
 *   빨리/어떤 비용으로 실패하느냐"다. 락 전략별 차이가 가장 극명한 지점.
 * - spread: 50 VU가 40석 풀에서 무작위 좌석을 잡았다 놓기를 20초 반복 — 오픈 직후
 *   좌석맵 곳곳에서 벌어지는 중간 강도 경합. 지속 처리량과 p95가 관심사.
 *
 * 실행은 bench/run.sh가 한다 (DB 초기화 → 앱 기동 → 시드 → k6 → 결과 저장).
 */
const ctx = JSON.parse(open('./out/ctx.json'));

const wins = new Counter('hold_win');
const conflicts = new Counter('hold_conflict'); // 409 SEAT_ALREADY_TAKEN — 정상 패배
const errors = new Counter('hold_error');       // 그 외 — 전략이 새는 지점
const singleLatency = new Trend('single_seat_latency', true);
const spreadLatency = new Trend('spread_latency', true);

export const options = {
  scenarios: {
    single_seat: {
      executor: 'per-vu-iterations',
      vus: 100,
      iterations: 1,
      exec: 'singleSeat',
      maxDuration: '30s',
    },
    spread: {
      executor: 'constant-vus',
      vus: 50,
      duration: '20s',
      exec: 'spread',
      startTime: '15s', // single_seat가 끝난 뒤 시작
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

function hold(token, seatIds) {
  return http.post(
    `${ctx.baseUrl}/shows/${ctx.showId}/holds`,
    JSON.stringify({ seatIds }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
  );
}

function tally(res) {
  if (res.status === 201) wins.add(1);
  else if (res.status === 409) conflicts.add(1);
  else errors.add(1);
}

export function singleSeat() {
  // VU마다 다른 사용자 — 1인 보유 상한(4석)이 결과를 오염시키지 않게 한다
  const token = ctx.tokens[(__VU - 1) % ctx.tokens.length];
  const res = hold(token, [ctx.seatIds[0]]);
  singleLatency.add(res.timings.duration);
  tally(res);
}

export function spread() {
  const token = ctx.tokens[(__VU - 1) % ctx.tokens.length];
  // seat[0]은 single_seat의 승자가 쥐고 있다 — 풀에서 제외
  const pool = ctx.seatIds.slice(1, 41);
  const seatId = pool[Math.floor(Math.random() * pool.length)];
  const res = hold(token, [seatId]);
  spreadLatency.add(res.timings.duration);
  tally(res);
  if (res.status === 201) {
    // 잡았다 즉시 놓는다 — 보유 상한을 피하면서 경합 압력을 유지하는 패턴
    http.del(`${ctx.baseUrl}/holds/${res.json('holdGroupId')}`, null, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
