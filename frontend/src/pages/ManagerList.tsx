import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, type ManagerSummary } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { gradeBadgeVariant } from '@/lib/gradeUtils'
import { cn } from '@/lib/utils'

type SortKey = 'win_rate' | 'avg_decision_differential' | 'total_trades' | 'wins'
type SortDir = 'asc' | 'desc'

function pct(n: number | null | undefined): string {
  if (n == null) return '—'
  return (n * 100).toFixed(1) + '%'
}

function WinRateBar({ rate }: { rate: number | null }) {
  if (rate == null) return <span className="text-muted-foreground text-xs">—</span>
  const pct = Math.round(rate * 100)
  const color = pct >= 50 ? 'bg-green-500' : pct >= 35 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground font-mono">{pct}%</span>
    </div>
  )
}

type Scope = 'family' | 'all'

export default function ManagerList() {
  const { leagueId } = useParams<{ leagueId: string }>()
  const navigate = useNavigate()
  const [managers, setManagers] = useState<ManagerSummary[]>([])
  const [leagueName, setLeagueName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('avg_decision_differential')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [scope, setScope] = useState<Scope>('family')

  useEffect(() => {
    if (!leagueId) return
    setLoading(true)
    api.getManagers(leagueId, scope)
      .then(d => { setManagers(d.managers); setLeagueName(d.league_name) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId, scope])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const sorted = [...managers].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity
    const bv = b[sortKey] ?? -Infinity
    return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
  })

  function SortHeader({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k
    return (
      <button
        onClick={() => handleSort(k)}
        className={cn(
          'text-xs font-medium tracking-wide uppercase hover:text-foreground transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {label} {active ? (sortDir === 'desc' ? '↓' : '↑') : ''}
      </button>
    )
  }

  if (error) return (
    <div className="rounded-xl border border-red-800 bg-red-950/30 p-6 text-red-300">
      {error}
    </div>
  )

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link to="/" className="hover:text-foreground transition-colors">Leagues</Link>
          <span>/</span>
          <Link to={`/leagues/${leagueId}/trades`} className="hover:text-foreground transition-colors">
            {leagueName || '…'}
          </Link>
          <span>/</span>
          <span>Managers</span>
        </div>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Manager Profiles</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Click any manager to see their full trade profile.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border p-1 bg-muted/20">
            {(['family', 'all'] as Scope[]).map(s => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  scope === s ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {s === 'family' ? 'All Seasons' : 'All Leagues'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] gap-4 px-4 py-2 bg-muted/40 border-b border-border">
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Manager</span>
            <SortHeader label="Trades" k="total_trades" />
            <SortHeader label="Win Rate" k="win_rate" />
            <SortHeader label="Avg Diff" k="avg_decision_differential" />
            <SortHeader label="Wins" k="wins" />
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Best / Worst</span>
          </div>

          {/* Rows */}
          {sorted.map((m, idx) => (
            <div key={m.user_id}>
              {idx > 0 && <Separator />}
              <button
                onClick={() => navigate(`/leagues/${leagueId}/managers/${m.user_id}`)}
                className="w-full grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] gap-4 px-4 py-3 hover:bg-muted/30 transition-colors text-left cursor-pointer"
              >
                <span className="font-medium text-sm truncate">{m.manager_name}</span>
                <span className="text-sm text-muted-foreground">{m.total_trades}</span>
                <WinRateBar rate={m.win_rate} />
                <span className={cn('text-sm font-mono', m.avg_decision_differential == null ? 'text-muted-foreground' : m.avg_decision_differential >= 0.03 ? 'text-green-400' : m.avg_decision_differential <= -0.03 ? 'text-red-400' : 'text-yellow-400')}>
                  {pct(m.avg_decision_differential)}
                </span>
                <span className="text-sm">
                  <span className="text-green-400">{m.wins}W</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-red-400">{m.losses}L</span>
                </span>
                <div className="flex items-center gap-1.5">
                  {m.best_grade && (
                    <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded border', gradeBadgeVariant(m.best_grade))}>
                      {m.best_grade}
                    </span>
                  )}
                  {m.worst_grade && (
                    <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded border', gradeBadgeVariant(m.worst_grade))}>
                      {m.worst_grade}
                    </span>
                  )}
                </div>
              </button>
            </div>
          ))}

          {sorted.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              No manager data found. Make sure trades are graded.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
