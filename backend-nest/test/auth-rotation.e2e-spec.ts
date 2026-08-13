import { randomUUID } from 'node:crypto';
import { httpJson } from './helpers/http';
import { createTestApp, teardownTestApp, TestContext } from './helpers/test-app';

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  code?: string;
}

/**
 * Refresh Token Rotation + 재사용 탐지 검증 (기획서 §7 문제 4).
 *
 * 위협 모델: Refresh 토큰은 14일 유효하다 — 탈취되면 장기간 세션이 도용된다.
 * v1(stateless refresh)은 서명만 검증하므로 탈취범이 유효기간 내내 조용히
 * 토큰을 갱신하며 세션을 유지해도 서버가 알 방법이 없다.
 *
 * Rotation의 계약:
 * - refresh 1회 = 토큰 쌍 교체. 이전 refresh 토큰은 그 자리에서 소모(used)된다
 * - used 토큰의 재등장 = 정상 사용자와 탈취범 둘 다 토큰을 쓴 유일한 경우
 *   → family 전체 폐기로 양쪽 모두 재로그인 강제 (도용 세션의 즉시 차단)
 * - 같은 토큰의 동시 refresh는 정확히 1건만 성공 (토큰 쌍 이중 발급 금지)
 */
describe('Refresh Rotation — 탈취 재사용 탐지 (e2e)', () => {
  let ctx: TestContext;
  let base: string;

  let emailSeq = 0;

  /** 테스트마다 새 계정 — family 상태가 테스트 간에 섞이지 않게 한다 */
  async function loginFresh(): Promise<TokenPairResponse> {
    const email = `rotation${emailSeq++}@test.com`;
    const password = 'password1234';
    const signup = await httpJson(base, 'POST', '/auth/signup', { body: { email, password } });
    expect(signup.status).toBe(201);
    const login = await httpJson<TokenPairResponse>(base, 'POST', '/auth/login', {
      body: { email, password },
    });
    expect(login.status).toBe(200);
    return login.body;
  }

  const refresh = (refreshToken: string) =>
    httpJson<TokenPairResponse>(base, 'POST', '/auth/refresh', { body: { refreshToken } });

  beforeAll(async () => {
    ctx = await createTestApp();
    base = ctx.baseUrl;
  }, 180000);

  afterAll(async () => {
    await teardownTestApp(ctx);
  });

  it('refresh하면 새 쌍이 발급되고, 소모된 이전 토큰은 즉시 무효다', async () => {
    const first = await loginFresh();

    const rotated = await refresh(first.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);

    // 방금 소모된 토큰의 재사용 — stateless(v1)라면 서명이 유효해 200이 나온다
    const reuse = await refresh(first.refreshToken);
    expect(reuse.status).toBe(401);
  });

  it('재사용 탐지는 family 전체를 폐기한다 — 탈취범이 이어받은 세션도 죽는다', async () => {
    // 피해자 로그인 → 탈취범이 refresh 토큰을 복사해갔다고 가정
    const victim = await loginFresh();
    const stolen = victim.refreshToken;

    // 탈취범이 먼저 갱신에 성공해 새 쌍을 확보한다 (피해자는 아직 모른다)
    const attacker = await refresh(stolen);
    expect(attacker.status).toBe(200);

    // 피해자의 앱이 원래 토큰으로 갱신 시도 → used 토큰의 재등장 = 탈취 신호
    const detected = await refresh(stolen);
    expect(detected.status).toBe(401);

    // 핵심: 탐지 순간 family 전체가 폐기돼 탈취범이 확보한 새 토큰도 무효가 된다.
    // 이 한 줄이 없으면 "재사용은 거부하지만 도둑의 세션은 계속 살아있는" 반쪽 방어다.
    const attackerContinues = await refresh(attacker.body.refreshToken);
    expect(attackerContinues.status).toBe(401);
  });

  it('같은 토큰의 동시 refresh 경합 — 새 쌍 발급은 정확히 1건이어야 한다', async () => {
    const { refreshToken } = await loginFresh();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => refresh(refreshToken)),
    );

    const distribution = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[동시 refresh 분포] ${JSON.stringify(distribution)}`);

    // 토큰 1개 = 갱신 1회. 2건 이상 성공하면 유효한 세션이 복제된 것이다.
    // (경합 패자의 401이 family를 폐기하는지는 도착 시점에 따라 갈리므로 단정하지 않는다 —
    //  둘 다 "재로그인"으로 수렴하며, 보안 실패는 오직 이중 발급뿐이다)
    const successes = responses.filter((r) => r.status === 200);
    expect(successes).toHaveLength(1);
  });

  it('로그아웃은 family를 폐기한다 — 남은 refresh 토큰이 전부 무효', async () => {
    const { accessToken, refreshToken } = await loginFresh();
    const rotated = await refresh(refreshToken);
    expect(rotated.status).toBe(200);

    const logout = await httpJson(base, 'POST', '/auth/logout', {
      token: rotated.body.accessToken,
      body: { refreshToken: rotated.body.refreshToken },
    });
    expect([200, 204]).toContain(logout.status);

    const afterLogout = await refresh(rotated.body.refreshToken);
    expect(afterLogout.status).toBe(401);

    // access 토큰은 stateless라 만료(15분)까지 유효하다 — 이 트레이드오프는
    // 문서화된 설계 결정이다 (전면 상태화는 매 요청 DB 조회 비용)
    void accessToken;
  });

  it('로그인은 독립된 family를 만든다 — 한 기기의 폐기가 다른 기기를 죽이지 않는다', async () => {
    const email = `rotation-multi@test.com`;
    const password = 'password1234';
    await httpJson(base, 'POST', '/auth/signup', { body: { email, password } });
    const deviceA = await httpJson<TokenPairResponse>(base, 'POST', '/auth/login', {
      body: { email, password },
    });
    const deviceB = await httpJson<TokenPairResponse>(base, 'POST', '/auth/login', {
      body: { email, password },
    });

    // 기기 A에서 재사용 탐지 유발 → A의 family만 폐기
    const rotatedA = await refresh(deviceA.body.refreshToken);
    expect(rotatedA.status).toBe(200);
    await refresh(deviceA.body.refreshToken); // 재사용 → family A 폐기

    const deviceBStillAlive = await refresh(deviceB.body.refreshToken);
    expect(deviceBStillAlive.status).toBe(200);
  });

  it('위조·변조 토큰과 access 토큰은 형태와 무관하게 401 (회귀 가드)', async () => {
    const { accessToken } = await loginFresh();

    const withAccess = await refresh(accessToken);
    expect(withAccess.status).toBe(401);

    const forged = await refresh(`${randomUUID()}.${randomUUID()}.${randomUUID()}`);
    expect(forged.status).toBe(401);
  });
});
