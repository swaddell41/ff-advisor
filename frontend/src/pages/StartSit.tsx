import { SavedLeagueChips } from '@/components/SavedLeagues'
import { SEASON, useLeagueSelection } from '@/lib/useLeagueSelection'
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
  flex_tips?: { slot: string; move_in: string; move_in_pos: string; move_in_kickoff: string | null; from_slot: string; move_out: string | null; move_out_kickoff: string | null }[]
}

const slotName = (s: string) => ({ SUPER_FLEX: 'Superflex', WRRB_FLEX: 'W/R flex', REC_FLEX: 'W/T flex', FLEX: 'Flex' }[s] ?? s)
const kick = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''

export default function StartSit() {
  const { platform, setPlatform, leagueId, setLeagueId, setTeamId, teamId, teams, data, error, busy, run, pickSavedLeague, pickTeam, leagues, remove } =
    useLeagueSelection<LineupResponse>({
      storeKey: STORE_KEY,
      url: (pf, id, tid) => `/api/lineup?platform=${pf}&league_id=${encodeURIComponent(id)}&season=${SEASON}${pf === 'espn' ? `&team_id=${tid}` : ''}`,
      leagueName: (d) => d.league,
    })

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
      bits.push(<span key="m">{r.team} vs {r.opp}{r.kickoff ? ` · ${kick(r.kickoff)}` : ''}</span>)
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
                onClick={() => pickTeam(t.id)}
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
            <div className="flex items-start justify-between gap-3">
              <div>
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
              {/* Neither platform offers a supported lineup-write API (Sleeper's
                  is read-only by policy), so the fix is one tap away instead:
                  deep-link straight to this team's lineup page. */}
              <a
                href={platform === 'sleeper'
                  ? `https://sleeper.com/leagues/${encodeURIComponent(leagueId.trim())}/team`
                  : `https://fantasy.espn.com/football/team?leagueId=${encodeURIComponent(leagueId.trim())}&teamId=${encodeURIComponent(teamId)}&seasonId=${SEASON}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium whitespace-nowrap"
              >
                Set lineup on {platform === 'sleeper' ? 'Sleeper' : 'ESPN'} ↗
              </a>
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

          {(data.flex_tips?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-sky-500/40 bg-sky-500/5 p-3 space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-sky-400">Flex seat · same points, more outs</div>
              {data.flex_tips!.map((t) => (
                <div key={t.slot + t.move_in} className="text-sm">
                  Put <span className="font-medium">{t.move_in}</span>
                  <span className="text-xs text-muted-foreground"> ({kick(t.move_in_kickoff)})</span> in your {slotName(t.slot)}
                  {t.move_out && <> and slide <span className="font-medium">{t.move_out}</span>
                    <span className="text-xs text-muted-foreground"> ({kick(t.move_out_kickoff)})</span> to {slotName(t.from_slot)}</>}.
                </div>
              ))}
              <div className="text-xs text-muted-foreground">
                Your latest kickoff belongs in your broadest seat: if he's a surprise scratch, any eligible
                position off your bench can replace him instead of only a {data.flex_tips![0].move_in_pos}.
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
              Among the chosen starters, the latest kickoffs are seated in the flex spots so a
              late scratch can be covered by any position. On close calls: favored in your matchup → take the safer floor; trailing or underdog →
              take the upside.
            </div>
          </div>
        </>
      )}
    </div>
  )
}
