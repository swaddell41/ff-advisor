import { useEffect, useState } from 'react'
import { SavedLeagueChips, useSavedLeagues, type SavedLeague } from '@/components/SavedLeagues'
import { cn } from '@/lib/utils'

/**
 * Start/Sit: current lineup vs this week's optimal, priced by ESPN weekly
 * projections. Sleeper finds your roster from your signed-in account; ESPN
 * needs a one-time team pick (remembered with the saved league).
 */

const STORE_KEY = 'ffa-startsit'
const BAD = new Set(['OUT', 'INJURY_RESERVE', 'SUSPENSION', 'DOUBTFUL'])

interface Row {
  name: string; pos: string; aav: number | null; injury?: string; slot?: string
  espn_proj?: number; slpr_proj?: number | null; start_pct?: number | null
  team?: string; opp?: string; ou?: number | null; implied?: number | null; kickoff?: string
}
interface LineupResponse {
  league: string; team: string; week: number
  current_total: number; optimal_total: number; delta: number
  start: Row[]; sit: Row[]; optimal: Row[]; bench: Row[]
  flags: { name: string; why: string }[]
}

export default function StartSit() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
  })()
  const { leagues, save, remove } = useSavedLeagues()
  const [platform, setPlatform] = useState<'sleeper' | 'espn'>(saved.platform || 'sleeper')
  const [leagueId, setLeagueId] = useState<string>(saved.leagueId || '')
  const [teamId, setTeamId] = useState<string>(saved.teamId || '')
  const [teams, setTeams] = useState<{ id: number; name: string }[] | null>(null)
  const [data, setData] = useState<LineupResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const persist = (patch: Record<string, string>) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ platform, leagueId, teamId, ...patch })) } catch { /* private mode */ }
  }

  const run = async (pf = platform, id = leagueId, tid = teamId) => {
    if (!id.trim()) return
    setBusy(true); setError(null); setTeams(null)
    try {
      let url = `/api/lineup?platform=${pf}&league_id=${encodeURIComponent(id.trim())}&season=2026`
      if (pf === 'espn') {
        if (!tid) {
          // One-time team pick: the draft proxy already returns the team list.
          const lr = await fetch(`/api/espn/draft/${encodeURIComponent(id.trim())}?season=2026`)
          const lj = await lr.json()
          if (!lr.ok) throw new Error(lj.detail || `HTTP ${lr.status}`)
          setTeams(lj.teams || [])
          setBusy(false)
          return
        }
        url += `&team_id=${tid}`
      }
      const r = await fetch(url)
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setData(j)
      persist({ platform: pf, leagueId: id.trim(), teamId: tid })
      // Keep the hub's saved list fresh with what we just used.
      save({ platform: pf, league_id: id.trim(), season: 2026, name: j.league || '', team_id: tid })
    } catch (e: any) {
      setError(e.message || String(e)); setData(null)
    } finally { setBusy(false) }
  }

  useEffect(() => { if (saved.leagueId) run(saved.platform || 'sleeper', saved.leagueId, saved.teamId || '') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pickSavedLeague = (l: SavedLeague) => {
    setPlatform(l.platform); setLeagueId(l.league_id); setTeamId(l.team_id || '')
    run(l.platform, l.league_id, l.team_id || '')
  }

  const inj = (r: Row) =>
    r.injury && r.injury !== 'ACTIVE' ? (
      <span className={cn('ml-1.5 text-[10px] uppercase', BAD.has(r.injury) ? 'text-red-400' : 'text-amber-400')}>
        {r.injury.replace('_', ' ')}
      </span>
    ) : null

  // The context line under each player: matchup, Vegas environment, crowd,
  // and the two projection sources (flagged when they disagree hard).
  const context = (r: Row) => {
    const bits: React.ReactNode[] = []
    if (r.team && r.opp) {
      bits.push(<span key="m">{r.team} vs {r.opp}</span>)
      if (r.implied != null) {
        bits.push(
          <span key="v" className={cn(r.implied >= 26 ? 'text-emerald-400' : r.implied <= 19 ? 'text-red-400/80' : '')}>
            implied {r.implied.toFixed(1)}{r.ou != null ? ` (O/U ${r.ou})` : ''}
          </span>
        )
      }
    }
    if (r.espn_proj != null && r.slpr_proj != null) {
      const gap = Math.abs(r.espn_proj - (r.slpr_proj ?? 0))
      bits.push(
        <span key="p" className={cn(gap >= 5 && 'text-amber-400')} title="ESPN / Sleeper weekly projections">
          ESPN {r.espn_proj.toFixed(1)} · Slpr {(r.slpr_proj ?? 0).toFixed(1)}{gap >= 5 ? ' ⚖ split' : ''}
        </span>
      )
    }
    if (r.start_pct != null) bits.push(<span key="s">{Math.round(r.start_pct)}% started</span>)
    if (!bits.length) return null
    return (
      <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2.5">
        {bits}
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Start/Sit</h1>
        <p className="text-sm text-muted-foreground">
          Your set lineup vs this week's optimal, by ESPN weekly projections. Injuries and
          zero-projection starters get flagged.
        </p>
      </div>

      <SavedLeagueChips
        leagues={leagues}
        active={{ platform, league_id: leagueId }}
        onPick={pickSavedLeague}
        onRemove={remove}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border overflow-hidden">
          {(['sleeper', 'espn'] as const).map((pf) => (
            <button
              key={pf}
              onClick={() => { setPlatform(pf); setTeamId('') }}
              className={cn('px-3 py-1.5 text-sm capitalize', platform === pf ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {pf}
            </button>
          ))}
        </div>
        <input
          value={leagueId}
          onChange={(e) => { setLeagueId(e.target.value); setTeamId('') }}
          placeholder={`${platform === 'espn' ? 'ESPN' : 'Sleeper'} league ID`}
          className="w-56 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => run()}
          disabled={busy || !leagueId.trim()}
          className="rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? '…' : 'Check lineup'}
        </button>
      </div>

      {teams && (
        <div className="space-y-2">
          <div className="text-sm">Which team is yours?</div>
          <div className="flex flex-wrap gap-1.5">
            {teams.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTeamId(String(t.id)); run(platform, leagueId, String(t.id)) }}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="text-sm text-red-400">{error}</div>}

      {data && (
        <>
          <div className={cn(
            'rounded-lg border p-4',
            data.delta > 0.5 ? 'border-amber-500/40 bg-amber-500/5' : 'border-emerald-500/40 bg-emerald-500/5'
          )}>
            <div className="text-sm text-muted-foreground">{data.league} · {data.team} · Week {data.week}</div>
            <div className="text-lg font-semibold mt-0.5">
              {data.delta > 0.5
                ? <>You're leaving <span className="text-amber-400">{data.delta.toFixed(1)} pts</span> on the bench</>
                : <span className="text-emerald-400">Lineup is optimal ✓</span>}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              current {data.current_total.toFixed(1)} → optimal {data.optimal_total.toFixed(1)} projected pts
            </div>
          </div>

          {(data.start.length > 0 || data.sit.length > 0) && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-border p-3">
                <div className="text-[11px] uppercase tracking-wider text-emerald-400 mb-1.5">Start</div>
                {data.start.map((r) => (
                  <div key={r.name} className="py-1">
                    <div className="flex justify-between text-sm">
                      <span>{r.name} <span className="text-xs text-muted-foreground">{r.pos}</span>{inj(r)}</span>
                      <span className="tabular-nums">{(r.aav ?? 0).toFixed(1)}</span>
                    </div>
                    {context(r)}
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-[11px] uppercase tracking-wider text-red-400 mb-1.5">Sit</div>
                {data.sit.map((r) => (
                  <div key={r.name} className="py-1">
                    <div className="flex justify-between text-sm">
                      <span>{r.name} <span className="text-xs text-muted-foreground">{r.pos}</span>{inj(r)}</span>
                      <span className="tabular-nums">{(r.aav ?? 0).toFixed(1)}</span>
                    </div>
                    {context(r)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.flags.length > 0 && (
            <div className="text-sm text-amber-400">
              ⚠ {data.flags.map((f) => `${f.name} (${(f.why || 'no projection').replace('_', ' ').toLowerCase()})`).join(' · ')}
            </div>
          )}

          <div className="rounded-lg border border-border overflow-hidden">
            <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
              Optimal lineup · week {data.week}
            </div>
            {data.optimal.map((r, i) => (
              <div key={i} className="px-3 py-1.5 border-b border-border last:border-b-0">
                <div className="flex justify-between text-sm">
                  <span>
                    <span className="text-muted-foreground text-xs w-20 inline-block">{r.slot}</span>
                    {r.name}{inj(r)}
                  </span>
                  <span className="tabular-nums font-medium">{(r.aav ?? 0).toFixed(1)}</span>
                </div>
                <div className="pl-20">{context(r)}</div>
              </div>
            ))}
          </div>

          <div className="text-xs text-muted-foreground max-w-2xl space-y-1">
            <div>
              <span className="font-medium text-foreground">How this works:</span> players are ranked
              by a consensus of ESPN and Sleeper weekly projections (⚖ marks a 5+ pt disagreement —
              trust it less). Vegas implied totals give the scoring environment
              (<span className="text-emerald-400">26+</span> elite, <span className="text-red-400/80">≤19</span> ugly) —
              the strongest single context signal. "% started" is what managers across ESPN are doing.
              On close calls: favored in your matchup → take the safer floor; trailing or underdog →
              take the upside.
            </div>
          </div>
        </>
      )}
    </div>
  )
}
