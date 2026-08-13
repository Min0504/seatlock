import { useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import type { CreatedReservation, HeldSeat, PaymentMethod, PaymentView } from '../api/types'
import { Badge, ErrorNote } from '../components/ui'
import { formatWon, remainText } from '../lib/format'
import { useCountdownNow } from './useCountdownNow'

interface CheckoutState {
  reservation: CreatedReservation
  seats: HeldSeat[]
}

export default function CheckoutPage() {
  const { reservationId } = useParams()
  const state = useLocation().state as CheckoutState | null
  // 결제 시도 단위로 한 번만 생성 — 재클릭·네트워크 재시도가 전부 같은 키로 나가
  // 서버가 중복을 재생(200)한다. 이것이 이중 결제를 막는 클라이언트 측 절반이다.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])

  const [method, setMethod] = useState<PaymentMethod>('CARD')
  const [payment, setPayment] = useState<PaymentView | null>(null)
  const [replayed, setReplayed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clicks, setClicks] = useState(0)
  const now = useCountdownNow()

  if (!state) {
    return (
      <div className="mx-auto max-w-md text-center">
        <p className="text-zinc-400">체크아웃 정보가 만료되었습니다.</p>
        <Link to="/me/reservations" className="mt-4 inline-block text-indigo-400 hover:underline">
          내 예매에서 확인하기 →
        </Link>
      </div>
    )
  }

  const { reservation, seats } = state
  const msLeft = new Date(reservation.payUntil).getTime() - now
  const countdown = remainText(msLeft)
  const expired = !payment && !countdown

  const pay = () => {
    setClicks((c) => c + 1)
    setError(null)
    // 의도적으로 버튼을 잠그지 않는다 — 연타해도 안전함을 보여주는 데모.
    api
      .pay(Number(reservationId), method, idempotencyKey)
      .then((view) => {
        setPayment((prev) => {
          if (prev) setReplayed(true)
          return view
        })
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === 'PAYMENT_IN_PROGRESS') {
          setError('같은 결제가 처리 중입니다 — 잠시 후 다시 눌러 주세요 (동시 요청 직렬화)')
        } else {
          setError(err instanceof ApiError ? err.message : '결제에 실패했습니다')
        }
      })
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-2xl font-bold">결제</h1>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <ul className="space-y-2 text-sm">
          {seats.map((s) => (
            <li key={s.id} className="flex justify-between">
              <span className="text-zinc-300">
                {s.section}구역 {s.rowNo}열 {s.seatNo}번
              </span>
              <span className="text-zinc-400">{formatWon(s.price)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-between border-t border-zinc-800 pt-4">
          <span className="font-semibold">총 {reservation.seatCount}석</span>
          <span className="text-lg font-bold text-indigo-300">{formatWon(reservation.totalPrice)}</span>
        </div>
      </div>

      {payment ? (
        <div className="mt-6 rounded-xl border border-emerald-900 bg-emerald-950/40 p-5 text-center">
          <Badge tone="green">결제 완료</Badge>
          <p className="mt-3 text-lg font-bold">{formatWon(payment.amount)}</p>
          <p className="mt-1 text-xs text-zinc-500">PG 승인번호 {payment.pgTxId}</p>
          {replayed && (
            <p className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-amber-300">
              버튼을 {clicks}번 눌렀지만 결제는 1건입니다 — 같은 Idempotency-Key는 기존 결과를
              재생(200 OK)합니다
            </p>
          )}
          <Link
            to="/me/reservations"
            className="mt-4 inline-block rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            내 예매 보기
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-4 text-center text-sm">
            {expired ? (
              <span className="text-red-400">결제 시간이 지났습니다 — 좌석이 자동 반환됩니다</span>
            ) : (
              <span className="text-amber-400">
                남은 시간 <span className="font-mono font-bold">{countdown}</span>
              </span>
            )}
          </p>

          <div className="mt-4 flex gap-2">
            {(['CARD', 'EASY_PAY'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition ${
                  method === m
                    ? 'border-indigo-500 bg-indigo-950/60 text-indigo-200'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600'
                }`}
              >
                {m === 'CARD' ? '카드 결제' : '간편 결제'}
              </button>
            ))}
          </div>

          {error && (
            <div className="mt-4">
              <ErrorNote message={error} />
            </div>
          )}

          <button
            onClick={pay}
            disabled={expired}
            className="mt-4 w-full rounded-lg bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            {formatWon(reservation.totalPrice)} 결제하기
          </button>
          <p className="mt-3 text-center text-xs text-zinc-600">
            데모: 연타해도 안전합니다 — 모든 클릭이 같은 Idempotency-Key로 나갑니다
            {clicks > 1 && ` (현재 ${clicks}번 클릭)`}
          </p>
        </>
      )}
    </div>
  )
}
