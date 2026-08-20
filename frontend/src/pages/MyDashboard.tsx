import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api, type DashboardData, type RecentTrade, type BiasHighlight } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { TradeTargets } from '@/components/TradeTargets'
import { gradeBadgeVariant, formatDate } from '@/lib/gradeUtils'
import { cn } from '@/lib/utils'

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <Card className="bg-card">
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
        <p className={cn('text-2xl font-semibold font-mono', color ?? '')}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}

// ── Bias highlight card ───────────────────────────────────────────────────────
function BiasCard({ highlight }: { highlight: BiasHighlight }) {
  const isNegative = highlight.avg_differential < -0.03
  const isPositive = highlight.avg_differential > 0.03
  const border = isNegative ? 'border-red-800' : isPositive ? 'border-green-800' : 'border-border'
  const bg = isNegative ? 'bg-red-950/20' : isPositive ? 'bg-green-950/20' : 'bg-card'
  const diffColor = isNegative ? 'text-red-400' : isPositive ? 'text-green-400' : 'text-yellow-400'

  const description = isNegative
    ? `You give away ~${Math.abs(Math.round(highlight.avg_differential * 100))}% of value — ${highlight.wins}W / ${highlight.losses}L in ${highlight.count} trades`
    : `You capture ~${Math.abs(Math.round(highlight.avg_differential * 100))}% extra value — ${highlight.wins}W / ${highlight.losses}L in ${highlight.count} trades`

  return (
    <div className={cn('rounded-xl border p-3 space-y-1', border, bg)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{highlight.label}</p>
        <span className={cn('text-sm font-mono font-bold', diffColor)}>
          {pct(highlight.avg_differential)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

// ── Recent trade row ──────────────────────────────────────────────────────────
const LENS_LABELS: Record<string, string> = { ours: 'ours', market: 'mkt', experts: 'exp' }
const LENS_TITLES: Record<string, string> = {
  ours: 'RosterAudit (our pricing model)',
  market: 'FantasyCalc — real completed trades',
  experts: 'DynastyProcess — expert consensus (picks priced at our values)',
}

function LensChip({ lens, grades }: { lens: string; grades: { decision: import('@/lib/api').LensGrade | null; outcome: import('@/lib/api').LensGrade | null } }) {
  const d = grades.decision
  const o = grades.outcome
  if (!d && !o) return null
  // Hindsight is the point: color by where the trade stands TODAY, show
  // the journey (decision→outcome) when the grade has moved.
  const current = o ?? d!
  const moved = d && o && d.letter !== o.letter
  const title = [
    LENS_TITLES[lens],
    d ? `At the time: ${d.letter} (${d.pct > 0 ? '+' : ''}${Math.round(d.pct * 100)}%)${d.estimated ? ' — estimated, no price history that far back' : ''}` : null,
    o ? `Today: ${o.letter} (${o.pct > 0 ? '+' : ''}${Math.round(o.pct * 100)}%)${o.realized ? ' — conveyed picks valued as the players drafted with them' : ''}` : null,
    'Outcome grades move as values change — a contested buy that hits will climb over time.',
  ].filter(Boolean).join(' · ')
  return (
    <span
      title={title}
      className={cn('text-xs font-mono px-1 py-0.5 rounded border inline-flex items-center gap-0.5', gradeBadgeVariant(current.letter))}
    >
      <span className="opacity-60 text-[9px]">{LENS_LABELS[lens]}</span>
      {moved ? `${d!.letter}→${o!.letter}` : current.letter}
      {d?.estimated && <span className="opacity-60">~</span>}
      {o?.realized && <span className="opacity-60" title="Conveyed picks valued as the players drafted with them">•</span>}
    </span>
  )
}

function RecentTradeRow({ trade }: { trade: RecentTrade }) {
  const navigate = useNavigate()
  const diffColor = trade.decision_differential > 0
    ? 'text-green-400'
    : trade.decision_differential < 0
    ? 'text-red-400'
    : 'text-muted-foreground'

  const lensEntries = trade.lenses
    ? (['ours', 'market', 'experts'] as const).filter(k => trade.lenses![k])
    : []
  const letters = lensEntries
    .map(k => trade.lenses![k].decision?.letter)
    .filter(Boolean) as string[]
  const disagree =
    letters.length > 1 &&
    letters.some(l => l.startsWith('A') || l.startsWith('B')) &&
    letters.some(l => l === 'D' || l === 'F')

  return (
    <button
      onClick={() => navigate(`/trades/${trade.trade_id}`)}
      className="w-full text-left flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors cursor-pointer"
    >
      {/* Grades — one chip per lens */}
      <div className="flex items-center gap-1 shrink-0">
        {lensEntries.length > 0 ? (
          <>
            {lensEntries.map(k => (
              <LensChip key={k} lens={k} grades={trade.lenses![k]} />
            ))}
            {disagree && (
              <span
                className="text-xs"
                title="Sources disagree sharply on this trade — it likely hinges on a contested player. The F and the win can both be 'right' depending on whose prices you believe."
              >
                ⚖️
              </span>
            )}
          </>
        ) : trade.decision_grade ? (
          <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded border', gradeBadgeVariant(trade.decision_grade))}>
            {trade.decision_grade}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground w-8">—</span>
        )}
      </div>

      {/* Assets */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-green-400 font-medium truncate">
            ↓ {trade.assets_received.slice(0, 2).join(', ') || '—'}
            {trade.assets_received.length > 2 && ` +${trade.assets_received.length - 2}`}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-red-400 truncate">
            ↑ {trade.assets_given.slice(0, 2).join(', ') || '—'}
            {trade.assets_given.length > 2 && ` +${trade.assets_given.length - 2}`}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xs text-muted-foreground">{trade.league_name}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">{formatDate(trade.executed_at)}</span>
        </div>
      </div>

      {/* Differential */}
      <span className={cn('text-xs font-mono shrink-0', diffColor)}>
        {trade.decision_differential > 0 ? '+' : ''}{trade.decision_differential.toLocaleString()}
      </span>
    </button>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────
export default function MyDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getDashboard()
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (error) {
    return (
      <div className="rounded-xl border border-red-800 bg-red-950/30 p-6 text-red-300">
        <p className="font-medium">Failed to load dashboard</p>
        <p className="text-sm mt-1">{error}</p>
        <p className="text-sm mt-2 text-muted-foreground">
          Make sure <code className="text-xs bg-muted px-1 py-0.5 rounded">SLEEPER_USER_ID</code> is set in <code className="text-xs bg-muted px-1 py-0.5 rounded">.env</code> and the backend is running.
        </p>
      </div>
    )
  }

  const stats = data?.overall_stats

  return (
    <div className="space-y-8">

      {/* ── Section 1: My Trade Record ─────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">My Trade Record</h2>
          <span className="text-xs text-muted-foreground">All leagues · all seasons</span>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Total Trades"
              value={stats ? String(stats.total_trades) : '—'}
              sub={stats ? `${stats.graded_trades} graded` : undefined}
            />
            <StatCard
              label="Win Rate"
              value={stats?.win_rate != null ? `${Math.round(stats.win_rate * 100)}%` : '—'}
              sub={stats ? `${stats.wins}W / ${stats.losses}L / ${stats.neutrals}N` : undefined}
              color={stats?.win_rate != null ? stats.win_rate >= 0.5 ? 'text-green-400' : stats.win_rate >= 0.35 ? 'text-yellow-400' : 'text-red-400' : undefined}
            />
            <StatCard
              label="Avg Decision"
              value={stats?.avg_decision_differential != null ? pct(stats.avg_decision_differential) : '—'}
              sub="per trade differential"
              color={stats?.avg_decision_differential != null ? stats.avg_decision_differential >= 0.03 ? 'text-green-400' : stats.avg_decision_differential <= -0.03 ? 'text-red-400' : 'text-yellow-400' : undefined}
            />
            <StatCard
              label="Avg Outcome"
              value={stats?.avg_outcome_differential != null ? pct(stats.avg_outcome_differential) : '—'}
              sub="current values"
              color={stats?.avg_outcome_differential != null ? stats.avg_outcome_differential >= 0.03 ? 'text-green-400' : stats.avg_outcome_differential <= -0.03 ? 'text-red-400' : 'text-yellow-400' : undefined}
            />
          </div>
        )}
      </div>

      {/* ── Section 2: My Biggest Biases ──────────────────────── */}
      {(loading || (data?.bias_highlights && data.bias_highlights.length > 0)) && (
        <div>
          <h2 className="text-lg font-semibold mb-4">My Trading Tendencies</h2>
          {loading ? (
            <div className="grid md:grid-cols-3 gap-3">
              {[1,2,3].map(i => <Skeleton key={i} className="h-16" />)}
            </div>
          ) : (
            <div className="grid md:grid-cols-3 gap-3">
              {data!.bias_highlights.map((h, i) => <BiasCard key={i} highlight={h} />)}
            </div>
          )}
        </div>
      )}

      {/* ── Section 3: Recent Trades ───────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Recent Trades</h2>
          <Link to="/leagues" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Browse all leagues →
          </Link>
        </div>

        <Card className="bg-card">
          <CardContent className="p-2">
            {loading ? (
              <div className="space-y-1">
                {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !data?.recent_trades.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">No trades found. Run <code className="text-xs bg-muted px-1 py-0.5 rounded">make ingest</code> to load your data.</p>
            ) : (
              <div className="divide-y divide-border/50">
                {data.recent_trades.map(t => (
                  <RecentTradeRow key={t.trade_id} trade={t} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Section 4: Trade Targets ───────────────────────────── */}
      <div>
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Trade Targets</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Ranked by opportunity — who to call based on their tendencies and your posture.
            Set your posture per league to sharpen the rankings.
          </p>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[1,2].map(i => <Skeleton key={i} className="h-48 w-full rounded-xl" />)}
          </div>
        ) : !data?.leagues.length ? (
          <p className="text-sm text-muted-foreground">No leagues found.</p>
        ) : (
          <div className="space-y-4">
            {data.leagues.map(league => (
              <TradeTargets
                key={league.league_id}
                leagueId={league.league_id}
                leagueName={league.name}
                initialPosture={league.my_posture}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
