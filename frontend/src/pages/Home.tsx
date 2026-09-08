import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

/**
 * My Leagues — every league in one place, each card leading with the
 * action that matters this week: lineup points on the bench, waiver claims
 * worth making, and (dynasty) a trade nudge from stated posture + standings.
 */

interface Card {
  platform: 'sleeper' | 'espn'
  league_id: string
  name: string
  team_id: string
  type: 'redraft' | 'keeper' | 'dynasty'
  status?: string
  teams?: number
  url?: string
  record?: { wins: number; losses: number; pts: number; rank: number | null }
  lineup?: { delta: number; current: number; optimal: number; start: string[]; sit: string[]; flags: string[] }
  waivers?: { faab: { enabled: boolean; remaining: number; budget: number } | null; top: { name: string; pos: string; tier: string; bid: number | null; delta_wk: number }[] }
  posture?: { value: string; is_override: boolean }
  trade?: { action: 'buy' | 'sell' | 'hold' | 'reassess'; text: string; needs: string[]; surplus: string[] }
  error?: string
  lineup_error?: string
}

interface HomeData { week: number; leagues: Card[]; attention: { lineups: number; waivers: number; trades: number } }

const TYPE_TAG: Record<Card['type'], string> = {
  dynasty: 'bg-violet-500/15 text-violet-300',
  keeper: 'bg-amber-500/15 text-amber-300',
  redraft: 'bg-emerald-500/15 text-emerald-300',
}
const ACTION_TAG: Record<string, string> = {
  buy: 'text-emerald-400 border-emerald-500/40',
  sell: 'text-amber-400 border-amber-500/40',
  reassess: 'text-amber-400 border-amber-500/40',
  hold: 'text-muted-foreground border-border',
}

const q = (c: Card) => `platform=${c.platform}&league=${encodeURIComponent(c.league_id)}${c.team_id ? `&team=${c.team_id}` : ''}`

export default function Home() {
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const r = await fetch('/api/me/home')
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setData(j)
    } catch (e: any) { setError(e.message || String(e)) }
  }
  useEffect(() => { load() }, [])

  const setPosture = async (c: Card, posture: string) => {
    await fetch(`/api/leagues/${c.league_id}/my-posture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posture }),
    })
    load()
  }

  const groups = {
    redraft: (data?.leagues || []).filter((c) => c.type !== 'dynasty'),
    dynasty: (data?.leagues || []).filter((c) => c.type === 'dynasty'),
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">My Leagues</h1>
          {data ? (
            <div className="text-sm text-muted-foreground">
              NFL Week {data.week} ·{' '}
              <span className={cn(data.attention.lineups && 'text-amber-400')}>{data.attention.lineups} lineup{data.attention.lineups === 1 ? '' : 's'} leaving points on the bench</span>
              {' · '}{data.attention.waivers} with waiver claims worth making
              {data.attention.trades > 0 && <> · <span className="text-amber-400">{data.attention.trades} dynasty trade prompt{data.attention.trades === 1 ? '' : 's'}</span></>}
            </div>
          ) : !error && <div className="text-sm text-muted-foreground">Scanning your leagues — lineups, wires, standings…</div>}
        </div>
        <Link to="/lineup" className="text-xs text-muted-foreground underline underline-offset-2">Add a league</Link>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {(['redraft', 'dynasty'] as const).map((g) => groups[g].length > 0 && (
        <div key={g} className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g === 'redraft' ? 'Redraft & keeper' : 'Dynasty'}</h2>
            <span className="text-xs text-muted-foreground">{g === 'redraft' ? 'weekly lineups · waivers · team grades' : 'trade posture · lineups · waivers'}</span>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {groups[g].map((c) => (
              <div key={`${c.platform}:${c.league_id}`} className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', TYPE_TAG[c.type])}>{c.type}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.platform}{c.teams ? ` · ${c.teams} teams` : ''}</span>
                  </div>
                  {c.record && (c.record.wins + c.record.losses > 0) && (
                    <span className="text-xs text-muted-foreground tabular-nums">{c.record.wins}-{c.record.losses}{c.record.rank ? ` · #${c.record.rank}` : ''}</span>
                  )}
                </div>
                <div className="text-base font-semibold leading-tight">{c.name}</div>

                {c.error && <div className="text-xs text-red-400">{c.error}</div>}
                {c.status === 'pre_draft' && (
                  <div className="text-sm text-muted-foreground">Draft not started — <Link to="/draft" className="underline underline-offset-2">prep the autopilot queue</Link></div>
                )}

                {c.lineup && (
                  <div className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Week {data!.week} lineup</span>
                      {c.lineup.delta > 0.5
                        ? <span className="text-amber-400 font-medium tabular-nums">+{c.lineup.delta.toFixed(1)} pts on bench</span>
                        : <span className="text-emerald-400 font-medium">Optimal ✓</span>}
                    </div>
                    {c.lineup.delta > 0.5 && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        start {c.lineup.start.join(', ')}{c.lineup.sit.length ? ` · sit ${c.lineup.sit.join(', ')}` : ''}
                      </div>
                    )}
                  </div>
                )}

                {c.waivers && (
                  <div className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Waivers{c.waivers.faab?.enabled ? ` · $${c.waivers.faab.remaining} left` : ''}</span>
                      <span className={cn('tabular-nums', c.waivers.top.length ? '' : 'text-muted-foreground')}>{c.waivers.top.length ? `${c.waivers.top.length} worth a claim` : 'nothing beats your roster'}</span>
                    </div>
                    {c.waivers.top.length > 0 && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {c.waivers.top.map((t) => `${t.name} (${t.pos}${t.bid != null ? ` · $${t.bid}` : ''})`).join(' · ')}
                      </div>
                    )}
                  </div>
                )}

                {c.trade && c.posture && (
                  <div className="rounded-lg border border-border/70 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">My goal</span>
                      <div className="flex gap-1">
                        {(['contend', 'middling', 'rebuild'] as const).map((p) => (
                          <button key={p} onClick={() => setPosture(c, p)}
                            className={cn('rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                              c.posture!.value === p ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground')}>
                            {p === 'middling' ? 'undecided' : p}
                          </button>
                        ))}
                        {c.posture.is_override && (
                          <button onClick={() => setPosture(c, 'auto')} title="Back to auto-detected" className="text-[10px] text-muted-foreground underline underline-offset-2 ml-1">auto</button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wider', ACTION_TAG[c.trade.action])}>{c.trade.action}</span>
                      <span className="text-sm">{c.trade.text}</span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 mt-auto pt-1">
                  {c.lineup && c.lineup.delta > 0.5 ? (
                    <Link to={`/lineup?${q(c)}`} className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium">Set lineup · +{c.lineup.delta.toFixed(1)}</Link>
                  ) : c.type === 'dynasty' && c.trade && c.trade.action !== 'hold' ? (
                    <Link to={`/trade?league=${c.league_id}`} className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium">Open Trade Hub</Link>
                  ) : c.lineup ? (
                    <Link to={`/lineup?${q(c)}`} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium">Lineup</Link>
                  ) : null}
                  {c.waivers && c.waivers.top.length > 0 && (
                    <Link to={`/waivers?${q(c)}`} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium">Waivers</Link>
                  )}
                  {c.type !== 'dynasty' && c.status !== 'pre_draft' && (
                    <Link to={`/redraft?${q(c)}`} className="text-xs text-muted-foreground underline underline-offset-2">Team grades</Link>
                  )}
                  {c.type === 'dynasty' && (
                    <Link to="/dynasty" className="text-xs text-muted-foreground underline underline-offset-2">Dynasty dashboard</Link>
                  )}
                  {c.url && <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground underline underline-offset-2 ml-auto">Open in {c.platform === 'espn' ? 'ESPN' : 'Sleeper'} ↗</a>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {data && data.leagues.length === 0 && (
        <div className="text-sm text-muted-foreground">No leagues yet — open <Link to="/lineup" className="underline underline-offset-2">Start/Sit</Link> or <Link to="/draft" className="underline underline-offset-2">Draft</Link> and load one; it'll be saved here.</div>
      )}
    </div>
  )
}
