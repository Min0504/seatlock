import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import type { HoldResponse, SeatMapEntry } from '../api/types'
import { useAuth } from '../auth'
import { ErrorNote, Spinner } from '../components/ui'
import { formatWon, remainText } from '../lib/format'

const MAX_SELECT = 4

export default function SeatMapPage() {
  const { showId } = useParams()
  const id = Number(showId)
  const { email } = useAuth()
  const navigate = useNavigate()

  const [seats, setSeats] = useState<SeatMapEntry[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [hold, setHold] = useState<HoldResponse | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [takenFlash, setTakenFlash] = useState<Set<number>>(new Set())
  const [now, setNow] = useState(Date.now())
  const busy = useRef(false)

  const refresh = useCallback(() => {
    api.seatMap(id).then((res) => setSeats(res.seats)).catch(() => {})
  }, [id])

  // 좌석맵은 서버에서 5초 TTL 캐시 — 같은 주기로 폴링해 다른 사용자의 선점을 반영
  useEffect(() => {
    refresh()
    const poll = setInterval(refresh, 5000)
    const tick = setInterval(() => setNow(Date.now()), 500)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [refresh])

  const msLeft = hold ? new Date(hold.expiresAt).getTime() - now : 0
  const countdown = hold ? remainText(msLeft) : null

  // 선점 만료 — 서버의 lazy 판정과 동일하게 프론트도 즉시 만료 취급한다
  useEffect(() => {
    if (hold && msLeft <= 0) {
      setHold(null)
      setNotice('선점이 만료되었습니다. 좌석을 다시 선택해 주세요.')
      refresh()
    }
  }, [hold, msLeft, refresh])

  const toggle = (seat: SeatMapEntry) => {
    if (hold || seat.status !== 'AVAILABLE') return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(seat.id)) next.delete(seat.id)
      else if (next.size < MAX_SELECT) next.add(seat.id)
      return next
    })
  }

  const doHold = async () => {
    if (!email) {
      navigate(`/login?next=/shows/${id}/seats`)
      return
    }
    if (busy.current || selected.size === 0) return
    busy.current = true
    setNotice(null)
    try {
      const res = await api.hold(id, [...selected])
      setHold(res)
      setSelected(new Set())
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SEAT_ALREADY_TAKEN') {
        // 409의 details.seatIds = 방금 다른 사용자에게 선점당한 좌석
        const ids = new Set((err.details?.seatIds as number[] | undefined) ?? [])
        setTakenFlash(ids)
        setTimeout(() => setTakenFlash(new Set()), 2500)
        setNotice('다른 사용자가 먼저 선점한 좌석이 있습니다. 전체 선택이 취소되었습니다(부분 선점 금지).')
        setSelected(new Set())
      } else {
        setNotice(err instanceof ApiError ? err.message : '선점 요청에 실패했습니다')
      }
      refresh()
    } finally {
      busy.current = false
    }
  }

  const doRelease = async () => {
    if (!hold) return
    await api.release(hold.holdGroupId).catch(() => {})
    setHold(null)
    refresh()
  }

  const doReserve = async () => {
    if (!hold || busy.current) return
    busy.current = true
    try {
      const reservation = await api.createReservation(hold.holdGroupId)
      navigate(`/checkout/${reservation.id}`, {
        state: { reservation, seats: hold.seats },
      })
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : '예매 생성에 실패했습니다')
      if (err instanceof ApiError && err.code === 'HOLD_EXPIRED') {
        setHold(null)
        refresh()
      }
    } finally {
      busy.current = false
    }
  }

  const sections = useMemo(() => {
    if (!seats) return []
    const bySection = new Map<string, Map<string, SeatMapEntry[]>>()
    for (const seat of seats) {
      const rows = bySection.get(seat.section) ?? new Map<string, SeatMapEntry[]>()
      const row = rows.get(seat.rowNo) ?? []
      row.push(seat)
      rows.set(seat.rowNo, row)
      bySection.set(seat.section, rows)
    }
    return [...bySection.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([section, rows]) => ({
        section,
        rows: [...rows.entries()]
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
          .map(([rowNo, list]) => ({
            rowNo,
            seats: list.sort((a, b) => a.seatNo - b.seatNo),
          })),
      }))
  }, [seats])

  if (!seats) return <Spinner />

  const selectedSeats = seats.filter((s) => selected.has(s.id))
  const selectedTotal = selectedSeats.reduce((sum, s) => sum + s.price, 0)
  const holdTotal = hold?.seats.reduce((sum, s) => sum + s.price, 0) ?? 0

  const seatClass = (seat: SeatMapEntry): string => {
    if (takenFlash.has(seat.id)) return 'bg-red-600 text-white animate-pulse'
    if (selected.has(seat.id)) return 'bg-indigo-500 text-white'
    if (hold?.seats.some((h) => h.id === seat.id)) return 'bg-indigo-500 text-white ring-2 ring-indigo-300'
    switch (seat.status) {
      case 'AVAILABLE':
        return 'bg-emerald-950 text-emerald-300 border border-emerald-800 hover:bg-emerald-900'
      case 'HELD':
        return 'bg-amber-950/70 text-amber-600 border border-amber-900 cursor-not-allowed'
      case 'RESERVED':
        return 'bg-zinc-900 text-zinc-700 border border-zinc-800 cursor-not-allowed'
    }
  }

  return (
    <div className="pb-32">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">좌석 선택</h1>
          <p className="mt-1 text-sm text-zinc-500">최대 {MAX_SELECT}석 · 선점 후 5분 안에 결제</p>
        </div>
        <div className="flex gap-3 text-xs text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-emerald-800 bg-emerald-950" /> 가능
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-amber-900 bg-amber-950" /> 선점됨
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-zinc-800 bg-zinc-900" /> 판매 완료
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded bg-indigo-500" /> 내 선택
          </span>
        </div>
      </div>

      {notice && (
        <div className="mb-4">
          <ErrorNote message={notice} />
        </div>
      )}

      <div className="mb-6 rounded-lg bg-zinc-900 py-2 text-center text-xs tracking-[0.4em] text-zinc-500">
        STAGE
      </div>

      <div className="space-y-8">
        {sections.map(({ section, rows }) => (
          <div key={section}>
            <h2 className="mb-3 text-sm font-semibold text-zinc-400">{section}구역</h2>
            <div className="space-y-2">
              {rows.map(({ rowNo, seats: rowSeats }) => (
                <div key={rowNo} className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-right text-xs text-zinc-600">{rowNo}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {rowSeats.map((seat) => (
                      <button
                        key={seat.id}
                        onClick={() => toggle(seat)}
                        disabled={!!hold || seat.status !== 'AVAILABLE'}
                        title={`${seat.section}구역 ${seat.rowNo}열 ${seat.seatNo}번 · ${formatWon(seat.price)}`}
                        className={`size-8 rounded text-[11px] font-medium transition ${seatClass(seat)}`}
                      >
                        {seat.seatNo}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {(selected.size > 0 || hold) && (
        <div className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
            {hold ? (
              <>
                <div>
                  <p className="text-sm text-zinc-300">
                    {hold.seats.length}석 선점 완료 · <span className="font-semibold">{formatWon(holdTotal)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-amber-400">
                    남은 시간 <span className="font-mono text-sm font-bold">{countdown ?? '0:00'}</span> — 시간 안에
                    결제하지 않으면 좌석이 자동 반환됩니다
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void doRelease()}
                    className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 hover:border-zinc-500"
                  >
                    선점 해제
                  </button>
                  <button
                    onClick={() => void doReserve()}
                    className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                  >
                    예매 진행
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-300">
                  {selected.size}석 선택 · <span className="font-semibold">{formatWon(selectedTotal)}</span>
                </p>
                <button
                  onClick={() => void doHold()}
                  className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  좌석 선점하기
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
