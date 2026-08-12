import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  api,
  type AcquireResponse,
  type AcquireTarget,
  type AcquirePlayer,
  type AskPackage,
  type AssetRef,
  type DealEvaluation,
  type DealPackage,
  type LeagueSummaryForDashboard,
  type MyAssetsResponse,
  type PositionalNeeds,
  type SellBuyer,
  type SellResponse,
} from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

const POSITIONS = ['QB', 'RB', 'WR', 'TE']

const POSTURE_LABELS: Record<string, string> = {
  rebuild: 'Rebuilding', contend: 'Contending', middling: 'Middling',
}
const POSTURE_COLORS: Record<string, string> = {
  rebuild: 'text-blue-400', contend: 'text-orange-400', middling: 'text-muted-foreground',
}
const PACKAGE_KIND_LABELS: Record<string, string> = {
  picks_only: 'Picks package', player_plus_pick: 'Player + pick', player_swap: 'Player swap',
  player: 'Ask for a player',
}

interface DealItem {
  label: string
  value: number
  ref: AssetRef
}

function refKey(r: AssetRef): string {
  return r.type === 'player' ? `p:${r.player_id}` : `k:${r.season}-${r.round}`
}

function kv(v: number): string {
  return `${(v / 1000).toFixed(1)}k`
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

// ─────────────────────────────────────────────────────────────────────────────
// Needs overview (cross-league)
// ─────────────────────────────────────────────────────────────────────────────

function needChipClass(score: number, clickable: boolean): string {
  const base = clickable ? 'cursor-pointer hover:ring-2 hover:ring-ring/40 ' : ''
  if (score > 0.05)
    return base + 'border-red-300 bg-red-100 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
  if (score < -0.05)
    return base + 'border-green-300 bg-green-100 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300'
  return base + 'border-border text-muted-foreground'
}

function NeedsOverview({
  leagues, allNeeds, activeLeagueId, activePosition, onSelect,
}: {
  leagues: LeagueSummaryForDashboard[]
  allNeeds: Record<string, PositionalNeeds>
  activeLeagueId: string
  activePosition: string | null
  onSelect: (leagueId: string, position: string) => void
}) {
  if (leagues.length === 0) return null
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Where your teams are thin</CardTitle>
        <p className="text-xs text-muted-foreground">
          Roster value vs league average. Click a <span className="text-red-400 font-medium">red need</span> to hunt for it.
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
              <span className={cn('text-xs font-medium w-44 truncate',
                l.league_id === activeLeagueId ? 'text-foreground' : 'text-muted-foreground')}>
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
                        title={pos === 'PICKS'
                          ? `Draft capital: ${d.label}`
                          : `${pos}: you ${kv(d.my_value)} vs ${kv(d.league_avg)} avg — ${d.label}`}
                        className={cn('text-xs px-2 py-0.5 rounded border font-mono transition-all',
                          needChipClass(d.need_score, clickable), active && 'ring-2 ring-ring')}
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
                    <span className="text-xs text-muted-foreground italic ml-1">→ go get a {biggest[0]}</span>
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

// ─────────────────────────────────────────────────────────────────────────────
// Acquire mode components
// ─────────────────────────────────────────────────────────────────────────────

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
      text: skill.label === 'cold'
        ? `cold drafter (${skill.median_ratio}x slot, n=${skill.n}) — low-regret pick target`
        : skill.label === 'sharp'
          ? `sharp drafter (${skill.median_ratio}x slot, n=${skill.n}) — picks arm a rival`
          : `average drafter (${skill.median_ratio}x slot, n=${skill.n})`,
      cls: skill.label === 'cold'
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

function PackageCard({ pkg, onUse }: { pkg: DealPackage; onUse: () => void }) {
  const light = pkg.package_value < pkg.adjusted_target_value * 0.95
  const fair = !light && pkg.package_value <= pkg.adjusted_target_value * 1.1
  return (
    <div className="rounded-lg border border-border/70 bg-background/50 p-2.5 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{PACKAGE_KIND_LABELS[pkg.kind] ?? pkg.kind}</span>
        <span
          className={cn('text-xs font-mono', fair ? 'text-green-400' : 'text-yellow-400')}
          title="'Their price' is what this manager is likely to demand, from their observed trade history."
        >
          give {kv(pkg.package_value)} · their price {kv(pkg.adjusted_target_value)}
        </span>
      </div>
      <p className="text-xs font-mono">{pkg.items.map(i => i.label).join(' + ')}</p>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {pkg.rationale}
        {light && <span className="text-yellow-500"> — a touch light; be ready to add a sweetener</span>}
      </p>
      <button onClick={onUse} className="text-xs text-primary hover:underline">
        ▸ load into deal builder
      </button>
    </div>
  )
}

function AcquireTargetCard({
  target, leagueId, onPickPlayer, onUsePackage,
}: {
  target: AcquireTarget
  leagueId: string
  onPickPlayer: (target: AcquireTarget, p: AcquirePlayer) => void
  onUsePackage: (target: AcquireTarget, p: AcquirePlayer, pkg: DealPackage) => void
}) {
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
              <span className="text-xs font-mono text-green-400">+{Math.round(target.surplus_pct * 100)}% depth</span>
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

      <div className="flex items-center gap-1.5 flex-wrap">
        {target.players.map(p => (
          <button
            key={p.player_id}
            onClick={() => onPickPlayer(target, p)}
            className={cn(
              'text-xs px-2 py-1 rounded-md border font-mono inline-flex items-center gap-1.5 transition-all hover:ring-2 hover:ring-ring/40',
              p.likely_available
                ? 'border-green-400 bg-green-100 text-green-900 dark:border-green-700 dark:bg-green-950/40 dark:text-green-300'
                : 'border-border text-muted-foreground'
            )}
            title={(p.availability_reason ? `Likely available: ${p.availability_reason}. ` : 'Probably not available — their top asset. ') + 'Click to target in the deal builder.'}
          >
            {p.name}
            <span className="opacity-70">{kv(p.value)}</span>
            {p.age != null && <span className="opacity-70">· {Math.floor(p.age)}y</span>}
            {p.likely_available && <span className="text-green-400">●</span>}
          </button>
        ))}
        {target.players.length === 0 && (
          <span className="text-xs text-muted-foreground italic">no players at this position</span>
        )}
      </div>

      {target.suggestions.length > 0 && (
        <div className="pt-1 border-t border-border/50 space-y-2">
          <button onClick={() => setExpanded(e => !e)} className="text-xs text-primary hover:underline">
            {expanded ? '▾ hide' : '▸ show'} suggested deals ({target.suggestions.length}{' '}
            {target.suggestions.length === 1 ? 'player' : 'players'})
          </button>
          {expanded &&
            target.suggestions.map(s => (
              <div key={s.player.player_id} className="space-y-1.5">
                <p className="text-xs font-semibold">
                  For {s.player.name}{' '}
                  <span className="text-muted-foreground font-normal">
                    ({kv(s.player.value)}{s.player.availability_reason ? ` — ${s.player.availability_reason}` : ''})
                  </span>
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {s.packages.map((pkg, i) => (
                    <PackageCard key={i} pkg={pkg} onUse={() => onUsePackage(target, s.player, pkg)} />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sell mode components
// ─────────────────────────────────────────────────────────────────────────────

function AssetChip({
  label, sub, selected, onClick,
}: { label: string; sub: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'text-xs px-2 py-1 rounded-md border font-mono transition-all text-left',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-foreground hover:border-ring'
      )}
    >
      {label} <span className={selected ? 'opacity-80' : 'text-muted-foreground'}>{sub}</span>
    </button>
  )
}

function BuyerCard({
  buyer, leagueId, onUseAsk,
}: {
  buyer: SellBuyer
  leagueId: string
  onUseAsk: (buyer: SellBuyer, ask: AskPackage | null) => void
}) {
  const navigate = useNavigate()
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => navigate(`/leagues/${leagueId}/managers/${buyer.user_id}`)}
              className="font-medium text-sm hover:text-primary transition-colors"
            >
              {buyer.manager_name}
            </button>
            <span className={cn('text-xs font-medium', POSTURE_COLORS[buyer.their_posture])}>
              {POSTURE_LABELS[buyer.their_posture]}
            </span>
            {buyer.premium_pct > 0 && (
              <span className="text-xs font-mono font-semibold text-green-500" title={buyer.premium_reasons.join(' · ')}>
                +{Math.round(buyer.premium_pct * 100)}% premium
              </span>
            )}
            <span className="text-xs text-muted-foreground">{buyer.total_trades} trades</span>
            <button onClick={() => onUseAsk(buyer, null)} className="text-xs text-primary hover:underline">
              ▸ start deal
            </button>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{buyer.summary}</p>
          {buyer.premium_reasons.length > 0 && (
            <p className="text-xs text-green-600 dark:text-green-400 leading-relaxed">
              Ask {kv(buyer.ask_value)} ({buyer.premium_reasons.join('; ')})
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted-foreground mb-0.5">Buyer fit</p>
          <ScoreBar score={buyer.buyer_score} />
        </div>
      </div>

      {buyer.asks.length > 0 ? (
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 pt-1 border-t border-border/50">
          {buyer.asks.map((a, i) => (
            <div key={i} className="rounded-lg border border-border/70 bg-background/50 p-2.5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{PACKAGE_KIND_LABELS[a.kind] ?? a.kind}</span>
                <span className={cn('text-xs font-mono',
                  a.ask_total >= buyer.ask_value * 0.9 ? 'text-green-400' : 'text-yellow-400')}>
                  {kv(a.ask_total)} back
                </span>
              </div>
              <p className="text-xs font-mono">{a.items.map(i2 => i2.label).join(' + ')}</p>
              <button onClick={() => onUseAsk(buyer, a)} className="text-xs text-primary hover:underline">
                ▸ load into deal builder
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic pt-1 border-t border-border/50">
          No clean package from their assets — start the deal and build it by hand.
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Deal builder
// ─────────────────────────────────────────────────────────────────────────────

const VERDICT_STYLES: Record<string, string> = {
  light: 'bg-red-100 text-red-900 border-red-300 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  slightly_light: 'bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800',
  fair: 'bg-green-100 text-green-900 border-green-300 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800',
  rich: 'bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800',
  overpay: 'bg-red-100 text-red-900 border-red-300 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
}

// Map a give÷get ratio (0.6 → 1.4) onto 0 → 100%. Center (1.0) = even.
const ratioPos = (r: number) => Math.max(2, Math.min(98, ((r - 0.6) / 0.8) * 100))

function AcceptanceMeter({ ratio }: { ratio: number | null }) {
  if (ratio == null) return null
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
        Will they take it? <span className="normal-case font-normal">(our values + their trade history)</span>
      </p>
      <div className="relative h-2 rounded-full overflow-hidden flex">
        <div className="bg-red-400/70" style={{ width: '31.25%' }} />
        <div className="bg-yellow-400/70" style={{ width: '12.5%' }} />
        <div className="bg-green-500/80" style={{ width: '18.75%' }} />
        <div className="bg-yellow-400/70" style={{ width: '18.75%' }} />
        <div className="bg-red-400/70" style={{ width: '18.75%' }} />
        <div
          className="absolute top-[-2px] h-3 w-1 rounded bg-foreground shadow"
          style={{ left: `${ratioPos(ratio)}%` }}
          title={`What you send (as they perceive it) ÷ what they'd demand = ${ratio}`}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
        <span>they reject</span>
        <span>deal zone</span>
        <span>they grab it</span>
      </div>
    </div>
  )
}

function ValueLensMeter({
  ours, market, experts,
}: { ours: number | null; market?: number | null; experts?: number | null }) {
  const lenses = [
    { key: 'ours', label: 'ours', ratio: ours, glyph: 'bar' },
    { key: 'market', label: 'market', ratio: market, glyph: 'circle' },
    { key: 'experts', label: 'experts', ratio: experts, glyph: 'diamond' },
  ].filter(l => l.ratio != null) as { key: string; label: string; ratio: number; glyph: string }[]
  if (lenses.length === 0) return null

  const marker = (glyph: string, extra = '') => cn(
    'shadow',
    glyph === 'bar' && 'h-3 w-1 rounded bg-foreground',
    glyph === 'circle' && 'h-2.5 w-2.5 rounded-full bg-background border-2 border-foreground',
    glyph === 'diamond' && 'h-2 w-2 rotate-45 bg-blue-500 border border-background',
    extra,
  )

  return (
    <div className="space-y-0.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
        Is it a fair price? <span className="normal-case font-normal">(you give ÷ you get, by source)</span>
      </p>
      <div className="relative h-2 rounded-full overflow-hidden"
        style={{ background: 'linear-gradient(to right, rgb(34 197 94 / 0.8), rgb(148 163 184 / 0.45) 46%, rgb(148 163 184 / 0.45) 54%, rgb(248 113 113 / 0.8))' }}
      >
        {lenses.map(l => (
          <div
            key={l.key}
            className={cn('absolute', marker(l.glyph))}
            style={{ left: `${ratioPos(l.ratio)}%`, top: l.glyph === 'bar' ? '-2px' : '-1px' }}
            title={`${l.label}: you give ${l.ratio}× what you get`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
        <span>you win</span>
        <span>even</span>
        <span>you overpay</span>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono pt-0.5">
        {lenses.map(l => (
          <span key={l.key} className="inline-flex items-center gap-1">
            <span className={marker(l.glyph, 'inline-block shrink-0')} style={{ position: 'static' }} />
            {l.label} {l.ratio}×
          </span>
        ))}
      </div>
    </div>
  )
}

function DealRow({
  item, ev, onRemove,
}: {
  item: DealItem
  ev?: { value: number; perceived_value?: number; adjusted_value?: number; market_value?: number | null; consensus_value?: number | null; contested?: boolean; note: string | null }
  onRemove: () => void
}) {
  const shown = ev?.perceived_value ?? ev?.adjusted_value
  return (
    <div className="group rounded-md hover:bg-muted/40 px-1.5 -mx-1.5">
      <div className="flex items-center gap-2 py-1">
        <span className="text-xs font-mono flex-1 min-w-0 truncate" title={item.label}>{item.label}</span>
        {ev?.contested && (
          <span
            className="text-[10px] px-1 rounded border border-orange-400 bg-orange-100 text-orange-900 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-300 font-mono shrink-0"
            title={
              `Sources split on this asset: our model ${ev.value.toLocaleString()}` +
              (ev.market_value != null ? ` · market ${ev.market_value.toLocaleString()}` : '') +
              (ev.consensus_value != null ? ` · experts ${ev.consensus_value.toLocaleString()}` : '') +
              ` — see 'makes sense if' below.`
            }
          >
            split
          </span>
        )}
        <span className="text-xs font-mono text-muted-foreground shrink-0">{kv(item.value)}</span>
        {shown != null && shown !== item.value && (
          <span
            className={cn('text-xs font-mono font-semibold shrink-0', shown > item.value ? 'text-green-400' : 'text-yellow-500')}
            title={ev?.note ?? "Value through the counterparty's eyes"}
          >
            →{kv(shown)}
          </span>
        )}
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-red-400 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity"
        >
          ×
        </button>
      </div>
      {ev?.note && (
        <p className="text-[10px] text-muted-foreground leading-snug pb-1 pl-0.5">{ev.note}</p>
      )}
    </div>
  )
}

function DealSideSection({
  title, totalLine, items, evalSide, onRemove, addOptions, onAdd, emptyHint,
}: {
  title: string
  totalLine: string | null
  items: DealItem[]
  evalSide?: { label: string; ref: AssetRef; value: number; perceived_value?: number; adjusted_value?: number; market_value?: number | null; consensus_value?: number | null; contested?: boolean; note: string | null }[]
  onRemove: (i: number) => void
  addOptions: DealItem[]
  onAdd: (item: DealItem) => void
  emptyHint: string
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [filter, setFilter] = useState('')
  const inDeal = new Set(items.map(i => refKey(i.ref)))
  const options = addOptions
    .filter(o => o.ref.type === 'pick' || !inDeal.has(refKey(o.ref)))
    .filter(o => !filter || o.label.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide">{title}</p>
        <button
          onClick={() => { setShowAdd(s => !s); setFilter('') }}
          className="text-xs text-primary hover:underline"
        >
          {showAdd ? '− done' : '+ add'}
        </button>
      </div>
      <div className="rounded-lg border border-border/70 bg-background/40 px-2 py-1">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-1.5">{emptyHint}</p>
        ) : (
          <>
            {items.map((item, i) => (
              <DealRow
                key={`${refKey(item.ref)}-${i}`}
                item={item}
                ev={evalSide?.find(e => refKey(e.ref) === refKey(item.ref))}
                onRemove={() => onRemove(i)}
              />
            ))}
            {totalLine && (
              <div className="flex items-center justify-between border-t border-border/60 mt-0.5 pt-1 pb-0.5">
                <span className="text-xs text-muted-foreground">total</span>
                <span className="text-xs font-mono font-semibold">{totalLine}</span>
              </div>
            )}
          </>
        )}
      </div>
      {showAdd && (
        <div className="space-y-1">
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter…"
            className="w-full text-xs px-2 py-1 rounded border border-border bg-background outline-none focus:border-ring"
          />
          <div className="max-h-40 overflow-y-auto rounded border border-border/50 divide-y divide-border/40">
            {options.map((o, i) => (
              <button
                key={`${refKey(o.ref)}-${i}`}
                onClick={() => onAdd(o)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1 text-left hover:bg-muted/50"
              >
                <span className="text-xs font-mono truncate">{o.label}</span>
                <span className="text-xs font-mono text-muted-foreground shrink-0">{kv(o.value)}</span>
              </button>
            ))}
            {options.length === 0 && (
              <p className="text-xs text-muted-foreground italic px-2 py-1.5">nothing to add</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function assetsToDealItems(assets: MyAssetsResponse | null): DealItem[] {
  if (!assets) return []
  const players: DealItem[] = assets.players
    .filter(p => p.value > 0)
    .map(p => ({
      label: `${p.name}${p.position ? ` (${p.position})` : ''}`,
      value: p.value,
      ref: { type: 'player' as const, player_id: p.player_id },
    }))
  const picks: DealItem[] = assets.picks.map(p => ({
    label: p.label,
    value: p.value,
    ref: { type: 'pick' as const, season: p.season, round: p.round },
  }))
  return [...players, ...picks].sort((a, b) => b.value - a.value)
}

function DealBuilder({
  leagueId, counterparty, mySide, theirSide, myOptions, theirOptions,
  onAddMine, onAddTheirs, onRemoveMine, onRemoveTheirs, onClear,
}: {
  leagueId: string
  counterparty: { user_id: string; name: string }
  mySide: DealItem[]
  theirSide: DealItem[]
  myOptions: DealItem[]
  theirOptions: DealItem[]
  onAddMine: (i: DealItem) => void
  onAddTheirs: (i: DealItem) => void
  onRemoveMine: (i: number) => void
  onRemoveTheirs: (i: number) => void
  onClear: () => void
}) {
  const [evaluation, setEvaluation] = useState<DealEvaluation | null>(null)

  useEffect(() => {
    if (mySide.length === 0 && theirSide.length === 0) { setEvaluation(null); return }
    let cancelled = false
    api.evaluateDeal(leagueId, {
      counterparty_user_id: counterparty.user_id,
      my_assets: mySide.map(i => i.ref),
      their_assets: theirSide.map(i => i.ref),
    })
      .then(d => { if (!cancelled) setEvaluation(d) })
      .catch(console.error)
    return () => { cancelled = true }
  }, [leagueId, counterparty.user_id, mySide, theirSide])

  const t = evaluation?.totals
  return (
    <aside
      className={cn(
        // Desktop: full-height right panel. Mobile: bottom sheet.
        'fixed z-40 border-border bg-background/95 backdrop-blur flex flex-col',
        'lg:inset-y-0 lg:right-0 lg:w-[380px] lg:border-l',
        'max-lg:inset-x-0 max-lg:bottom-0 max-lg:max-h-[65vh] max-lg:border-t'
      )}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/70 space-y-2 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold truncate">
            Deal with {counterparty.name}
            {evaluation?.counterparty.posture && (
              <span className={cn('text-xs font-medium ml-2', POSTURE_COLORS[evaluation.counterparty.posture])}>
                {POSTURE_LABELS[evaluation.counterparty.posture]}
              </span>
            )}
          </p>
          <button onClick={onClear} className="text-xs text-muted-foreground hover:text-red-400 shrink-0">
            ✕ clear
          </button>
        </div>
        {evaluation?.verdict ? (
          <div className={cn('text-xs px-2.5 py-1.5 rounded-md border font-medium leading-snug', VERDICT_STYLES[evaluation.verdict.label])}>
            {evaluation.verdict.text}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            Add assets to both sides to get a verdict.
          </p>
        )}
        <AcceptanceMeter ratio={evaluation?.ratio ?? null} />
        <ValueLensMeter
          ours={evaluation?.raw_ratio ?? null}
          market={evaluation?.market_ratio}
          experts={evaluation?.consensus_ratio}
        />
        {evaluation?.market_verdict && (
          <p className="text-xs text-muted-foreground leading-snug" title="FantasyCalc — values derived from real completed trades across thousands of leagues, normalized to our scale.">
            {evaluation.market_verdict.text}
          </p>
        )}
        {evaluation?.consensus_verdict && (
          <p className="text-xs text-muted-foreground leading-snug" title="DynastyProcess — FantasyPros expert consensus rankings converted to values, normalized to our scale.">
            {evaluation.consensus_verdict.text}
          </p>
        )}
      </div>

      {/* Sides */}
      <div className="px-4 py-3 space-y-4 overflow-y-auto flex-1">
        <DealSideSection
          title="You send"
          totalLine={t ? `${kv(t.my_raw)}${t.my_perceived !== t.my_raw ? ` (worth ${kv(t.my_perceived)} to them)` : ''}` : null}
          items={mySide}
          evalSide={evaluation?.my_side}
          onRemove={onRemoveMine}
          addOptions={myOptions}
          onAdd={onAddMine}
          emptyHint="Click your war-chest assets, or + add"
        />
        <DealSideSection
          title={`You get from ${counterparty.name}`}
          totalLine={t ? `${kv(t.their_raw)}${t.their_adjusted !== t.their_raw ? ` (their price ${kv(t.their_adjusted)})` : ''}` : null}
          items={theirSide}
          evalSide={evaluation?.their_side}
          onRemove={onRemoveTheirs}
          addOptions={theirOptions}
          onAdd={onAddTheirs}
          emptyHint="Click a player on their card, or + add"
        />

        {evaluation && (evaluation.beliefs?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-orange-300/60 bg-orange-50/60 dark:border-orange-900/60 dark:bg-orange-950/20 px-2.5 py-2 space-y-1.5">
            <p className="text-xs font-semibold text-orange-800 dark:text-orange-300">
              Makes sense if you think…
            </p>
            {evaluation.beliefs!.map((b, i) => (
              <p key={i} className="text-xs text-muted-foreground leading-relaxed">{b}</p>
            ))}
          </div>
        )}

        {evaluation && evaluation.notes.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 space-y-1">
            {evaluation.notes.map((n, i) => (
              <p key={i} className="text-xs text-muted-foreground leading-relaxed">{n}</p>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

type SelectedSellAsset =
  | { type: 'player'; playerId: string; label: string }
  | { type: 'pick'; season: number; round: number; label: string }

export default function TradeHub() {
  const [searchParams, setSearchParams] = useSearchParams()
  const mode = (searchParams.get('mode') === 'sell' ? 'sell' : 'acquire') as 'acquire' | 'sell'

  const [leagues, setLeagues] = useState<LeagueSummaryForDashboard[]>([])
  const [allNeeds, setAllNeeds] = useState<Record<string, PositionalNeeds>>({})
  const [leagueId, setLeagueId] = useState<string>('')

  // Acquire mode state
  const [position, setPosition] = useState<string>('WR')
  const [acquireData, setAcquireData] = useState<AcquireResponse | null>(null)
  const [acquireLoading, setAcquireLoading] = useState(false)

  // Sell mode state
  const [myAssets, setMyAssets] = useState<MyAssetsResponse | null>(null)
  const [sellSelected, setSellSelected] = useState<SelectedSellAsset | null>(null)
  const [sellReport, setSellReport] = useState<SellResponse | null>(null)
  const [sellLoading, setSellLoading] = useState(false)

  // Deal builder state
  const [counterparty, setCounterparty] = useState<{ user_id: string; name: string } | null>(null)
  const [mySide, setMySide] = useState<DealItem[]>([])
  const [theirSide, setTheirSide] = useState<DealItem[]>([])
  const [counterpartyAssets, setCounterpartyAssets] = useState<MyAssetsResponse | null>(null)

  const setMode = (m: 'acquire' | 'sell') => setSearchParams(m === 'acquire' ? {} : { mode: m }, { replace: true })

  useEffect(() => {
    api.getDashboard().then(d => {
      setLeagues(d.leagues)
      if (d.leagues.length > 0) setLeagueId(prev => prev || d.leagues[0].league_id)
      d.leagues.forEach(l => {
        api.getRosterNeeds(l.league_id)
          .then(n => setAllNeeds(prev => ({ ...prev, [l.league_id]: n })))
          .catch(console.error)
      })
    }).catch(console.error)
  }, [])

  // My assets — needed for the sell picker AND the builder's add row
  useEffect(() => {
    if (!leagueId) return
    setMyAssets(null)
    api.getMyAssets(leagueId).then(setMyAssets).catch(console.error)
  }, [leagueId])

  // Acquire report
  useEffect(() => {
    if (!leagueId || mode !== 'acquire') return
    setAcquireLoading(true)
    api.getAcquire(leagueId, position)
      .then(setAcquireData)
      .catch(console.error)
      .finally(() => setAcquireLoading(false))
  }, [leagueId, position, mode])

  // Sell report
  useEffect(() => {
    if (!leagueId || mode !== 'sell' || !sellSelected) { setSellReport(null); return }
    setSellLoading(true)
    const req = sellSelected.type === 'player'
      ? api.getSellPlayer(leagueId, sellSelected.playerId)
      : api.getSellPick(leagueId, sellSelected.season, sellSelected.round)
    req.then(setSellReport).catch(console.error).finally(() => setSellLoading(false))
  }, [leagueId, mode, sellSelected])

  // Counterparty assets for the builder
  useEffect(() => {
    if (!leagueId || !counterparty) { setCounterpartyAssets(null); return }
    api.getManagerAssets(leagueId, counterparty.user_id).then(setCounterpartyAssets).catch(console.error)
  }, [leagueId, counterparty])

  // Reset deal when the league changes
  useEffect(() => { setCounterparty(null); setMySide([]); setTheirSide([]); setSellSelected(null) }, [leagueId])

  const addTheirItem = (item: DealItem) =>
    setTheirSide(prev => item.ref.type === 'player' && prev.some(i => refKey(i.ref) === refKey(item.ref)) ? prev : [...prev, item])
  const addMyItem = (item: DealItem) =>
    setMySide(prev => item.ref.type === 'player' && prev.some(i => refKey(i.ref) === refKey(item.ref)) ? prev : [...prev, item])

  // ── Acquire interactions ─────────────────────────────────────────────
  const handlePickPlayer = (target: AcquireTarget, p: AcquirePlayer) => {
    const item: DealItem = {
      label: `${p.name}${acquireData ? ` (${acquireData.position})` : ''}`,
      value: p.value,
      ref: { type: 'player', player_id: p.player_id },
    }
    if (!counterparty || counterparty.user_id !== target.user_id) {
      // New counterparty — start a fresh deal seeded with this player.
      setCounterparty({ user_id: target.user_id, name: target.manager_name })
      setMySide([])
      setTheirSide([item])
    } else {
      addTheirItem(item)
    }
  }

  const handleUsePackage = (target: AcquireTarget, p: AcquirePlayer, pkg: DealPackage) => {
    setCounterparty({ user_id: target.user_id, name: target.manager_name })
    setTheirSide([{
      label: `${p.name}${acquireData ? ` (${acquireData.position})` : ''}`,
      value: p.value,
      ref: { type: 'player', player_id: p.player_id },
    }])
    setMySide(pkg.items.filter(i => i.ref).map(i => ({ label: i.label, value: i.value, ref: i.ref! })))
  }

  // ── Sell interactions ────────────────────────────────────────────────
  const sellAssetItem = (): DealItem | null => {
    if (!sellSelected) return null
    if (sellSelected.type === 'player') {
      const p = myAssets?.players.find(pl => pl.player_id === sellSelected.playerId)
      return {
        label: `${sellSelected.label}${p?.position ? ` (${p.position})` : ''}`,
        value: p?.value ?? 0,
        ref: { type: 'player', player_id: sellSelected.playerId },
      }
    }
    const pk = myAssets?.picks.find(p => p.season === sellSelected.season && p.round === sellSelected.round)
    return {
      label: sellSelected.label,
      value: pk?.value ?? 0,
      ref: { type: 'pick', season: sellSelected.season, round: sellSelected.round },
    }
  }

  const handleUseAsk = (buyer: SellBuyer, ask: AskPackage | null) => {
    setCounterparty({ user_id: buyer.user_id, name: buyer.manager_name })
    const mine = sellAssetItem()
    setMySide(mine ? [mine] : [])
    setTheirSide(ask ? ask.items.filter(i => i.ref).map(i => ({ label: i.label, value: i.value, ref: i.ref! })) : [])
  }

  const ctx = acquireData?.my_context
  const byPosition = (pos: string): AcquirePlayer[] => (myAssets?.players ?? []).filter(p => p.position === pos)

  return (
    <div className={cn('space-y-4', counterparty && 'lg:pr-[396px] max-lg:pb-80')}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Trade Hub</h1>
          <p className="text-sm text-muted-foreground">
            Start from what you need or what you're shopping — then build the deal.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['acquire', 'sell'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn('px-3 py-1.5 text-xs font-semibold transition-colors',
                  m === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {m === 'acquire' ? 'I need a…' : "I'm shopping…"}
              </button>
            ))}
          </div>
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
                <SelectItem key={l.league_id} value={l.league_id} className="text-xs">{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mode === 'acquire' && (
            <div className="flex rounded-lg border border-border overflow-hidden">
              {POSITIONS.map(p => (
                <button
                  key={p}
                  onClick={() => setPosition(p)}
                  className={cn('px-3 py-1.5 text-xs font-mono font-semibold transition-colors',
                    p === position ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <NeedsOverview
        leagues={leagues}
        allNeeds={allNeeds}
        activeLeagueId={leagueId}
        activePosition={mode === 'acquire' ? position : null}
        onSelect={(lid, pos) => { setLeagueId(lid); setPosition(pos); setMode('acquire') }}
      />

      {/* ── Acquire mode ── */}
      {mode === 'acquire' && (
        <>
          {ctx && !acquireLoading && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Your war chest</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-4 flex-wrap text-xs">
                  <span>
                    Your {acquireData!.position}:{' '}
                    <span className={cn('font-mono font-semibold', ctx.my_value < ctx.league_avg ? 'text-red-400' : 'text-green-400')}>
                      {kv(ctx.my_value)}
                    </span>{' '}
                    <span className="text-muted-foreground">vs {kv(ctx.league_avg)} league avg</span>
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
                    <button
                      key={`${p.label}-${i}`}
                      onClick={() => counterparty && addMyItem({ label: p.label, value: p.value, ref: { type: 'pick', season: p.season, round: p.round } })}
                      title={counterparty ? 'Click to add to your side of the deal' : 'Pick a target player first, then click to add'}
                      className={cn('text-xs px-1.5 py-0.5 rounded border border-purple-300 bg-purple-100 text-purple-900 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300 font-mono',
                        counterparty && 'hover:ring-2 hover:ring-ring/40')}
                    >
                      {p.label} · {kv(p.value)}
                    </button>
                  ))}
                  {ctx.pick_inventory.length === 0 && (
                    <span className="text-xs text-muted-foreground italic">no future picks — you'd be paying with players</span>
                  )}
                </div>
                {ctx.offerable_players.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground mr-1">Players you could move:</span>
                    {ctx.offerable_players.slice(0, 6).map(p => (
                      <button
                        key={p.player_id}
                        onClick={() => counterparty && addMyItem({ label: `${p.name} (${p.position})`, value: p.value, ref: { type: 'player', player_id: p.player_id } })}
                        title={counterparty ? 'Click to add to your side of the deal' : 'Pick a target player first, then click to add'}
                        className={cn('text-xs px-1.5 py-0.5 rounded border border-border font-mono text-muted-foreground',
                          counterparty && 'hover:text-foreground hover:border-ring')}
                      >
                        {p.name} ({p.position}) · {kv(p.value)}
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {acquireLoading ? (
            <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
          ) : acquireData ? (
            <div className="space-y-2">
              {acquireData.targets.map(t => (
                <AcquireTargetCard
                  key={t.user_id}
                  target={t}
                  leagueId={acquireData.league_id}
                  onPickPlayer={handlePickPlayer}
                  onUsePackage={handleUsePackage}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">Pick a league to get started.</p>
          )}
        </>
      )}

      {/* ── Sell mode ── */}
      {mode === 'sell' && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">What are you selling?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!myAssets ? (
                <Skeleton className="h-20 w-full rounded" />
              ) : (
                <>
                  {POSITIONS.map(pos => {
                    const players = byPosition(pos)
                    if (players.length === 0) return null
                    return (
                      <div key={pos} className="flex items-start gap-2">
                        <span className="text-xs font-mono font-semibold text-muted-foreground w-7 pt-1.5">{pos}</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {players.map(p => (
                            <AssetChip
                              key={p.player_id}
                              label={p.name}
                              sub={`${kv(p.value)}${p.age != null ? ` · ${Math.floor(p.age)}y` : ''}`}
                              selected={sellSelected?.type === 'player' && sellSelected.playerId === p.player_id}
                              onClick={() => setSellSelected({ type: 'player', playerId: p.player_id, label: p.name })}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {myAssets.picks.length > 0 && (
                    <div className="flex items-start gap-2">
                      <span className="text-xs font-mono font-semibold text-muted-foreground w-7 pt-1.5">PKS</span>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {myAssets.picks.map((p, i) => (
                          <AssetChip
                            key={`${p.label}-${i}`}
                            label={p.label}
                            sub={kv(p.value)}
                            selected={sellSelected?.type === 'pick' && sellSelected.season === p.season && sellSelected.round === p.round}
                            onClick={() => setSellSelected({ type: 'pick', season: p.season, round: p.round, label: p.label })}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {sellSelected == null ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Select an asset above to see who's buying.</p>
          ) : sellLoading ? (
            <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
          ) : sellReport ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-sm font-semibold">
                  Buyers for {sellReport.asset.name}
                  <span className="text-muted-foreground font-normal">
                    {' '}· {kv(sellReport.asset.value)} sticker
                    {sellReport.asset.age != null && ` · ${Math.floor(sellReport.asset.age)}y`}
                  </span>
                </h2>
                {sellReport.my_need_positions.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    (asks favor your needs: {sellReport.my_need_positions.join(', ')})
                  </span>
                )}
              </div>
              {sellReport.buyers.map(b => (
                <BuyerCard key={b.user_id} buyer={b} leagueId={sellReport.league_id} onUseAsk={handleUseAsk} />
              ))}
            </div>
          ) : null}
        </>
      )}

      {/* ── Deal builder ── */}
      {counterparty && (
        <DealBuilder
          leagueId={leagueId}
          counterparty={counterparty}
          mySide={mySide}
          theirSide={theirSide}
          myOptions={assetsToDealItems(myAssets)}
          theirOptions={assetsToDealItems(counterpartyAssets)}
          onAddMine={addMyItem}
          onAddTheirs={addTheirItem}
          onRemoveMine={i => setMySide(prev => prev.filter((_, idx) => idx !== i))}
          onRemoveTheirs={i => setTheirSide(prev => prev.filter((_, idx) => idx !== i))}
          onClear={() => { setCounterparty(null); setMySide([]); setTheirSide([]) }}
        />
      )}
    </div>
  )
}
