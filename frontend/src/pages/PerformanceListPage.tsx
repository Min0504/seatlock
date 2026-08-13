import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { PerformanceListItem } from '../api/types'
import { ErrorNote, Spinner } from '../components/ui'

export default function PerformanceListPage() {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<PerformanceListItem[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .performances(q, null)
        .then((res) => {
          setItems(res.items)
          setNextCursor(res.nextCursor)
          setError(null)
        })
        .catch(() => setError('공연 목록을 불러오지 못했습니다'))
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  const loadMore = () => {
    if (!nextCursor) return
    void api.performances(q, nextCursor).then((res) => {
      setItems((prev) => [...(prev ?? []), ...res.items])
      setNextCursor(res.nextCursor)
    })
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="mb-1 text-2xl font-bold">공연</h1>
        <p className="mb-4 text-sm text-zinc-500">
          검색은 pg_trgm GIN 인덱스, 첫 페이지는 Redis 60초 캐시로 응답한다
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="공연명·공연장 검색"
          className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
        />
      </div>

      {error && <ErrorNote message={error} />}
      {!items && !error && <Spinner />}

      {items && (
        <>
          {items.length === 0 && <p className="py-12 text-center text-zinc-500">검색 결과가 없습니다</p>}
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/performances/${p.id}`}
                  className="block rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 transition hover:border-indigo-700 hover:bg-zinc-900"
                >
                  <div className="mb-3 flex h-28 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-950 to-zinc-900 text-3xl font-black text-indigo-800">
                    {p.title.slice(0, 1)}
                  </div>
                  <h2 className="font-semibold">{p.title}</h2>
                  <p className="mt-1 text-sm text-zinc-500">{p.venueName}</p>
                </Link>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <div className="mt-8 text-center">
              <button
                onClick={loadMore}
                className="rounded-lg border border-zinc-800 px-6 py-2 text-sm text-zinc-300 hover:border-zinc-600"
              >
                더 보기
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
