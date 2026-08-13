export function formatWon(n: number): string {
  return `${n.toLocaleString('ko-KR')}원`
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** mm:ss 카운트다운 문자열 (만료 시 null) */
export function remainText(msLeft: number): string | null {
  if (msLeft <= 0) return null
  const s = Math.floor(msLeft / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
