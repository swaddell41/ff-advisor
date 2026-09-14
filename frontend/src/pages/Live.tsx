import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

/**
 * Live: a feed ranked by what matters right now. The backend scores every
 * card — red-zone drives, scoring bursts since the last poll, close
 * matchups with players on the field, conflicts while they're playing,
 * leaderboards — and the page renders in that order. Auto-refreshes.
 */

const POLL_MS = 30_000

interface Starter { name: string; pos: string; slot: string; team: string; points: number; proj: number; proj_live?: number; game: { state: 'pre' | 'in' | 'post' | 'bye'; detail: string; frac?: number } }
interface Side { name: string; owner?: string; points: number; proj_remaining: number; starters: Starter[]; yet_to_play: number; in_play: number }
interface Matchup {
  platform: 'sleeper' | 'espn'; league_id: string; league: string; week: number
  me: Side | null; opp: Side | null
  scoreboard: { a: { name: string; points: number }; b: { name: string; points: number } }[]
  error?: string
}
interface Agg { name: string; pos: string; team: string; points: number; leagues?: string[]; game?: { state: string; detail: string } }
interface RZ { name: string; pos: string; team: string; league: string; situation: string; detail: string; vs?: string | null }
interface Conflict extends Agg { have_in: string[]; face_in: string[] }
type FeedItem =
  | { kind: 'redzone'; score: number; mine: RZ[]; opp: RZ[] }
  | { kind: 'score'; score: number; name: string; pos: string; team: string; delta: number; points: number; game?: { state: string; detail: string }; mine: string[]; opp: string[]; ts: number }
  | { kind: 'matchup'; score: number; platform: string; league_id: string; live_players: number; margin: number }
  | { kind: 'conflicts'; score: number; live: number }
  | { kind: 'top'; score: number }
interface LiveData {
  week: number; games: { state: string; count: number }[]; matchups: Matchup[]; updated: string
  red_zone?: { mine: RZ[]; opp: RZ[] }; top?: { mine: Agg[]; opp: Agg[] }; conflicts?: Conflict[]; feed?: FeedItem[]
}

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
  const byKey = new Map((data?.matchups || []).map((m) => [`${m.platform}:${m.league_id}`, m]))
  const feed = data?.feed || []
  const closeLive = feed.filter((f) => f.kind === 'matchup' && (f as any).live_players > 0 && (f as any).margin < 15).length
  const bursts = feed.filter((f) => f.kind === 'score').length

  const side = (s: Side | null, mine: boolean) => s ? (
    <div className="flex-1 min-w-0">
      <div className={cn('text-xs truncate', mine ? 'text-foreground' : 'text-muted-foreground')}>{s.name}</div>
      <div className="text-2xl font-semibold tabular-nums leading-tight">{s.points.toFixed(1)}</div>
      <div className="text-[11px] text-muted-foreground tabular-nums">proj {(s.points + s.proj_remaining).toFixed(1)} · {s.in_play} playing · {s.yet_to_play} to play</div>
    </div>
  ) : <div className="flex-1 text-sm text-muted-foreground">no matchup</div>

  const roster = (s: Side | null) => s ? (
    <div className="space-y-0.5">
      {s.starters.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', DOT[p.game.state])} title={p.game.detail} />
          <span className="text-muted-foreground w-9 shrink-0">{p.slot}</span>
          <span className="truncate">{p.name} <span className="text-muted-foreground">{p.team}</span></span>
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0">{p.game.state === 'pre' ? `${p.proj.toFixed(1)} proj` : p.game.state === 'bye' ? 'bye' : p.game.state === 'in' && p.proj_live != null ? `${p.game.detail} · → ${p.proj_live.toFixed(1)}` : p.game.detail}</span>
          <span className="w-10 text-right tabular-nums font-medium shrink-0">{p.points.toFixed(1)}</span>
        </div>
      ))}
    </div>
  ) : null

  const matchupCard = (m: Matchup, liveCount: number) => {
    const key = `${m.platform}:${m.league_id}`
    const lead = m.me && m.opp ? m.me.points - m.opp.points : 0
    return (
      <div key={key} className={cn('rounded-xl border bg-card p-4 space-y-3', liveCount > 0 ? 'border-emerald-500/30' : 'border-border')}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{m.league}</div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {liveCount > 0 && <span className="text-emerald-400">● {liveCount} on the field</span>}
            <span>{m.platform}</span>
          </div>
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
  }

  const rzList = (rows: RZ[], mine: boolean) => rows.length === 0 ? <div className="text-xs text-muted-foreground">none</div> : rows.map((r, i) => (
    <div key={i} className="flex items-center gap-2 text-sm">
      <span className={cn('inline-block w-1.5 h-1.5 rounded-full animate-pulse', mine ? 'bg-red-400' : 'bg-amber-400')} />
      <span className="font-medium">{r.name}</span><span className="text-xs text-muted-foreground">{r.pos} · {r.team} · {r.situation || r.detail}</span>
      <span className="ml-auto text-xs text-muted-foreground">{r.league}{r.vs ? ` · ${r.vs}` : ''}</span>
    </div>
  ))

  const topList = (rows: Agg[]) => rows.length === 0 ? <div className="text-xs text-muted-foreground">no points yet</div> : rows.map((r, i) => (
    <div key={i} className="flex items-center gap-2 text-sm py-0.5">
      <span className="text-muted-foreground w-4 tabular-nums">{i + 1}</span>
      <span className="truncate">{r.name} <span className="text-xs text-muted-foreground">{r.pos} · {r.team}{r.leagues && r.leagues.length > 1 ? ` · ×${r.leagues.length}` : ''}</span></span>
      <span className="ml-auto tabular-nums font-medium">{r.points.toFixed(1)}</span>
    </div>
  ))

  const renderItem = (f: FeedItem, i: number) => {
    switch (f.kind) {
      case 'redzone':
        return (
          <div key={`rz${i}`} className="rounded-xl border border-red-500/40 bg-red-500/5 p-4">
            <div className="text-[11px] uppercase tracking-wider text-red-400 mb-2">In the red zone right now</div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Your players</div>{rzList(f.mine, true)}</div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Opponents' players</div>{rzList(f.opp, false)}</div>
            </div>
          </div>
        )
      case 'score': {
        const good = f.mine.length > 0
        const bad = f.opp.length > 0
        const age = data ? Math.max(0, Math.round((new Date(data.updated).getTime() / 1000 - f.ts) / 60)) : 0
        return (
          <div key={`sc${i}`} className={cn('rounded-xl border p-3 flex items-center gap-3', good && !bad ? 'border-emerald-500/40 bg-emerald-500/5' : bad && !good ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card')}>
            <div className={cn('text-xl font-semibold tabular-nums shrink-0', f.delta > 0 ? (good && !bad ? 'text-emerald-400' : bad && !good ? 'text-amber-400' : '') : 'text-red-400')}>
              {f.delta > 0 ? '+' : ''}{f.delta.toFixed(1)}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{f.name} <span className="text-xs text-muted-foreground">{f.pos} · {f.team}{f.game?.detail ? ` · ${f.game.detail}` : ''} · now {f.points.toFixed(1)}</span></div>
              <div className="text-[11px] text-muted-foreground">
                {good && <span className="text-emerald-400">yours in {f.mine.join(', ')}</span>}
                {good && bad && ' · '}
                {bad && <span className="text-amber-400">against you in {f.opp.join(', ')}</span>}
                {age > 0 && ` · ${age}m ago`}
              </div>
            </div>
          </div>
        )
      }
      case 'matchup': {
        const m = byKey.get(`${f.platform}:${f.league_id}`)
        return m ? matchupCard(m, f.live_players) : null
      }
      case 'conflicts':
        return (
          <div key={`cf${i}`} className="rounded-xl border border-border bg-card p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Conflicted rooting{f.live > 0 ? <span className="text-emerald-400"> · {f.live} playing now</span> : ''}</div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
              {(data?.conflicts || []).map((c, j) => (
                <div key={j} className="text-sm py-0.5">
                  <div className="flex items-center gap-2">
                    <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', DOT[(c.game?.state as Starter['game']['state']) || 'pre'])} />
                    <span className="truncate">{c.name} <span className="text-xs text-muted-foreground">{c.pos} · {c.team}</span></span>
                    <span className="ml-auto tabular-nums font-medium">{c.points.toFixed(1)}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground pl-3.5">yours in {c.have_in.join(', ')} · against you in {c.face_in.join(', ')}</div>
                </div>
              ))}
            </div>
          </div>
        )
      case 'top':
        return (
          <div key={`top${i}`} className="grid md:grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-[11px] uppercase tracking-wider text-emerald-400 mb-2">Your top performers</div>{topList(data?.top?.mine || [])}
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-[11px] uppercase tracking-wider text-amber-400 mb-2">Top players against you</div>{topList(data?.top?.opp || [])}
            </div>
          </div>
        )
    }
  }

  // Sections: group the ranked feed by kind, order sections by their hottest
  // item, keep items ranked inside. Clear breaks, still dynamic.
  const SECTION: Record<FeedItem['kind'], { label: string; caption: (items: FeedItem[]) => string; accent: string }> = {
    redzone: { label: 'Red zone', caption: () => 'drives inside the 20 involving your players or your opponents\'', accent: 'text-red-400 border-red-500/40' },
    score: { label: 'Just happened', caption: (it) => `${it.length} scoring play${it.length === 1 ? '' : 's'} in the last 20 minutes · newest and biggest first`, accent: 'text-emerald-400 border-emerald-500/40' },
    matchup: {
      label: 'Your matchups',
      caption: (it) => {
        const liveN = it.filter((f) => f.kind === 'matchup' && f.live_players > 0).length
        return liveN > 0 ? `${liveN} with players on the field · closest first, decided games last` : 'closest first · decided games last'
      },
      accent: 'text-foreground border-border',
    },
    conflicts: { label: 'Conflicted rooting', caption: (it) => { const f = it[0]; return f.kind === 'conflicts' && f.live > 0 ? `${f.live} of these players are on the field right now` : 'players you start in one league and face in another' }, accent: 'text-muted-foreground border-border' },
    top: { label: 'Leaderboards', caption: () => 'best per player across all your leagues, yours vs against you', accent: 'text-muted-foreground border-border' },
  }
  const groups = new Map<FeedItem['kind'], FeedItem[]>()
  for (const f of feed) groups.set(f.kind, [...(groups.get(f.kind) || []), f])
  const sections = [...groups.entries()]
    .map(([kind, items]) => ({ kind, items, score: Math.max(...items.map((x) => x.score)) }))
    .sort((a, b) => b.score - a.score)

  const renderSection = (sec: { kind: FeedItem['kind']; items: FeedItem[] }, si: number) => {
    const meta = SECTION[sec.kind]
    const body = sec.kind === 'matchup'
      ? <div className="grid md:grid-cols-2 gap-3">{sec.items.map((f, j) => renderItem(f, si * 100 + j))}</div>
      : <div className="space-y-3">{sec.items.map((f, j) => renderItem(f, si * 100 + j))}</div>
    return (
      <section key={sec.kind} className={cn('pt-5 border-t', si === 0 ? 'border-transparent pt-0' : 'border-border')}>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <div className="flex items-baseline gap-3">
            <h2 className={cn('text-[11px] font-semibold uppercase tracking-wider', meta.accent.split(' ')[0])}>{meta.label}</h2>
            <span className="text-xs text-muted-foreground">{meta.caption(sec.items)}</span>
          </div>
          {sec.items.length > 1 && sec.kind !== 'top' && <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{sec.items.length}</span>}
        </div>
        {body}
      </section>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Live</h1>
          <div className="text-sm text-muted-foreground">
            {data ? (
              <>
                Week {data.week} · {live > 0 ? <span className="text-emerald-400">{live} game{live === 1 ? '' : 's'} in progress</span> : 'no games in progress'}
                {closeLive > 0 && <> · <span className="text-amber-400">{closeLive} close matchup{closeLive === 1 ? '' : 's'}</span></>}
                {bursts > 0 && <> · {bursts} scoring play{bursts === 1 ? '' : 's'} in the last 20 min</>}
                {' · '}updated {new Date(data.updated).toLocaleTimeString()}
              </>
            ) : 'Loading matchups…'}
          </div>
        </div>
        <button onClick={load} className="text-xs text-muted-foreground underline underline-offset-2">refresh now</button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {sections.map((sec, i) => renderSection(sec, i))}

      {data && data.matchups.length === 0 && (
        <div className="text-sm text-muted-foreground">No in-season leagues yet — load one from <Link to="/lineup" className="underline underline-offset-2">Start/Sit</Link>.</div>
      )}
      <div className="text-xs text-muted-foreground pt-2">
        Ordered by what matters now: red-zone drives, scoring plays since the last refresh (kept 20 min), close matchups with players on the field, then the rest.
        Dots: <span className="text-emerald-400">●</span> playing · <span className="text-amber-400">●</span> yet to play · <span>●</span> final · <span className="text-red-400">●</span> bye.
      </div>
    </div>
  )
}
