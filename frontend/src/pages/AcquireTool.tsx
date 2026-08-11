import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  api,
  type AcquireResponse,
  type AcquireTarget,
  type AcquirePlayer,
  type DealPackage,
  type LeagueSummaryForDashboard,
  type PositionalNeeds,
} from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const POSITIONS = ['QB', 'RB', 'WR', 'TE']

const POSTURE_LABELS: Record<string, string> = {
  rebuild: 'Rebuilding',
  contend: 'Contending',
  middling: 'Middling',
}
const POSTURE_COLORS: Record<string, string> = {
  rebuild: 'text-blue-400',
  contend: 'text-orange-400',
  middling: 'text-muted-foreground',
}

const PACKAGE_KIND_LABELS: Record<string, string> = {
  picks_only: 'Picks package',
  player_plus_pick: 'Player + pick',
  player_swap: 'Player swap',
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color = pct >= 70 ? 'bg-green-500' : pct >= 45 ? 'bg-yellow-500' : 'bg-muted-foreground'
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted-foreground w-7">{pct}</span>
    </div>
  )
}

function PlayerChip({ p }: { p: AcquirePlayer }) {
  return (
    <span
      className={cn(
        'text-xs px-2 py-1 rounded-md border font-mono inline-flex items-center gap-1.5',
        p.likely_available
          ? 'border-green-400 bg-green-100 text-green-900 dark:border-green-700 dark:bg-green-950/40 dark:text-green-300'
          : 'border-border text-muted-foreground'
      )}
      title={
        p.availability_reason
          ? `Likely available: ${p.availability_reason}`
          : 'Probably not available — their top asset at the position'
      }
    >
      {p.name}
      <span className="text-muted-foreground">{(p.value / 1000).toFixed(1)}k</span>
      {p.age != null && <span className="text-muted-foreground">· {Math.floor(p.age)}y</span>}
      {p.likely_available && <span className="text-green-400">●</span>}
    </span>
  )
}

function PackageCard({ pkg }: { pkg: DealPackage }) {
  const light = pkg.package_value < pkg.adjusted_target_value * 0.95
  const fair = !light && pkg.package_value <= pkg.adjusted_target_value * 1.1
  return (
    <div className="rounded-lg border border-border/70 bg-background/50 p-2.5 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{PACKAGE_KIND_LABELS[pkg.kind] ?? pkg.kind}</span>
        <span
          className={cn('text-xs font-mono', fair ? 'text-green-400' : 'text-yellow-400')}
          title="'Their price' is what this manager is likely to demand for this payment mix — pick-heavy offers get cheaper when their accepted picks historically bust."
        >
          give {(pkg.package_value / 1000).toFixed(1)}k · their price {(pkg.adjusted_target_value / 1000).toFixed(1)}k
        </span>
      </div>
      <p className="text-xs font-mono">
        {pkg.items.map(i => i.label).join(' + ')}
      </p>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {pkg.rationale}
        {pkg.adjusted_target_value < pkg.sticker_value && (
          <span className="text-green-400">
            {' '}(sticker {(pkg.sticker_value / 1000).toFixed(1)}k → their price paid this way{' '}
            {(pkg.adjusted_target_value / 1000).toFixed(1)}k)
          </span>
        )}
        {light && (
          <span className="text-yellow-500">
            {' '}— a touch light; be ready to add a small sweetener
          </span>
        )}
      </p>
    </div>
  )
}

function ReceptivityStrip({ target }: { target: AcquireTarget }) {
  const r = target.pick_receptivity
  if (!r) return null
  const skill = r.draft_skill
  const chips: { text: string; cls: string; title?: string }[] = []

  if (r.appetite_share != null) {
    const pct = Math.round(r.appetite_share * 100)
    chips.push(
      r.appetite_share >= 0.2
        ? {
            text: `takes pick deals (${pct}%)`,
            cls: 'border-purple-300 bg-purple-100 text-purple-900 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300',
            title: `Received picks in ${r.appetite_pick_trades} of ${r.appetite_total_trades} trades (recency-weighted ${pct}%)`,
          }
        : {
            text: `players-only trader (${pct}%)`,
            cls: 'border-border text-muted-foreground',
            title: `Received picks in only ${r.appetite_pick_trades} of ${r.appetite_total_trades} trades — lead with players`,
          }
    )
  }
  if (r.needs_picks) {
    chips.push({
      text: 'needs picks',
      cls: 'border-blue-300 bg-blue-100 text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300',
      title: 'Below-average future draft capital',
    })
  }
  if (skill.label) {
    const skillTitle = [
      skill.best && `Best: ${skill.best.pick} → ${skill.best.player} (${skill.best.ratio}x slot)`,
      skill.worst && `Worst: ${skill.worst.pick} → ${skill.worst.player} (${skill.worst.ratio}x slot)`,
      'Display-only — never affects pricing.',
    ].filter(Boolean).join(' · ')
    chips.push({
      text:
        skill.label === 'cold'
          ? `cold drafter (${skill.median_ratio}x slot, n=${skill.n}) — low-regret pick target`
          : skill.label === 'sharp'
            ? `sharp drafter (${skill.median_ratio}x slot, n=${skill.n}) — picks arm a rival`
            : `average drafter (${skill.median_ratio}x slot, n=${skill.n})`,
      cls:
        skill.label === 'cold'
          ? 'border-green-300 bg-green-100 text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300'
          : skill.label === 'sharp'
            ? 'border-red-300 bg-red-100 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300'
            : 'border-border text-muted-foreground',
      title: skillTitle,
    })
  } else if (skill.n > 0) {
    chips.push({
      text: `draft record thin (n=${skill.n})`,
      cls: 'border-border text-muted-foreground',
      title: 'Too few rookie-draft picks to judge skill yet — the sample grows every season.',
    })
  }

  if (chips.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-muted-foreground">Picks:</span>
      {chips.map((c, i) => (
        <span key={i} title={c.title} className={cn('text-xs px-1.5 py-0.5 rounded border font-mono', c.cls)}>
          {c.text}
        </span>
      ))}
    </div>
  )
}

function TargetCard({ target, leagueId }: { target: AcquireTarget; leagueId: string }) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => navigate(`/leagues/${leagueId}/managers/${target.user_id}`)}
              className="font-medium text-sm hover:text-primary transition-colors"
            >
              {target.manager_name}
            </button>
            <span className={cn('text-xs font-medium', POSTURE_COLORS[target.their_posture])}>
              {POSTURE_LABELS[target.their_posture]}
            </span>
            {target.surplus_pct > 0.1 && (
              <span className="text-xs font-mono text-green-400">
                +{Math.round(target.surplus_pct * 100)}% depth
              </span>
            )}
            <span className="text-xs text-muted-foreground">{target.total_trades} trades</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{target.summary}</p>
          <ReceptivityStrip target={target} />
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted-foreground mb-0.5">Fit</p>
          <ScoreBar score={target.acquisition_score} />
        </div>
      </div>

      {/* Their roster at the position */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {target.players.map(p => (
          <PlayerChip key={p.player_id} p={p} />
        ))}
        {target.players.length === 0 && (
          <span className="text-xs text-muted-foreground italic">no players at this position</span>
        )}
      </div>

      {/* Suggested packages */}
      {target.suggestions.length > 0 && (
        <div className="pt-1 border-t border-border/50 space-y-2">
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs text-primary hover:underline"
          >
            {expanded ? '▾ hide' : '▸ show'} suggested deals ({target.suggestions.length}{' '}
            {target.suggestions.length === 1 ? 'player' : 'players'})
          </button>
          {expanded &&
            target.suggestions.map(s => (
              <div key={s.player.player_id} className="space-y-1.5">
                <p className="text-xs font-semibold">
                  For {s.player.name}{' '}
                  <span className="text-muted-foreground font-normal">
                    ({(s.player.value / 1000).toFixed(1)}k
                    {s.player.availability_reason ? ` — ${s.player.availability_reason}` : ''})
                  </span>
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {s.packages.map((pkg, i) => (
                    <PackageCard key={i} pkg={pkg} />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function needChipClass(score: number, clickable: boolean): string {
  const base = clickable ? 'cursor-pointer hover:ring-2 hover:ring-ring/40 ' : ''
  if (score > 0.05)
    return base + 'border-red-300 bg-red-100 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
  if (score < -0.05)
    return base + 'border-green-300 bg-green-100 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300'
  return base + 'border-border text-muted-foreground'
}

function NeedsOverview({
  leagues,
  allNeeds,
  activeLeagueId,
  activePosition,
  onSelect,
}: {
  leagues: LeagueSummaryForDashboard[]
  allNeeds: Record<string, PositionalNeeds>
  activeLeagueId: string
  activePosition: string
  onSelect: (leagueId: string, position: string) => void
}) {
  if (leagues.length === 0) return null
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Where your teams are thin</CardTitle>
        <p className="text-xs text-muted-foreground">
          Roster value vs league average, per position. Click a{' '}
          <span className="text-red-400 font-medium">red need</span> to hunt for it below.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {leagues.map(l => {
          const needs = allNeeds[l.league_id]
          const biggest = needs
            ? Object.entries(needs.needs)
                .filter(([pos]) => pos !== 'PICKS')
                .sort((a, b) => b[1].need_score - a[1].need_score)[0]
            : null
          return (
            <div key={l.league_id} className="flex items-center gap-3 flex-wrap">
              <span
                className={cn(
                  'text-xs font-medium w-44 truncate',
                  l.league_id === activeLeagueId ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {l.name}
              </span>
              {!needs ? (
                <Skeleton className="h-6 w-64 rounded" />
              ) : (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {['QB', 'RB', 'WR', 'TE', 'PICKS'].map(pos => {
                    const d = needs.needs[pos]
                    if (!d) return null
                    const clickable = pos !== 'PICKS'
                    const active = l.league_id === activeLeagueId && pos === activePosition
                    return (
                      <button
                        key={pos}
                        disabled={!clickable}
                        onClick={() => clickable && onSelect(l.league_id, pos)}
                        title={
                          pos === 'PICKS'
                            ? `Draft capital: ${d.label}`
                            : `${pos}: you ${(d.my_value / 1000).toFixed(1)}k vs ${(d.league_avg / 1000).toFixed(1)}k avg — ${d.label}`
                        }
                        className={cn(
                          'text-xs px-2 py-0.5 rounded border font-mono transition-all',
                          needChipClass(d.need_score, clickable),
                          active && 'ring-2 ring-ring'
                        )}
                      >
                        {pos === 'PICKS' ? 'PKS' : pos}{' '}
                        {d.need_score > 0.05 ? '▼' : d.need_score < -0.05 ? '▲' : '—'}
                        {Math.abs(d.need_score) > 0.05 && (
                          <span className="opacity-70"> {Math.round(Math.abs(d.need_score) * 100)}%</span>
                        )}
                      </button>
                    )
                  })}
                  {biggest && biggest[1].need_score > 0.05 && (
                    <span className="text-xs text-muted-foreground italic ml-1">
                      → go get a {biggest[0]}
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export default function AcquireTool() {
  const [leagues, setLeagues] = useState<LeagueSummaryForDashboard[]>([])
  const [allNeeds, setAllNeeds] = useState<Record<string, PositionalNeeds>>({})
  const [leagueId, setLeagueId] = useState<string>('')
  const [position, setPosition] = useState<string>('WR')
  const [data, setData] = useState<AcquireResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.getDashboard().then(d => {
      setLeagues(d.leagues)
      if (d.leagues.length > 0) setLeagueId(d.leagues[0].league_id)
      d.leagues.forEach(l => {
        api.getRosterNeeds(l.league_id)
          .then(n => setAllNeeds(prev => ({ ...prev, [l.league_id]: n })))
          .catch(console.error)
      })
    }).catch(console.error)
  }, [])

  useEffect(() => {
    if (!leagueId) return
    setLoading(true)
    api.getAcquire(leagueId, position)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [leagueId, position])

  const ctx = data?.my_context

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Acquire a player</h1>
          <p className="text-sm text-muted-foreground">
            Tell it what you need — it finds who has it, who'll sell it cheap, and how to pay.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select
            value={leagueId}
            onValueChange={v => { if (v) setLeagueId(v) }}
            items={Object.fromEntries(leagues.map(l => [l.league_id, l.name]))}
          >
            <SelectTrigger className="h-8 text-xs w-52">
              <SelectValue placeholder="Select league" />
            </SelectTrigger>
            <SelectContent>
              {leagues.map(l => (
                <SelectItem key={l.league_id} value={l.league_id} className="text-xs">
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {POSITIONS.map(p => (
              <button
                key={p}
                onClick={() => setPosition(p)}
                className={cn(
                  'px-3 py-1.5 text-xs font-mono font-semibold transition-colors',
                  p === position
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Needs overview across all my teams */}
      <NeedsOverview
        leagues={leagues}
        allNeeds={allNeeds}
        activeLeagueId={leagueId}
        activePosition={position}
        onSelect={(lid, pos) => { setLeagueId(lid); setPosition(pos) }}
      />

      {/* My context strip */}
      {ctx && !loading && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Your war chest</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-4 flex-wrap text-xs">
              <span>
                Your {data!.position}:{' '}
                <span className={cn('font-mono font-semibold', ctx.my_value < ctx.league_avg ? 'text-red-400' : 'text-green-400')}>
                  {(ctx.my_value / 1000).toFixed(1)}k
                </span>{' '}
                <span className="text-muted-foreground">vs {(ctx.league_avg / 1000).toFixed(1)}k league avg</span>
              </span>
              {ctx.surplus_positions.length > 0 && (
                <span className="text-muted-foreground">
                  Surplus at: <span className="text-green-400 font-mono">{ctx.surplus_positions.join(', ')}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground mr-1">Picks to spend:</span>
              {ctx.pick_inventory.map((p, i) => (
                <span key={`${p.label}-${i}`} className="text-xs px-1.5 py-0.5 rounded border border-purple-300 bg-purple-100 text-purple-900 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300 font-mono">
                  {p.label} · {(p.value / 1000).toFixed(1)}k
                </span>
              ))}
              {ctx.pick_inventory.length === 0 && (
                <span className="text-xs text-muted-foreground italic">no future picks — you'd be paying with players</span>
              )}
            </div>
            {ctx.offerable_players.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-muted-foreground mr-1">Players you could move:</span>
                {ctx.offerable_players.slice(0, 6).map(p => (
                  <span key={p.player_id} className="text-xs px-1.5 py-0.5 rounded border border-border font-mono text-muted-foreground">
                    {p.name} ({p.position}) · {(p.value / 1000).toFixed(1)}k
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Targets */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        </div>
      ) : data ? (
        <div className="space-y-2">
          {data.targets.map(t => (
            <TargetCard key={t.user_id} target={t} leagueId={data.league_id} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-8 text-center">Pick a league to get started.</p>
      )}
    </div>
  )
}
