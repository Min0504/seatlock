import { useEffect, useState } from 'react'

/** 0.5초마다 갱신되는 현재 시각 — 카운트다운 렌더링용 */
export function useCountdownNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return now
}
