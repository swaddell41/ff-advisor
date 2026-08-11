import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type TradeTarget, type TradeTargetsResponse, type PositionalNeeds } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const POSTURE_LABELS: Record<string, string> = {
  rebuild: 'Rebuilding',
  contend: 'Contending',
  middling: 'Middling',
}

const POSTURE_COLORS: Record<string, string> = {
  rebuild: 'text-blue-400 border-blue-700 bg-blue-950/30',
  contend: 'text-orange-400 border-orange-700 bg-orange-950/30',
  middling: 'text-muted-foreground border-border',
}

function OpportunityBar({ score }: { score: number }) {
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

// ── Roster needs bar ─────────────────────────────────────────────────────────
function RosterNeedsBar({ needs }: { needs: PositionalNeeds }) {
  const allSlots = ['QB', 'RB', 'WR', 'TE', 'PICKS']
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {allSlots.map(pos => {
        const d = needs.needs[pos]
        if (!d) return null
        const score = d.need_score
        const isNeed = score > 0.05
        const isSurplus = score < -0.05
        const pct = Math.min(100, Math.round(Math.abs(score) * 100))
        const barColor = isNeed ? 'bg-red-500' : isSurplus ? 'bg-green-500' : 'bg-muted-foreground'
        const textColor = isNeed ? 'text-red-400' : isSurplus ? 'text-green-400' : 'text-muted-foreground'

        const isPicks = pos === 'PICKS'
        const tooltip = isPicks
          ? `Draft capital: net pick value ${d.net_pick_value != null ? (d.net_pick_value > 0 ? '+' : '') + d.net_pick_value.toLocaleString() : '?'}, future picks ${d.net_future_picks != null ? (d.net_future_picks > 0 ? '+' : '') + d.net_future_picks : '?'}`
          : `${pos}: you ${Math.round(d.my_value / 1000)}k vs avg ${Math.round(d.league_avg / 1000)}k`

        return (
          <div key={pos} className="flex items-center gap-1.5" title={tooltip}>
            <span className={cn('text-xs font-semibold font-mono', isPicks ? 'w-8' : 'w-5', textColor)}>
              {isPicks ? 'PKS' : pos}
            </span>
            <div className={cn('h-1.5 rounded-full bg-muted overflow-hidden', isPicks ? 'w-14' : 'w-12')}>
              <div
                className={cn('h-full rounded-full transition-all', barColor)}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={cn('text-xs font-mono', textColor)}>
              {isNeed ? '▼' : isSurplus ? '▲' : '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Position fit chips ────────────────────────────────────────────────────────
function PositionFitChips({ fills, wants }: { fills: string[]; wants: string[] }) {
  if (fills.length === 0 && wants.length === 0) return null

  const chipLabel = (pos: string, dir: 'fill' | 'want') => {
    if (pos === 'PICKS') return dir === 'fill' ? '🎯 has draft capital' : '📦 wants picks'
    return dir === 'fill' ? `${pos} source` : `${pos} buyer`
  }
  const chipClass = (pos: string, dir: 'fill' | 'want') => {
    if (pos === 'PICKS') return dir === 'fill'
      ? 'border-purple-600 bg-purple-700 text-white'
      : 'border-blue-600 bg-blue-700 text-white'
    return dir === 'fill'
      ? 'border-red-600 bg-red-700 text-white'
      : 'border-green-600 bg-green-700 text-white'
  }
  const chipTitle = (pos: string, dir: 'fill' | 'want') => {
    if (pos === 'PICKS') return dir === 'fill'
      ? 'They have surplus draft capital — may trade players for picks'
      : 'They need draft capital — may trade players to you for picks'
    return dir === 'fill'
      ? `They have ${pos} surplus — could fill your need`
      : `They overpay for ${pos} — sell your surplus to them`
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
      {fills.map(pos => (
        <span
          key={`fill-${pos}`}
          className={cn('text-xs px-1.5 py-0.5 rounded border font-mono', chipClass(pos, 'fill'))}
          title={chipTitle(pos, 'fill')}
        >
          {chipLabel(pos, 'fill')}
        </span>
      ))}
      {wants.map(pos => (
        <span
          key={`want-${pos}`}
          className={cn('text-xs px-1.5 py-0.5 rounded border font-mono', chipClass(pos, 'want'))}
          title={chipTitle(pos, 'want')}
        >
          {chipLabel(pos, 'want')}
        </span>
      ))}
    </div>
  )
}

function TargetCard({
  target,
  leagueId,
  onPostureChange,
}: {
  target: TradeTarget
  leagueId: string
  onPostureChange: (userId: string, posture: string) => Promise<void>
}) {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const diff = target.avg_decision_differential
  const diffColor = diff == null ? 'text-muted-foreground' : diff >= 0.03 ? 'text-green-400' : diff <= -0.03 ? 'text-red-400' : 'text-yellow-400'
  const diffStr = diff != null ? `${diff >= 0 ? '+' : ''}${Math.round(diff * 100)}%` : '—'

  const handlePostureChange = async (value: string) => {
    setSaving(true)
    try { await onPostureChange(target.user_id, value) }
    finally { setSaving(false) }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Clickable name → profile */}
            <button
              onClick={() => navigate(`/leagues/${leagueId}/managers/${target.user_id}`)}
              className="font-medium text-sm hover:text-primary transition-colors cursor-pointer"
            >
              {target.manager_name}
            </button>
            <span className={cn('text-xs font-mono font-semibold', diffColor)}>
              {diffStr} avg
            </span>
            {target.pick_capital_score != null && Math.abs(target.pick_capital_score) > 0.08 && (
              <span
                className={cn(
                  'text-xs px-1.5 py-0.5 rounded font-mono text-white',
                  target.pick_capital_score > 0 ? 'bg-purple-700' : 'bg-blue-700'
                )}
                title={`Draft capital: ${target.pick_capital_score > 0 ? 'surplus picks' : 'needs picks'}`}
              >
                {target.pick_capital_score > 0 ? '↑ picks' : '↓ picks'}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {target.total_trades} trades
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{target.actionable_summary}</p>
          <PositionFitChips fills={target.fills_my_need ?? []} wants={target.wants_my_surplus ?? []} />
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div>
            <p className="text-xs text-muted-foreground text-right mb-0.5">Opportunity</p>
            <OpportunityBar score={target.opportunity_score} />
          </div>
        </div>
      </div>

      {/* Posture row — separate from the clickable area */}
      <div className="flex items-center gap-2 pt-1 border-t border-border/50">
        <span className="text-xs text-muted-foreground">Their posture:</span>
        <Select
          value={target.their_posture}
          onValueChange={v => { if (v) void handlePostureChange(v) }}
          disabled={saving}
        >
          <SelectTrigger className="h-6 text-xs w-28 border-0 bg-transparent p-0 shadow-none focus:ring-0 hover:text-foreground">
            <span className={cn(
              'text-xs font-medium',
              POSTURE_COLORS[target.their_posture]?.split(' ')[0] ?? 'text-muted-foreground'
            )}>
              {POSTURE_LABELS[target.their_posture] ?? target.their_posture}
              {target.posture_is_override && ' ✎'}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto" className="text-xs">Auto-detect</SelectItem>
            <SelectItem value="rebuild" className="text-xs">Rebuilding</SelectItem>
            <SelectItem value="middling" className="text-xs">Middling</SelectItem>
            <SelectItem value="contend" className="text-xs">Contending</SelectItem>
          </SelectContent>
        </Select>
        {target.posture_is_override && (
          <span className="text-xs text-muted-foreground italic">overridden</span>
        )}
      </div>
    </div>
  )
}

interface TradeTargetsProps {
  leagueId: string
  leagueName: string
  initialPosture?: string
}

export function TradeTargets({ leagueId, leagueName, initialPosture }: TradeTargetsProps) {
  const [data, setData] = useState<TradeTargetsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [myPosture, setMyPosture] = useState<string>(initialPosture ?? 'middling')
  const [saving, setSaving] = useState(false)

  const load = (leagueId: string) => {
    setLoading(true)
    api.getTradeTargets(leagueId)
      .then(d => { setData(d); setMyPosture(d.my_posture) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(leagueId) }, [leagueId])

  const handleMyPostureChange = async (value: string) => {
    setSaving(true)
    try {
      const result = await api.setMyPosture(leagueId, value)
      setMyPosture(result.posture)
      load(leagueId)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  const handleTargetPostureChange = async (targetUserId: string, posture: string) => {
    await api.setManagerPosture(leagueId, targetUserId, posture)
    load(leagueId)
  }

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <CardTitle className="text-sm font-semibold">{leagueName}</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">My posture:</span>
            <Select value={myPosture} onValueChange={v => { if (v) void handleMyPostureChange(v) }} disabled={saving}>
              <SelectTrigger className="h-7 text-xs w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect</SelectItem>
                <SelectItem value="rebuild">Rebuilding</SelectItem>
                <SelectItem value="middling">Middling</SelectItem>
                <SelectItem value="contend">Contending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Roster needs bar */}
        {data?.positional_needs && !loading && (
          <div className="pt-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">My positional needs:</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="text-red-400">▼ need</span>
                <span className="text-green-400">▲ surplus</span>
              </div>
            </div>
            <RosterNeedsBar needs={data.positional_needs} />
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : !data || data.targets.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No trade targets found.</p>
        ) : (
          data.targets.slice(0, 5).map(t => (
            <TargetCard
              key={t.user_id}
              target={t}
              leagueId={leagueId}
              onPostureChange={handleTargetPostureChange}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}
