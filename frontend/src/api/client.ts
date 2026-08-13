import type {
  ApiErrorBody,
  CancelResult,
  CreatedReservation,
  HoldResponse,
  MyReservationsResponse,
  PaymentMethod,
  PaymentView,
  PerformanceDetail,
  PerformanceListResponse,
  SeatMapResponse,
  TokenPair,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const TOKEN_KEY = 'seatlock.tokens'
const EMAIL_KEY = 'seatlock.email'

export function loadTokens(): TokenPair | null {
  const raw = localStorage.getItem(TOKEN_KEY)
  return raw ? (JSON.parse(raw) as TokenPair) : null
}

export function saveSession(tokens: TokenPair, email?: string): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
  if (email) localStorage.setItem(EMAIL_KEY, email)
}

export function loadEmail(): string | null {
  return localStorage.getItem(EMAIL_KEY)
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EMAIL_KEY)
}

async function parseError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null
  return new ApiError(
    res.status,
    body?.code ?? 'UNKNOWN',
    body?.message ?? `HTTP ${res.status}`,
    body?.details,
  )
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  auth?: boolean
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const doFetch = (accessToken?: string) =>
    fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        ...opts.headers,
      },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    })

  let res = await doFetch(opts.auth ? (loadTokens()?.accessToken ?? undefined) : undefined)

  // Access 만료(401) 시 refresh 1회 재시도 — rotation이라 새 pair로 교체된다
  if (res.status === 401 && opts.auth) {
    const tokens = loadTokens()
    if (!tokens) throw await parseError(res)
    const refreshed = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    })
    if (!refreshed.ok) {
      clearSession()
      throw await parseError(res)
    }
    const pair = (await refreshed.json()) as TokenPair
    saveSession(pair)
    res = await doFetch(pair.accessToken)
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  signup: (email: string, password: string) =>
    request<{ id: number; email: string }>('/auth/signup', {
      method: 'POST',
      body: { email, password },
    }),

  login: (email: string, password: string) =>
    request<TokenPair>('/auth/login', { method: 'POST', body: { email, password } }),

  logout: (refreshToken: string) =>
    request<void>('/auth/logout', { method: 'POST', body: { refreshToken }, auth: true }),

  performances: (q: string, cursor: string | null) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (cursor) params.set('cursor', cursor)
    const qs = params.toString()
    return request<PerformanceListResponse>(`/performances${qs ? `?${qs}` : ''}`)
  },

  performance: (id: number) => request<PerformanceDetail>(`/performances/${id}`),

  seatMap: (showId: number) => request<SeatMapResponse>(`/shows/${showId}/seats`),

  hold: (showId: number, seatIds: number[]) =>
    request<HoldResponse>(`/shows/${showId}/holds`, {
      method: 'POST',
      body: { seatIds },
      auth: true,
    }),

  release: (holdGroupId: string) =>
    request<{ releasedSeats: number }>(`/holds/${holdGroupId}`, {
      method: 'DELETE',
      auth: true,
    }),

  createReservation: (holdGroupId: string) =>
    request<CreatedReservation>('/reservations', {
      method: 'POST',
      body: { holdGroupId },
      auth: true,
    }),

  // 같은 체크아웃 내 재시도는 같은 키로 — 서버가 재생(200)해 이중 결제가 없다
  pay: (reservationId: number, method: PaymentMethod, idempotencyKey: string) =>
    request<PaymentView>('/payments', {
      method: 'POST',
      body: { reservationId, method },
      headers: { 'Idempotency-Key': idempotencyKey },
      auth: true,
    }),

  myReservations: (cursor: string | null) =>
    request<MyReservationsResponse>(`/me/reservations${cursor ? `?cursor=${cursor}` : ''}`, {
      auth: true,
    }),

  cancelReservation: (id: number) =>
    request<CancelResult>(`/reservations/${id}`, { method: 'DELETE', auth: true }),
}
