import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, type Trade, type GradeResult, type AssetItem } from '@/lib/api'
import { GradeBadge } from '@/components/GradeBadge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { formatDate, formatValue, formatDifferential } from '@/lib/gradeUtils'

const POSITION_COLORS: Record<string, string> = {
  QB: 'text-red-400',
  RB: 'text-green-400',
  WR: 'text-blue-400',
  TE: 'text-yellow-400',
}

export default function TradeDetail() {
  const { tradeId } = useParams<{ tradeId: string }>()
  const [trade, setTrade] = useState<Trade | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!tradeId) return
    api.getTrade(tradeId)
      .then(setTrade)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [tradeId])

  if (error) {
    return (
      <div className="rounded-xl border border-red-800 bg-red-950/30 p-6 text-red-300">
        <p className="font-medium">Error loading trade</p>
        <p className="text-sm mt-1">{error}</p>
      </div>
    )
  }

  if (loading || !trade) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid md:grid-cols-2 gap-4">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    )
  }

  const [sideA, sideB] = trade.sides

  return (
    <div className="space-y-5">
      {/* Breadcrumb + header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link to="/" className="hover:text-foreground transition-colors">Leagues</Link>
          <span>/</span>
          <span className="text-xs font-mono truncate">{tradeId}</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold">Trade Detail</h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{formatDate(trade.executed_at)}</span>
            <span>·</span>
            <span>Season {trade.season} · Wk {trade.week}</span>
          </div>
        </div>
      </div>

      {/* Grade comparison bar */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center">
          <GradeSummary
            managerName={sideA?.manager_name}
            decision={sideA?.decision_grade}
            outcome={sideA?.outcome_grade}
            align="left"
          />
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">vs</span>
          </div>
          <GradeSummary
            managerName={sideB?.manager_name}
            decision={sideB?.decision_grade}
            outcome={sideB?.outcome_grade}
            align="right"
          />
        </div>
      </div>

      {/* Asset detail — two columns */}
      <div className="grid md:grid-cols-2 gap-4">
        {trade.sides.map(side => (
          <SideCard key={side.roster_id} side={side} />
        ))}
      </div>
    </div>
  )
}

function GradeSummary({
  managerName,
  decision,
  outcome,
  align,
}: {
  managerName?: string
  decision: GradeResult | null
  outcome: GradeResult | null
  align: 'left' | 'right'
}) {
  return (
    <div className={`space-y-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <p className="font-semibold text-base">{managerName ?? '—'}</p>
      <div className={`flex items-center gap-3 ${align === 'right' ? 'justify-end' : ''}`}>
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">Decision</p>
          <GradeBadge grade={decision} />
        </div>
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">Outcome</p>
          <GradeBadge grade={outcome} />
        </div>
      </div>
      {decision && (
        <p className="text-xs text-muted-foreground">
          Received {formatValue(decision.total_value_received)} · Gave {formatValue(decision.total_value_given)}
          <span className="ml-1">({formatDifferential(decision.differential)})</span>
        </p>
      )}
    </div>
  )
}

function SideCard({ side }: { side: Trade['sides'][0] }) {
  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{side.manager_name}</CardTitle>
        <div className="flex items-center gap-3 pt-1">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Decision</p>
            <GradeBadge grade={side.decision_grade} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Outcome</p>
            <GradeBadge grade={side.outcome_grade} />
          </div>
          {side.decision_grade?.used_value_fallback === 1 && (
            <Badge variant="outline" className="text-yellow-400 border-yellow-800 text-xs">
              ⚠ Historical values unavailable
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <AssetSection
          label="Received"
          assets={side.assets_received}
          totalValue={side.decision_grade?.total_value_received}
        />

        {side.assets_given && side.assets_given.length > 0 && (
          <>
            <Separator />
            <AssetSection
              label="Gave"
              assets={side.assets_given}
              totalValue={side.decision_grade?.total_value_given}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function AssetSection({
  label,
  assets,
  totalValue,
}: {
  label: string
  assets: AssetItem[]
  totalValue?: number
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</p>
        {totalValue != null && (
          <p className="text-xs text-muted-foreground font-mono">{formatValue(totalValue)}</p>
        )}
      </div>
      <ul className="space-y-1.5">
        {assets.map((a, i) => <AssetRow key={i} asset={a} />)}
        {assets.length === 0 && (
          <li className="text-xs text-muted-foreground italic">—</li>
        )}
      </ul>
    </div>
  )
}

function AssetRow({ asset }: { asset: AssetItem }) {
  if (asset.type === 'player') {
    return (
      <li className="flex items-center gap-2 text-sm">
        {asset.position && (
          <span className={`text-xs font-mono font-semibold w-6 ${POSITION_COLORS[asset.position] ?? 'text-muted-foreground'}`}>
            {asset.position}
          </span>
        )}
        <span className="flex-1 text-foreground">{asset.name ?? asset.player_id}</span>
      </li>
    )
  }

  if (asset.type === 'pick') {
    return (
      <li className="flex items-center gap-2 text-sm">
        <span className="text-xs font-mono font-semibold w-6 text-purple-400">PK</span>
        <span className="flex-1 text-foreground">{asset.label}</span>
      </li>
    )
  }

  return (
    <li className="text-sm text-muted-foreground">{asset.label}</li>
  )
}
