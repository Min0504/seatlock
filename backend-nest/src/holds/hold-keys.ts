/**
 * 선점 TTL Redis 키 규약 — `hold:{showSeatId}` (기획서 §아키텍처).
 * 생산자(HoldsService)와 소비자(HoldExpiryListener)가 같은 규약을 바라보도록 한 곳에 둔다.
 */
export const HOLD_KEY_PREFIX = 'hold:';

export function holdKey(showSeatId: bigint): string {
  return `${HOLD_KEY_PREFIX}${showSeatId}`;
}

/** `hold:123` → 123n, 규약에 맞지 않는 키는 null */
export function parseHoldKey(key: string): bigint | null {
  if (!key.startsWith(HOLD_KEY_PREFIX)) {
    return null;
  }
  const raw = key.slice(HOLD_KEY_PREFIX.length);
  return /^\d+$/.test(raw) ? BigInt(raw) : null;
}
