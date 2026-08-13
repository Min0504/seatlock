/**
 * 동시성 테스트용 경량 HTTP 클라이언트.
 * supertest(superagent)는 다수의 병렬 요청에서 커넥션 리셋이 발생해(로컬 Node 26 기준)
 * 동시 요청 검증에는 Node 내장 fetch(undici)를 사용한다.
 */
export interface JsonResponse<T> {
  status: number;
  body: T;
}

export async function httpJson<T>(
  baseUrl: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<JsonResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : null) as T,
  };
}
