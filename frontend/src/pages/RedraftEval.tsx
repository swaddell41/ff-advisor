import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Redraft league evaluation — every roster priced at what players ACTUALLY
 * cost in real ESPN auction drafts (average winning bid, $200 budgets).
 * The heat table answers "which teams are good where": starter dollars per
 * position, rank-colored across the league.
 */

const STORE_KEY = 'ffa-redraft-eval'
const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const

interface TeamSheet {
  name: string
  owner: string
  starters_total: number
  bench_total: number
  total: number
  by_pos: Record<string, number>
  pos_rank?: Record<string, number>
  rank: number
  starters: { name: string; pos: string; aav: number | null; slot: string }[]
  bench: { name: string; pos: string; aav: number | null }[]
  unmatched: number
}

interface EvalResponse {
  platform: string
  league: { name: string; teams: number; slots: string[] }
  season: number
  teams: TeamSheet[]
}

// rank 1 (best) → green, last → red; soft alpha so text stays readable.
function heat(rank: number | undefined, teams: number): string {
  if (!rank || teams < 2) return 'transparent'
  const f = (rank - 1) / (teams - 1) // 0 best … 1 worst
  const hue = 140 - f * 140 // 140 green → 0 red
  return `hsl(${hue} 70% 45% / 0.22)`
}

export default function RedraftEval() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
  })()
  const [platform, setPlatform] = useState<'sleeper' | 'espn'>(saved.platform || 'sleeper')
  const [leagueId, setLeagueId] = useState<string>(saved.leagueId || '')
  const [season] = useState(2026)
  const [data, setData] = useState<EvalResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const run = async (pf = platform, id = leagueId) => {
    if (!id.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/redraft/evaluate?platform=${pf}&league_id=${encodeURIComponent(id.trim())}&season=${season}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setData(j)
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ platform: pf, leagueId: id.trim() })) } catch { /* private mode */ }
    } catch (e: any) {
      setError(e.message || String(e))
      setData(null)
    } finally { setBusy(false) }
  }

  useEffect(() => { if (saved.leagueId) run(saved.platform || 'sleeper', saved.leagueId) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const teams = data?.teams || []
  const n = teams.length

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Redraft Evaluation</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Rosters priced at real auction results — each player's average winning bid across
          actual ESPN auction drafts ($200 budgets, live draft-trends data). Starter dollars
          decide the ranks; the heat map shows who is good where.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border overflow-hidden">
          {(['sleeper', 'espn'] as const).map((pf) => (
            <button
              key={pf}
              onClick={() => setPlatform(pf)}
              className={cn('px-3 py-1.5 text-sm capitalize', platform === pf ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {pf}
            </button>
          ))}
        </div>
        <input
          value={leagueId}
          onChange={(e) => setLeagueId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run() }}
          placeholder={platform === 'espn' ? 'ESPN league ID' : 'Sleeper league ID'}
          className="w-56 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => run()}
          disabled={busy || !leagueId.trim()}
          className="rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? '…' : 'Evaluate'}
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {data && (
        <>
          <div className="text-sm text-muted-foreground">
            {data.league.name} · {n} teams · lineup {data.league.slots.join(' ')}
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="text-left px-3 py-2">#</th>
                  <th className="text-left px-3 py-2">Team</th>
                  <th className="text-right px-3 py-2">Starters $</th>
                  {POSITIONS.map((p) => <th key={p} className="text-right px-3 py-2">{p} $</th>)}
                  <th className="text-right px-3 py-2">Bench $</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <>
                    <tr
                      key={t.name}
                      onClick={() => setOpen(open === t.name ? null : t.name)}
                      className="border-b border-border last:border-b-0 cursor-pointer hover:bg-muted/30"
                    >
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{t.rank}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{t.name}</div>
                        {t.owner && <div className="text-xs text-muted-foreground">{t.owner}</div>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium" style={{ background: heat(t.rank, n) }}>
                        {t.starters_total.toFixed(1)}
                      </td>
                      {POSITIONS.map((p) => (
                        <td key={p} className="px-3 py-2 text-right tabular-nums" style={{ background: heat(t.pos_rank?.[p], n) }}>
                          {(t.by_pos[p] ?? 0).toFixed(1)}
                          <span className="text-[10px] text-muted-foreground ml-1">#{t.pos_rank?.[p] ?? '-'}</span>
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{t.bench_total.toFixed(1)}</td>
                    </tr>
                    {open === t.name && (
                      <tr key={`${t.name}-detail`} className="border-b border-border bg-muted/20">
                        <td colSpan={4 + POSITIONS.length} className="px-4 py-3">
                          <div className="grid sm:grid-cols-2 gap-4 text-sm">
                            <div>
                              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Optimal starters</div>
                              {t.starters.map((s, i) => (
                                <div key={i} className="flex justify-between gap-3">
                                  <span><span className="text-muted-foreground text-xs w-16 inline-block">{s.slot}</span>{s.name}</span>
                                  <span className="tabular-nums">${(s.aav ?? 0).toFixed(1)}</span>
                                </div>
                              ))}
                            </div>
                            <div>
                              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Bench</div>
                              {t.bench.map((b, i) => (
                                <div key={i} className="flex justify-between gap-3 text-muted-foreground">
                                  <span>{b.name} <span className="text-xs">{b.pos}</span></span>
                                  <span className="tabular-nums">${(b.aav ?? 0).toFixed(1)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-xs text-muted-foreground max-w-2xl">
            Values: ESPN Live Draft Trends auction averages, refreshed at most every 12h. They
            track draft-day market price — kept/keeper players are priced at market, not what
            they cost their team, and values freeze once draft season ends.
          </div>
        </>
      )}
    </div>
  )
}
