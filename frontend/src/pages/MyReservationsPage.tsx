import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, loadTokens } from '../api/client'
import type { ReservationStatus, ReservationSummary } from '../api/types'
import { Badge, ErrorNote, Spinner } from '../components/ui'
import { formatDateTime, formatWon } from '../lib/format'

const STATUS_LABEL: Record<ReservationStatus, { label: string; tone: 'green' | 'amber' | 'zinc' }> = {
  CONFIRMED: { label: '결제 완료', tone: 'green' },
  PENDING: { label: '결제 대기', tone: 'amber' },
  CANCELED: { label: '취소됨', tone: 'zinc' },
}

export default function MyReservationsPage() {
  const [items, setItems] = useState<ReservationSummary[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .myReservations(null)
      .then((res) => {
        setItems(res.items)
        setNextCursor(res.nextCursor)
      })
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 401 ? 'LOGIN' : '목록을 불러오지 못했습니다'),
      )
  }, [])

  useEffect(() => {
    if (!loadTokens()) {
      setError('LOGIN')
      return
    }
    load()
  }, [load])

  const cancel = async (id: number) => {
    setNotice(null)
    try {
      const result = await api.cancelReservation(id)
      setNotice(
        result.releasedSeats > 0
          ? `예매 #${id} 취소 완료 — 좌석 ${result.releasedSeats}석이 판매 가능으로 돌아갔습니다`
          : `예매 #${id} 취소 완료`,
      )
      load()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CANCEL_WINDOW_CLOSED') {
        setNotice('공연 24시간 전에는 취소할 수 없습니다')
      } else {
        setNotice(err instanceof ApiError ? err.message : '취소에 실패했습니다')
      }
    }
  }

  if (error === 'LOGIN') {
    return (
      <div className="py-16 text-center">
        <p className="text-zinc-400">로그인이 필요합니다</p>
        <Link
          to="/login?next=/me/reservations"
          className="mt-4 inline-block rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          로그인
        </Link>
      </div>
    )
  }
  if (error) return <ErrorNote message={error} />
  if (!items) return <Spinner />

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">내 예매</h1>
      {notice && (
        <div className="mb-4 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200">
          {notice}
        </div>
      )}
      {items.length === 0 && (
        <p className="py-16 text-center text-zinc-500">
          예매 내역이 없습니다 —{' '}
          <Link to="/" className="text-indigo-400 hover:underline">
            공연 보러 가기
          </Link>
        </p>
      )}
      <ul className="space-y-4">
        {items.map((r) => {
          const status = STATUS_LABEL[r.status]
          return (
            <li key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold">{r.show.performanceTitle}</h2>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-zinc-400">{formatDateTime(r.show.startsAt)}</p>
                  <p className="mt-2 text-sm text-zinc-500">
                    {r.seats.map((s) => `${s.section}-${s.rowNo}-${s.seatNo}`).join(', ') || '좌석 확정 전'}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-bold">{formatWon(r.totalPrice)}</p>
                  {r.status !== 'CANCELED' && (
                    <button
                      onClick={() => void cancel(r.id)}
                      className="mt-3 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-red-800 hover:text-red-300"
                    >
                      예매 취소
                    </button>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      {nextCursor && (
        <div className="mt-6 text-center">
          <button
            onClick={() =>
              void api.myReservations(nextCursor).then((res) => {
                setItems((prev) => [...(prev ?? []), ...res.items])
                setNextCursor(res.nextCursor)
              })
            }
            className="rounded-lg border border-zinc-800 px-6 py-2 text-sm text-zinc-300 hover:border-zinc-600"
          >
            더 보기
          </button>
        </div>
      )}
    </div>
  )
}
