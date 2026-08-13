import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { PerformanceDetail } from '../api/types'
import { Badge, ErrorNote, Spinner } from '../components/ui'
import { formatDateTime } from '../lib/format'

export default function PerformanceDetailPage() {
  const { id } = useParams()
  const [detail, setDetail] = useState<PerformanceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .performance(Number(id))
      .then(setDetail)
      .catch(() => setError('공연 정보를 불러오지 못했습니다'))
  }, [id])

  if (error) return <ErrorNote message={error} />
  if (!detail) return <Spinner />

  const now = Date.now()

  return (
    <div>
      <h1 className="text-3xl font-bold">{detail.title}</h1>
      <p className="mt-2 text-zinc-400">
        {detail.venue.name} · {detail.venue.address}
      </p>
      {detail.description && <p className="mt-4 max-w-2xl text-sm text-zinc-300">{detail.description}</p>}

      <h2 className="mb-4 mt-10 text-lg font-semibold">회차 선택</h2>
      {detail.shows.length === 0 && <p className="text-zinc-500">등록된 회차가 없습니다</p>}
      <ul className="space-y-3">
        {detail.shows.map((show) => {
          const open = new Date(show.ticketOpenAt).getTime() <= now
          return (
            <li key={show.id}>
              <Link
                to={open ? `/shows/${show.id}/seats` : '#'}
                aria-disabled={!open}
                className={`flex items-center justify-between rounded-xl border px-5 py-4 transition ${
                  open
                    ? 'border-zinc-800 bg-zinc-900/60 hover:border-indigo-700'
                    : 'pointer-events-none border-zinc-900 bg-zinc-950 opacity-60'
                }`}
              >
                <div>
                  <p className="font-medium">{formatDateTime(show.startsAt)}</p>
                  {!open && (
                    <p className="mt-1 text-xs text-zinc-500">
                      티켓 오픈 {formatDateTime(show.ticketOpenAt)}
                    </p>
                  )}
                </div>
                {open ? <Badge tone="green">예매 가능</Badge> : <Badge tone="zinc">오픈 전</Badge>}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
