import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

/**
 * Live scoreboard: every in-season league's matchup for this week, with
 * per-starter points and the state of each player's NFL game, auto-refreshed
 * while games are on.
 */

const POLL_MS = 30_000

interface Starter { name: string; pos: string; slot: string; team: string; points: number; proj: number; game: { state: 'pre' | 'in' | 'post' | 'bye'; detail: string } }
interface Side { name: string; owner?: string; points: number; proj_remaining: number; starters: Starter[]; yet_to_play: number; in_play: number }
interface Matchup {
  platform: 'sleeper' | 'espn'; league_id: string; league: string; week: number
  me: Side | null; opp: Side | null
  scoreboard: { a: { name: string; points: number }; b: { name: string; points: number } }[]
  error?: string
}
interface LiveData { week: number; games: { state: string; count: number }[]; matchups: Matchup[]; updated: string }

const DOT: Record<Starter['game']['state'], string> = { in: 'bg-emerald-400', post: 'bg-muted-foreground', pre: 'bg-amber-400', bye: 'bg-red-400' }

export default function Live() {
  const [data, setData] = useState<LiveData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const load = async () => {
    try {
      const r = await fetch('/api/me/live')
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setData(j); setError(null)
    } catch (e: any) { setError(e.message || String(e)) }
  }
  useEffect(() => {
    load()
    timer.current = window.setInterval(load, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { if (timer.current) window.clearInterval(timer.current); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  const live = data?.games.find((g) => g.state === 'in')?.count || 0

  const side = (s: Side | null, mine: boolean) => s ? (
    <div className="flex-1 min-w-0">
      <div className={cn('text-xs truncate', mine ? 'text-foreground' : 'text-muted-foreground')}>{s.name}</div>
      <div className="text-2xl font-semibold tabular-nums leading-tight">{s.points.toFixed(1)}</div>
      <div className="text-[11px] text-muted-foreground tabular-nums">
        proj {(s.points + s.proj_remaining).toFixed(1)} · {s.in_play} playing · {s.yet_to_play} to play
      </div>
    </div>
  ) : <div className="flex-1 text-sm text-muted-foreground">no matchup</div>

  const roster = (s: Side | null) => s ? (
    <div className="space-y-0.5">
      {s.starters.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', DOT[p.game.state])} title={p.game.detail} />
          <span className="text-muted-foreground w-9 shrink-0">{p.slot}</span>
          <span className="truncate">{p.name} <span className="text-muted-foreground">{p.team}</span></span>
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0">{p.game.state === 'pre' ? `${p.proj.toFixed(1)} proj` : p.game.state === 'bye' ? 'bye' : p.game.detail}</span>
          <span className="w-10 text-right tabular-nums font-medium shrink-0">{p.points.toFixed(1)}</span>
        </div>
      ))}
    </div>
  ) : null

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Live</h1>
          <div className="text-sm text-muted-foreground">
            {data ? <>Week {data.week} · {live > 0 ? <span className="text-emerald-400">{live} game{live === 1 ? '' : 's'} in progress</span> : 'no games in progress'} · refreshes every 30s · updated {new Date(data.updated).toLocaleTimeString()}</> : 'Loading matchups…'}
          </div>
        </div>
        <button onClick={load} className="text-xs text-muted-foreground underline underline-offset-2">refresh now</button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="grid md:grid-cols-2 gap-3">
        {(data?.matchups || []).map((m) => {
          const key = `${m.platform}:${m.league_id}`
          const lead = m.me && m.opp ? m.me.points - m.opp.points : 0
          return (
            <div key={key} className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{m.league}</div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.platform}</span>
              </div>
              {m.error ? <div className="text-xs text-red-400">{m.error}</div> : (
                <>
                  <div className="flex items-center gap-4">
                    {side(m.me, true)}
                    <div className={cn('text-xs font-medium tabular-nums shrink-0', lead > 0 ? 'text-emerald-400' : lead < 0 ? 'text-amber-400' : 'text-muted-foreground')}>
                      {lead > 0 ? `+${lead.toFixed(1)}` : lead < 0 ? lead.toFixed(1) : 'tied'}
                    </div>
                    {side(m.opp, false)}
                  </div>
                  <button onClick={() => setOpen(open === key ? null : key)} className="text-xs text-muted-foreground underline underline-offset-2">
                    {open === key ? 'hide starters' : 'show starters'}
                  </button>
                  {open === key && (
                    <div className="grid sm:grid-cols-2 gap-4 pt-1 border-t border-border">
                      <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">You</div>{roster(m.me)}</div>
                      <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Opponent</div>{roster(m.opp)}</div>
                    </div>
                  )}
                  {m.scoreboard.length > 0 && (
                    <div className="pt-2 border-t border-border">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Around the league</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                        {m.scoreboard.map((g, i) => (
                          <div key={i} className="flex justify-between gap-2 tabular-nums">
                            <span className="truncate">{g.a.name} <span className="text-foreground">{g.a.points.toFixed(1)}</span></span>
                            <span className="truncate text-right"><span className="text-foreground">{g.b.points.toFixed(1)}</span> {g.b.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
      {data && data.matchups.length === 0 && (
        <div className="text-sm text-muted-foreground">No in-season leagues yet — load one from <Link to="/lineup" className="underline underline-offset-2">Start/Sit</Link>.</div>
      )}
      <div className="text-xs text-muted-foreground">
        Dots: <span className="text-emerald-400">●</span> playing · <span className="text-amber-400">●</span> yet to play · <span>●</span> final · <span className="text-red-400">●</span> bye. Projected = points so far + weekly projection for players who haven't played.
      </div>
    </div>
  )
}
