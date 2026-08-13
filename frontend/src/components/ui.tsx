import type { ReactNode } from 'react'

export function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="size-7 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-400" />
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
      {message}
    </div>
  )
}

export function Badge({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'zinc' | 'indigo' | 'red'
  children: ReactNode
}) {
  const tones = {
    green: 'bg-emerald-950 text-emerald-300 border-emerald-900',
    amber: 'bg-amber-950 text-amber-300 border-amber-900',
    zinc: 'bg-zinc-900 text-zinc-400 border-zinc-800',
    indigo: 'bg-indigo-950 text-indigo-300 border-indigo-900',
    red: 'bg-red-950 text-red-300 border-red-900',
  } as const
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}
