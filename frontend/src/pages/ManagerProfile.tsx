import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartTooltip, ReferenceLine, Cell,
} from 'recharts'
import ReactMarkdown from 'react-markdown'
import { api, type ManagerProfile } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { gradeBadgeVariant, formatDate } from '@/lib/gradeUtils'
import { cn } from '@/lib/utils'

function pct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return (n * 100).toFixed(decimals) + '%'
}

function sign(n: number): string {
  return n >= 0 ? '+' : ''
}

// ── Stat card ───────────────────────────────────────────────────────────────
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="bg-card">
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
        <p className="text-2xl font-semibold font-mono">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}

// ── Horizontal diverging bar chart ──────────────────────────────────────────
// One bar per category showing avg trade differential for a given action.
// Green = got good value; Red = gave away value. Hover for trade count.
function BiasChart({
  data,
  title,
  positiveLabel,
  negativeLabel,
}: {
  data: { label: string; pct: number | null; count: number }[]
  title: string
  positiveLabel: string
  negativeLabel: string
}) {
  const MAX_ABS = Math.max(...data.map(d => Math.abs(d.pct ?? 0) * 100), 10)
  const domain = Math.ceil(MAX_ABS / 10) * 10 + 5

  const formatted = data.map(d => ({
    label: d.label,
    value: d.pct != null && d.count > 0 ? Math.round(d.pct * 100) : 0,
    count: d.count,
    hasData: d.pct != null && d.count > 0,
  }))

  return (
    <div className="flex-1 min-w-0">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{title}</p>
      <ResponsiveContainer width="100%" height={data.length * 40 + 24}>
        <BarChart data={formatted} layout="vertical" margin={{ top: 2, right: 32, bottom: 2, left: 0 }}>
          <XAxis
            type="number"
            domain={[-domain, domain]}
            tick={{ fontSize: 9, fill: '#555' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => `${v > 0 ? '+' : ''}${v}%`}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fontSize: 11, fill: '#ccc' }}
            axisLine={false}
            tickLine={false}
            width={70}
          />
          <ReferenceLine x={0} stroke="#444" />
          <RechartTooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            formatter={(v, _name, props) => {
              const entry = (props as { payload?: { hasData?: boolean; count?: number } }).payload
              if (!entry?.hasData) return ['No data', '']
              const num = Number(v)
              const sign = num >= 0 ? '+' : ''
              const label = num >= 0 ? positiveLabel : negativeLabel
              return [`${sign}${num}% — ${label} (${entry.count} trades)`, title]
            }}
            contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: '#aaa' }}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {formatted.map((entry, i) => (
              <Cell
                key={i}
                fill={!entry.hasData ? '#2a2a2a' : entry.value >= 0 ? '#4ade80' : '#f87171'}
                fillOpacity={entry.hasData ? 0.85 : 0.4}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}


export default function ManagerProfile() {
  const { leagueId, userId } = useParams<{ leagueId: string; userId: string }>()
  const navigate = useNavigate()
  const [profile, setProfile] = useState<ManagerProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [scoutingReport, setScoutingReport] = useState<string | null>(null)
  const [scope, setScope] = useState<'family' | 'all'>('family')

  useEffect(() => {
    if (!leagueId || !userId) return
    setLoading(true)
    api.getManagerProfile(leagueId, userId, scope)
      .then(p => { setProfile(p); setScoutingReport(p.scouting_report) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId, userId, scope])

  const handleGenerateReport = async () => {
    if (!profile || !leagueId || !userId) return
    setGeneratingReport(true)
    try {
      const result = await api.generateScoutingReport(userId, leagueId, scope)
      setScoutingReport(result.report)
    } catch (e) {
      setError(String(e))
    } finally {
      setGeneratingReport(false)
    }
  }

  if (error) return (
    <div className="rounded-xl border border-red-800 bg-red-950/30 p-6 text-red-300">{error}</div>
  )

  if (loading || !profile) return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-4 gap-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-20" />)}</div>
      <div className="grid md:grid-cols-2 gap-4">{[1,2].map(i => <Skeleton key={i} className="h-48" />)}</div>
    </div>
  )

  const ds = profile.differential_stats
  const pos = profile.position_biases
  const age = profile.age_biases
  const posture = profile.posture_patterns

  const posBuyData = ['QB', 'RB', 'WR', 'TE'].map(p => ({
    label: p,
    pct: pos[p]?.acquiring.avg_differential ?? null,
    count: pos[p]?.acquiring.count ?? 0,
  }))
  const posSellData = ['QB', 'RB', 'WR', 'TE'].map(p => ({
    label: p,
    pct: pos[p]?.shedding.avg_differential ?? null,
    count: pos[p]?.shedding.count ?? 0,
  }))

  const ageBuyData = [
    { label: 'Young ≤23',   pct: age.young?.acquiring.avg_differential ?? null,   count: age.young?.acquiring.count ?? 0 },
    { label: 'Prime 24-26', pct: age.prime?.acquiring.avg_differential ?? null,   count: age.prime?.acquiring.count ?? 0 },
    { label: 'Veteran 27+', pct: age.veteran?.acquiring.avg_differential ?? null, count: age.veteran?.acquiring.count ?? 0 },
  ]
  const ageSellData = [
    { label: 'Young ≤23',   pct: age.young?.shedding.avg_differential ?? null,   count: age.young?.shedding.count ?? 0 },
    { label: 'Prime 24-26', pct: age.prime?.shedding.avg_differential ?? null,   count: age.prime?.shedding.count ?? 0 },
    { label: 'Veteran 27+', pct: age.veteran?.shedding.avg_differential ?? null, count: age.veteran?.shedding.count ?? 0 },
  ]

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1 flex-wrap">
          <Link to="/" className="hover:text-foreground transition-colors">Leagues</Link>
          <span>/</span>
          <Link to={`/leagues/${leagueId}/trades`} className="hover:text-foreground transition-colors">Trades</Link>
          <span>/</span>
          <Link to={`/leagues/${leagueId}/managers`} className="hover:text-foreground transition-colors">Managers</Link>
          <span>/</span>
          <span>{profile.manager_name}</span>
        </div>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">{profile.manager_name}</h1>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              {profile.scope_label} · {profile.seasons_included.length} season{profile.seasons_included.length !== 1 ? 's' : ''}
              {profile.seasons_included.length > 0 && ` (${profile.seasons_included[0]}–${profile.seasons_included[profile.seasons_included.length - 1]})`}
            </Badge>
            {posture.stuck_signal && (
              <Badge variant="outline" className="text-orange-400 border-orange-700">
                ⚠ Stuck pattern
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border p-1 bg-muted/20">
            {(['family', 'all'] as const).map(s => (
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

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Total Trades"
          value={String(ds.total_trades)}
          sub={`${ds.graded_trades} graded`}
        />
        <StatCard
          label="Win Rate"
          value={ds.win_rate != null ? Math.round(ds.win_rate * 100) + '%' : '—'}
          sub={`${ds.wins}W / ${ds.losses}L / ${ds.neutrals}N`}
        />
        <StatCard
          label="Avg Decision Diff"
          value={ds.avg_decision_differential != null ? `${sign(ds.avg_decision_differential * 100)}${pct(ds.avg_decision_differential)}` : '—'}
          sub="% of larger side"
        />
        <StatCard
          label="Avg Outcome Diff"
          value={ds.avg_outcome_differential != null ? `${sign(ds.avg_outcome_differential * 100)}${pct(ds.avg_outcome_differential)}` : '—'}
          sub="current values"
        />
      </div>

      {/* Best / worst trades */}
      {(ds.best_decision_trade || ds.worst_decision_trade) && (
        <div className="grid md:grid-cols-2 gap-3">
          {ds.best_decision_trade && (
            <button
              onClick={() => navigate(`/trades/${ds.best_decision_trade!.trade_id}`)}
              className="text-left rounded-xl border border-green-800 bg-green-950/20 p-4 hover:bg-green-950/40 transition-colors"
            >
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Best Trade</p>
              <div className="flex items-center gap-2">
                <span className={cn('text-sm font-mono font-semibold px-1.5 py-0.5 rounded border', gradeBadgeVariant(ds.best_decision_trade.letter_grade))}>
                  {ds.best_decision_trade.letter_grade}
                </span>
                <span className="text-sm text-green-400 font-mono">+{ds.best_decision_trade.differential.toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">{formatDate(ds.best_decision_trade.executed_at)}</span>
              </div>
            </button>
          )}
          {ds.worst_decision_trade && (
            <button
              onClick={() => navigate(`/trades/${ds.worst_decision_trade!.trade_id}`)}
              className="text-left rounded-xl border border-red-800 bg-red-950/20 p-4 hover:bg-red-950/40 transition-colors"
            >
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Worst Trade</p>
              <div className="flex items-center gap-2">
                <span className={cn('text-sm font-mono font-semibold px-1.5 py-0.5 rounded border', gradeBadgeVariant(ds.worst_decision_trade.letter_grade))}>
                  {ds.worst_decision_trade.letter_grade}
                </span>
                <span className="text-sm text-red-400 font-mono">{ds.worst_decision_trade.differential.toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">{formatDate(ds.worst_decision_trade.executed_at)}</span>
              </div>
            </button>
          )}
        </div>
      )}

      <Separator />

      {/* Position & Age bias charts */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Position Biases</CardTitle>
            <p className="text-xs text-muted-foreground">
              Average trade differential when buying or selling each position.
              Green = got good value. Red = gave away value.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-4">
              <BiasChart
                data={posBuyData}
                title="When Buying"
                positiveLabel="got good value"
                negativeLabel="overpaid"
              />
              <div className="w-px bg-border" />
              <BiasChart
                data={posSellData}
                title="When Selling"
                positiveLabel="sold well"
                negativeLabel="undersold"
              />
            </div>
            <Separator />
            <div className="divide-y divide-border text-xs">
              <div className="grid grid-cols-[3rem_1fr_1fr_1fr_1fr_1fr_1fr] gap-x-2 pb-1.5 text-muted-foreground font-medium uppercase tracking-wide">
                <span></span>
                <span className="col-span-3 text-center border-r border-border pb-0.5">Buying</span>
                <span className="col-span-3 text-center">Selling</span>
              </div>
              <div className="grid grid-cols-[3rem_1fr_1fr_1fr_1fr_1fr_1fr] gap-x-2 pb-1.5 text-muted-foreground font-medium uppercase tracking-wide">
                <span></span><span>n</span><span>Avg</span><span>W/L</span>
                <span>n</span><span>Avg</span><span>W/L</span>
              </div>
              {(['QB','RB','WR','TE'] as const).map(p => {
                const a = pos[p]?.acquiring
                const s = pos[p]?.shedding
                const ac = (v: number | null) => v == null ? 'text-muted-foreground' : v > 0.03 ? 'text-green-400' : v < -0.03 ? 'text-red-400' : 'text-yellow-400'
                return (
                  <div key={p} className="grid grid-cols-[3rem_1fr_1fr_1fr_1fr_1fr_1fr] gap-x-2 py-1.5 items-center">
                    <span className="font-semibold text-foreground">{p}</span>
                    <span className="text-muted-foreground">{a?.count ?? 0}</span>
                    <span className={cn('font-mono font-semibold', ac(a?.avg_differential ?? null))}>{a?.avg_differential != null ? `${sign(a.avg_differential * 100)}${pct(a.avg_differential)}` : '—'}</span>
                    <span className="text-muted-foreground">{a?.wins ?? 0}W {a?.losses ?? 0}L</span>
                    <span className="text-muted-foreground">{s?.count ?? 0}</span>
                    <span className={cn('font-mono font-semibold', ac(s?.avg_differential ?? null))}>{s?.avg_differential != null ? `${sign(s.avg_differential * 100)}${pct(s.avg_differential)}` : '—'}</span>
                    <span className="text-muted-foreground">{s?.wins ?? 0}W {s?.losses ?? 0}L</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Age Biases</CardTitle>
            <p className="text-xs text-muted-foreground">
              Average trade differential when buying or selling players by age bracket.
              Age calculated at time of each trade.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-4">
              <BiasChart
                data={ageBuyData}
                title="When Buying"
                positiveLabel="got good value"
                negativeLabel="overpaid"
              />
              <div className="w-px bg-border" />
              <BiasChart
                data={ageSellData}
                title="When Selling"
                positiveLabel="sold well"
                negativeLabel="undersold"
              />
            </div>
            <Separator />
            <div className="divide-y divide-border text-xs">
              <div className="grid grid-cols-[7rem_1fr_1fr_1fr_1fr_1fr_1fr] gap-x-2 pb-1.5 text-muted-foreground font-medium uppercase tracking-wide">
                <span></span>
                <span className="col-span-3 text-center border-r border-border pb-0.5">Buying</span>
                <span className="col-span-3 text-center">Selling</span>
              </div>
              <div className="grid grid-cols-[7rem_1fr_1fr_1fr_1fr_1fr_1fr] gap-x-2 pb-1.5 text-muted-foreground font-medium uppercase tracking-wide">
                <span></span><span>n</span><span>Avg</span><span>W/L</span>
                <span>n</span><span>Avg</span><span>W/L</span>
              </div>
              {(['young','prime','veteran'] as const).map(b => {
                const a = age[b]?.acquiring
                const s = age[b]?.shedding
                const ac = (v: number | null) => v == null ? 'text-muted-foreground' : v > 0.03 ? 'text-green-400' : v < -0.03 ? 'text-red-400' : 'text-yellow-400'
                return (
                  <div key={b} className="grid grid-cols-[7rem_1fr_1fr_1fr_1fr_1fr_1fr] gap-x-2 py-1.5 items-center">
                    <span className="font-semibold text-foreground text-xs">{age[b]?.label ?? b}</span>
                    <span className="text-muted-foreground">{a?.count ?? 0}</span>
                    <span className={cn('font-mono font-semibold', ac(a?.avg_differential ?? null))}>{a?.avg_differential != null ? `${sign(a.avg_differential * 100)}${pct(a.avg_differential)}` : '—'}</span>
                    <span className="text-muted-foreground">{a?.wins ?? 0}W {a?.losses ?? 0}L</span>
                    <span className="text-muted-foreground">{s?.count ?? 0}</span>
                    <span className={cn('font-mono font-semibold', ac(s?.avg_differential ?? null))}>{s?.avg_differential != null ? `${sign(s.avg_differential * 100)}${pct(s.avg_differential)}` : '—'}</span>
                    <span className="text-muted-foreground">{s?.wins ?? 0}W {s?.losses ?? 0}L</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Posture patterns */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Trade Posture Patterns</CardTitle>
          <p className="text-xs text-muted-foreground">{posture.note}</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {(['rebuild','contend','neutral'] as const).map(type => {
              const stat = posture[type]
              const avg = stat.avg_differential ?? 0
              const color = avg > 0.03 ? 'text-green-400' : avg < -0.03 ? 'text-red-400' : 'text-yellow-400'
              const labels = { rebuild: 'Rebuild', contend: 'Contend', neutral: 'Neutral' }
              const descriptions = {
                rebuild: 'Received picks',
                contend: 'Received players',
                neutral: 'Mixed assets',
              }
              return (
                <div key={type} className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium capitalize mb-0.5">{labels[type]}</p>
                  <p className="text-xs text-muted-foreground mb-2">{descriptions[type]}</p>
                  {stat.count === 0 ? (
                    <p className="text-xs text-muted-foreground">No trades</p>
                  ) : (
                    <>
                      <p className={cn('text-lg font-semibold font-mono', color)}>
                        {sign(avg * 100)}{pct(stat.avg_differential)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {stat.count} trades · {stat.wins}W {stat.losses}L
                      </p>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Draft capital conversion */}
      {profile.pick_conversion && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Draft Capital Conversion</CardTitle>
            <p className="text-xs text-muted-foreground">
              What actually became of the picks this manager traded for and traded away —
              each pick resolved to the player drafted with it, valued today vs the pick's cost at trade time.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {profile.pick_conversion.tendency && (
              <p className="text-sm text-primary leading-relaxed">{profile.pick_conversion.tendency}</p>
            )}
            <div className="grid sm:grid-cols-2 gap-4">
              {([['acquired', 'Picks Acquired'], ['shed', 'Picks Traded Away']] as const).map(([key, label]) => {
                const side = profile.pick_conversion![key]
                return (
                  <div key={key} className="rounded-lg border border-border p-3 space-y-1.5">
                    <p className="text-sm font-medium">{label}</p>
                    {side.resolved === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {side.count === 0 ? 'No picks traded' : `${side.count} picks, none resolved to players yet`}
                      </p>
                    ) : (
                      <>
                        <p className="text-lg font-semibold font-mono">
                          <span className={cn(
                            (side.median_return_ratio ?? 0) >= 1 ? 'text-green-400'
                              : (side.median_return_ratio ?? 0) < 0.6 ? 'text-red-400' : 'text-yellow-400'
                          )}>
                            {side.median_return_ratio}x
                          </span>
                          <span className="text-xs text-muted-foreground font-normal ml-1.5">median return</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {side.resolved} resolved of {side.count} · hit {Math.round((side.hit_rate ?? 0) * 100)}% · bust {Math.round((side.bust_rate ?? 0) * 100)}%
                        </p>
                        {side.best && side.best.ratio >= 1.2 && (
                          <p className="text-xs">
                            <span className="text-green-400">Best:</span> {side.best.pick_label} → {side.best.player_name} ({side.best.cost_at_trade.toLocaleString()} → {side.best.value_now.toLocaleString()})
                          </p>
                        )}
                        {side.worst && side.worst.ratio < 0.8 && (
                          <p className="text-xs">
                            <span className="text-red-400">Worst:</span> {side.worst.pick_label} → {side.worst.player_name} ({side.worst.cost_at_trade.toLocaleString()} → {side.worst.value_now.toLocaleString()})
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Scouting report */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="text-base">AI Scouting Report</CardTitle>
            {profile.anthropic_configured ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleGenerateReport}
                disabled={generatingReport}
              >
                {generatingReport ? 'Generating…' : scoutingReport ? 'Regenerate' : 'Generate Scouting Report'}
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span>
                      <Button size="sm" variant="outline" disabled>
                        Generate Scouting Report
                      </Button>
                    </span>
                  }
                />
                <TooltipContent>
                  Set ANTHROPIC_API_KEY in your .env file to enable this feature.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {scoutingReport ? (
            <div className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_strong]:text-foreground [&_p]:mb-2 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:mb-0.5">
              <ReactMarkdown>{scoutingReport}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              {profile.anthropic_configured
                ? 'Click "Generate Scouting Report" to get an AI-powered analysis.'
                : 'Configure ANTHROPIC_API_KEY in .env to enable AI scouting reports.'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
