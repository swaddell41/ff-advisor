import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { cn, errMsg } from '@/lib/utils'

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
  | { kind: 'score'; score: number; name: string; pos: string; team: string; delta: number; points: number; game?: { state: string; detail: string }; mine: string[]; opp: string[]; ts: number; why?: string; play?: string | null }
  | { kind: 'matchup'; score: number; platform: string; league_id: string; live_players: number; margin: number }
  | { kind: 'conflicts'; score: number; live: number }
  | { kind: 'top'; score: number }
interface LiveData {
  week: number; games: { state: string; count: number }[]; matchups: Matchup[]; updated: string
  red_zone?: { mine: RZ[]; opp: RZ[] }; top?: { mine: Agg[]; opp: Agg[] }; conflicts?: Conflict[]; feed?: FeedItem[]
}

// ESPN's "14:20 - 4th" / "End of 3rd" / "Halftime" → "Q4 14:20" / "End Q3" / "Half".
const fmtDetail = (d: string) => {
  const m = d.match(/^(\d+:\d+) - (\d)(?:st|nd|rd|th)$/)
  if (m) return `Q${m[2]} ${m[1]}`
  const e = d.match(/^End of (\d)/)
  if (e) return `End Q${e[1]}`
  if (/half/i.test(d)) return 'Half'
  if (/^Final/.test(d)) return d.replace('Final/OT', 'F/OT')
  return d
}
const SLOT_SHORT: Record<string, string> = { SUPER_FLEX: 'SF', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T' }

const DOT: Record<Starter['game']['state'], string> = { in: 'bg-emerald-400', post: 'bg-muted-foreground', pre: 'bg-amber-400', bye: 'bg-red-400' }

// Decided-ness of a matchup from the two sides' points and remaining projection.
type Verdict = { label: string; cls: string } | null
function verdict(m: Matchup): Verdict {
  if (!m.me || !m.opp) return null
  const lead = m.me.points - m.opp.points
  const left = (s: Side) => s.in_play + s.yet_to_play
  const meLeft = left(m.me), oppLeft = left(m.opp)
  const WON = { label: 'won', cls: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-400' }
  const LOST = { label: 'lost', cls: 'border-red-500/60 bg-red-500/10 text-red-400' }
  // Definite: the side that could still change the result has nobody left.
  if (meLeft === 0 && oppLeft === 0) {
    if (Math.abs(lead) < 0.05) return { label: 'tied', cls: 'border-border text-muted-foreground' }
    return lead > 0 ? WON : LOST
  }
  if (lead > 0 && oppLeft === 0) return WON
  if (lead < 0 && meLeft === 0) return LOST
  // Likely: the trailing side's remaining projection (+25% upside, +5)
  // can't close the gap.
  const trailing = lead > 0 ? m.opp : m.me
  const needed = trailing.proj_remaining * 1.25 + 5
  if (Math.abs(lead) > needed) {
    return lead > 0
      ? { label: 'likely win', cls: 'border-emerald-500/40 text-emerald-400/90' }
      : { label: 'likely loss', cls: 'border-red-500/40 text-red-400/90' }
  }
  return null
}

// How much a matchup still hangs on the next points: 0 once decided, 1 when
// live and dead even, a sliver when "likely" but not certain.
function liveness(m: Matchup): number {
  if (!m.me || !m.opp) return 0
  const v = verdict(m)
  if (v && (v.label === 'won' || v.label === 'lost' || v.label === 'tied')) return 0
  const remaining = m.me.proj_remaining + m.opp.proj_remaining
  if (remaining <= 0) return 0
  const margin = Math.abs(m.me.points - m.opp.points)
  const w = Math.max(0, Math.min(1, 1 - margin / (remaining + 1)))
  return v ? Math.min(w, 0.25) : w   // likely win/loss: still alive, barely
}

type Rooting = {
  c: Conflict
  forW: number; againstW: number
  forLeagues: { league: string; margin: number }[]
  againstLeagues: { league: string; margin: number }[]
  remaining: number          // projection still to come for this player
  lean: 'for' | 'against' | 'torn' | 'moot'
  score: number
}
function analyzeRooting(conflicts: Conflict[], matchups: Matchup[]): Rooting[] {
  const byLeague = new Map(matchups.map((m) => [m.league, m]))
  return conflicts.map((c) => {
    const side = (leagues: string[]) => leagues.map((league) => {
      const m = byLeague.get(league)
      const w = m ? liveness(m) : 0
      const margin = m && m.me && m.opp ? m.me.points - m.opp.points : 0
      return { league, w, margin }
    })
    const F = side(c.have_in), A = side(c.face_in)
    const forW = F.reduce((t, x) => t + x.w, 0), againstW = A.reduce((t, x) => t + x.w, 0)
    let remaining = 0
    for (const m of matchups) {
      for (const st of [...(m.me?.starters || []), ...(m.opp?.starters || [])]) {
        if (st.name === c.name && st.proj_live != null) remaining = Math.max(remaining, st.proj_live - st.points)
      }
    }
    const done = c.game?.state === 'post' || c.game?.state === 'bye'
    const both = Math.min(forW, againstW)
    let lean: Rooting['lean'] = 'moot'
    if (!done && both > 0.1) {
      const r = forW / (forW + againstW)
      lean = r > 0.65 ? 'for' : r < 0.35 ? 'against' : 'torn'
    } else if (!done && (forW > 0.1 || againstW > 0.1)) {
      lean = forW > againstW ? 'for' : 'against'
    }
    return {
      c, forW, againstW,
      forLeagues: F.filter((x) => x.w > 0).map(({ league, margin }) => ({ league, margin })),
      againstLeagues: A.filter((x) => x.w > 0).map(({ league, margin }) => ({ league, margin })),
      remaining, lean,
      score: (lean === 'torn' ? 2 : lean === 'moot' ? 0 : 1) * (both + 0.05) * (remaining + 1),
    }
  }).sort((a, b) => b.score - a.score)
}

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
    } catch (e: unknown) { setError(errMsg(e)) }
  }
  useEffect(() => {
    // Poll only while the tab is visible; refresh immediately on return.
    const start = () => { if (timer.current == null) timer.current = window.setInterval(load, POLL_MS) }
    const stop = () => { if (timer.current != null) { window.clearInterval(timer.current); timer.current = null } }
    load(); start()
    const onVis = () => { if (document.visibilityState === 'visible') { load(); start() } else stop() }
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  const live = data?.games.find((g) => g.state === 'in')?.count || 0
  const byKey = useMemo(() => new Map((data?.matchups || []).map((m) => [`${m.platform}:${m.league_id}`, m])), [data])
  const feed = data?.feed || []
  // Verdicts and rooting analysis change only when data does — not per render.
  const verdictOf = useMemo(() => {
    const map = new Map<string, Verdict>()
    for (const m of data?.matchups || []) map.set(`${m.platform}:${m.league_id}`, verdict(m))
    return (m: Matchup) => map.get(`${m.platform}:${m.league_id}`) ?? null
  }, [data])
  const rooting = useMemo(() => analyzeRooting(data?.conflicts || [], data?.matchups || []), [data])
  const isClose = (f: FeedItem) => {
    if (f.kind !== 'matchup' || f.live_players === 0 || f.margin >= 15) return false
    const m = byKey.get(`${f.platform}:${f.league_id}`)
    return !!m && verdictOf(m) === null
  }
  const closeNames = feed.filter(isClose).map((f) => byKey.get(`${(f as any).platform}:${(f as any).league_id}`)?.league).filter(Boolean) as string[]
  const closeLive = closeNames.length
  const bursts = feed.filter((f) => f.kind === 'score').length
  const tally = { won: 0, lost: 0, likelyWin: 0, likelyLoss: 0 }
  for (const f of feed) {
    if (f.kind !== 'matchup') continue
    const m = byKey.get(`${f.platform}:${f.league_id}`)
    const v = m && verdictOf(m)
    if (v?.label === 'won') tally.won++
    else if (v?.label === 'lost') tally.lost++
    else if (v?.label === 'likely win') tally.likelyWin++
    else if (v?.label === 'likely loss') tally.likelyLoss++
  }

  const side = (s: Side | null, mine: boolean) => s ? (
    <div className="flex-1 min-w-0">
      <div className={cn('text-xs truncate', mine ? 'text-foreground' : 'text-muted-foreground')}>{s.name}</div>
      <div className="text-2xl font-semibold tabular-nums leading-tight">{s.points.toFixed(1)}</div>
      <div className="text-[11px] text-muted-foreground tabular-nums">proj {(s.points + s.proj_remaining).toFixed(1)} · {s.in_play} playing · {s.yet_to_play} to play</div>
    </div>
  ) : <div className="flex-1 text-sm text-muted-foreground">no matchup</div>

  const roster = (s: Side | null) => s ? (
    <div className="space-y-0.5">
      {s.starters.map((p) => (
        <div key={`${p.slot}|${p.name}`} className="flex items-center gap-2 text-xs">
          <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', DOT[p.game.state])} title={p.game.detail} />
          <span className="text-muted-foreground w-8 shrink-0 truncate" title={p.slot}>{SLOT_SHORT[p.slot] || p.slot}</span>
          <span className="flex-1 min-w-0 truncate" title={`${p.name} · ${p.team}`}>{p.name} <span className="text-muted-foreground">{p.team}</span></span>
          <span className={cn('text-muted-foreground tabular-nums shrink-0 text-right whitespace-nowrap', p.game.state === 'in' ? 'w-[7.5rem]' : 'w-16')} title={p.game.detail}>
            {p.game.state === 'pre' ? `${p.proj.toFixed(1)} proj`
              : p.game.state === 'bye' ? 'bye'
              : p.game.state === 'in' ? <>{fmtDetail(p.game.detail)}{p.proj_live != null && <span className="text-emerald-400"> →{p.proj_live.toFixed(1)}</span>}</>
              : fmtDetail(p.game.detail)}
          </span>
          <span className="w-10 text-right tabular-nums font-medium shrink-0">{p.points.toFixed(1)}</span>
        </div>
      ))}
    </div>
  ) : null

  const matchupCard = (m: Matchup, liveCount: number, close = false) => {
    const key = `${m.platform}:${m.league_id}`
    const lead = m.me && m.opp ? m.me.points - m.opp.points : 0
    return (
      <div key={key} className={cn('@container rounded-xl border bg-card p-4 space-y-3', close ? 'border-amber-500/50' : liveCount > 0 ? 'border-emerald-500/30' : 'border-border')}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{m.league}</div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {close && <span className="rounded-full border border-amber-500/50 bg-amber-500/10 text-amber-400 px-2 py-0.5">close</span>}
            {(() => { const v = verdictOf(m); return v ? <span className={cn('rounded-full border px-2 py-0.5', v.cls)}>{v.label}</span> : null })()}
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
              <div className="grid @3xl:grid-cols-2 gap-4 pt-1 border-t border-border">
                <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">You</div>{roster(m.me)}</div>
                <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Opponent</div>{roster(m.opp)}</div>
              </div>
            )}
            {m.scoreboard.length > 0 && (
              <div className="pt-2 border-t border-border">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Around the league</div>
                <div className="grid @3xl:grid-cols-2 gap-x-8 gap-y-0.5">
                  {m.scoreboard.filter((g) => !(m.me && (g.a.name === m.me.name || g.b.name === m.me.name))).map((g, i) => {
                    const mine = false
                    const aLead = g.a.points > g.b.points
                    const bLead = g.b.points > g.a.points
                    return (
                      <div
                        key={i}
                        className={cn('grid items-center gap-2 text-[11px] leading-5 rounded px-1 -mx-1', mine ? 'bg-muted/40 text-foreground' : 'text-muted-foreground')}
                        style={{ gridTemplateColumns: 'minmax(0,1fr) 2.75rem 0.5rem 2.75rem minmax(0,1fr)' }}
                      >
                        <span className={cn('truncate text-right', aLead && 'text-foreground')} title={g.a.name}>{g.a.name}</span>
                        <span className={cn('text-right tabular-nums', aLead ? 'text-foreground font-medium' : '')}>{g.a.points.toFixed(1)}</span>
                        <span className="text-center text-muted-foreground/50">–</span>
                        <span className={cn('text-left tabular-nums', bLead ? 'text-foreground font-medium' : '')}>{g.b.points.toFixed(1)}</span>
                        <span className={cn('truncate', bLead && 'text-foreground')} title={g.b.name}>{g.b.name}</span>
                      </div>
                    )
                  })}
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
          <div key={`sc|${f.name}|${f.ts}`} className={cn('rounded-xl border p-3 flex items-center gap-3', good && !bad ? 'border-emerald-500/40 bg-emerald-500/5' : bad && !good ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card')}>
            <div className={cn('text-xl font-semibold tabular-nums shrink-0', f.delta > 0 ? (good && !bad ? 'text-emerald-400' : bad && !good ? 'text-amber-400' : '') : 'text-red-400')}>
              {f.delta > 0 ? '+' : ''}{f.delta.toFixed(1)}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{f.name} <span className="text-xs text-muted-foreground">{f.pos} · {f.team}{f.game?.detail ? ` · ${f.game.detail}` : ''} · now {f.points.toFixed(1)}</span></div>
              {(f.why || f.play) && (
                <div className="text-xs">
                  {f.why && <span className="text-foreground">{f.why}</span>}
                  {f.play && <span className="text-muted-foreground italic">{f.why ? ' — ' : ''}“{f.play}”</span>}
                </div>
              )}
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
        return m ? matchupCard(m, f.live_players, isClose(f)) : null
      }
      case 'conflicts': {
        const torn = rooting.filter((r) => r.lean === 'torn')
        const leaning = rooting.filter((r) => r.lean === 'for' || r.lean === 'against')
        const moot = rooting.filter((r) => r.lean === 'moot')
        const chips = (rows: { league: string; margin: number }[], tone: string) => rows.map((x, k) => (
          <span key={k} className={cn('rounded-full border px-1.5 py-0 text-[10px] tabular-nums', tone)}>
            {x.league.replace(/ est\. \d{4}$/, '')} {x.margin > 0 ? '+' : ''}{x.margin.toFixed(1)}
          </span>
        ))
        const row = (r: Rooting) => (
          <div key={r.c.name} className="py-1.5 border-b border-border/60 last:border-b-0">
            <div className="flex items-center gap-2 text-sm">
              <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', DOT[(r.c.game?.state as Starter['game']['state']) || 'pre'])} />
              <span className="truncate">{r.c.name} <span className="text-xs text-muted-foreground">{r.c.pos} · {r.c.team}</span></span>
              <span className="ml-auto shrink-0 flex items-center gap-2">
                {r.remaining > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">{r.remaining.toFixed(1)} left</span>}
                <span className={cn('rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                  r.lean === 'torn' ? 'border-amber-500/60 bg-amber-500/10 text-amber-400'
                  : r.lean === 'for' ? 'border-emerald-500/50 text-emerald-400'
                  : r.lean === 'against' ? 'border-red-500/50 text-red-400' : 'border-border text-muted-foreground')}>
                  {r.lean === 'torn' ? 'torn' : r.lean === 'for' ? 'root for' : r.lean === 'against' ? 'root against' : 'moot'}
                </span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1 pl-3.5 mt-1">
              <span className="text-[10px] text-emerald-400/80 mr-0.5">for</span>{chips(r.forLeagues, 'border-emerald-500/30 text-emerald-300/90')}
              {r.forLeagues.length === 0 && <span className="text-[10px] text-muted-foreground">—</span>}
              <span className="text-[10px] text-red-400/80 ml-2 mr-0.5">against</span>{chips(r.againstLeagues, 'border-red-500/30 text-red-300/90')}
              {r.againstLeagues.length === 0 && <span className="text-[10px] text-muted-foreground">—</span>}
            </div>
          </div>
        )
        return (
          <div key={`cf${i}`} className="rounded-xl border border-border bg-card p-4 space-y-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-amber-400 mb-1">Genuinely torn · {torn.length}</div>
              <div className="text-xs text-muted-foreground mb-1">Still swings an undecided matchup on both sides. Margins shown are yours in each league.</div>
              {torn.length === 0 ? <div className="text-xs text-muted-foreground">Nobody right now — every conflict leans one way or is already settled.</div> : torn.map(row)}
            </div>
            {leaning.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Leaning · {leaning.length}</div>
                <div className="text-xs text-muted-foreground mb-1">Live on both sides, but one side clearly outweighs the other.</div>
                {leaning.slice(0, 6).map(row)}
                {leaning.length > 6 && <div className="text-xs text-muted-foreground pt-1">+{leaning.length - 6} more leaning the same ways</div>}
              </div>
            )}
            {moot.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{moot.length} more don't matter — the matchup on one side is decided, or the game is over</summary>
                <div className="pt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {moot.map((r) => <span key={r.c.name}>{r.c.name} <span className="opacity-60">{r.c.pos}</span></span>)}
                </div>
              </details>
            )}
          </div>
        )
      }
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
    conflicts: { label: 'Conflicted rooting', caption: () => 'only the players who still swing an undecided matchup on both sides — the rest are collapsed', accent: 'text-muted-foreground border-border' },
    top: { label: 'Leaderboards', caption: () => 'best per player across all your leagues, yours vs against you', accent: 'text-muted-foreground border-border' },
  }
  const groups = new Map<FeedItem['kind'], FeedItem[]>()
  for (const f of feed) groups.set(f.kind, [...(groups.get(f.kind) || []), f])
  // Section order is fixed and predictable — urgent kinds first — while
  // items inside each section stay ranked by salience.
  const SECTION_ORDER: FeedItem['kind'][] = ['redzone', 'score', 'matchup', 'conflicts', 'top']
  const sections = [...groups.entries()]
    .map(([kind, items]) => ({ kind, items, score: Math.max(...items.map((x) => x.score)) }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.kind) - SECTION_ORDER.indexOf(b.kind))

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
                {closeLive > 0 && <> · <span className="text-amber-400" title={closeNames.join(' · ')}>{closeLive} close matchup{closeLive === 1 ? '' : 's'}</span> <span className="text-muted-foreground">({closeNames.join(', ')})</span></>}
                {bursts > 0 && <> · {bursts} scoring play{bursts === 1 ? '' : 's'} in the last 20 min</>}
                {(tally.won + tally.likelyWin + tally.lost + tally.likelyLoss) > 0 && (
                  <> · <span className="text-emerald-400">{tally.won + tally.likelyWin} win{tally.won + tally.likelyWin === 1 ? '' : 's'}</span>
                  {tally.likelyWin > 0 && <span className="text-muted-foreground"> ({tally.likelyWin} likely)</span>}
                  {' / '}<span className="text-red-400">{tally.lost + tally.likelyLoss} loss{tally.lost + tally.likelyLoss === 1 ? '' : 'es'}</span>
                  {tally.likelyLoss > 0 && <span className="text-muted-foreground"> ({tally.likelyLoss} likely)</span>}</>
                )}
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
        Sections always run red zone → just happened → matchups → conflicts → leaderboards; within each, the hottest items first (scoring plays kept 20 min, matchups closest first).
        Dots: <span className="text-emerald-400">●</span> playing · <span className="text-amber-400">●</span> yet to play · <span>●</span> final · <span className="text-red-400">●</span> bye.
      </div>
    </div>
  )
}
