import { useEffect, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, type TradesResponse, type Trade } from '@/lib/api'
import { GradeBadge } from '@/components/GradeBadge'
import { AssetList } from '@/components/AssetList'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/gradeUtils'

export default function TradeHistory() {
  const { leagueId } = useParams<{ leagueId: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<TradesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)
  const [page, setPage] = useState(1)

  const fetchTrades = useCallback(() => {
    if (!leagueId) return
    setLoading(true)
    api.getTrades(leagueId, page)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId, page])

  useEffect(() => { fetchTrades() }, [fetchTrades])

  const handleRecompute = async () => {
    if (!leagueId) return
    setRecomputing(true)
    try {
      await api.recomputeGrades({ league_id: leagueId })
      fetchTrades()
    } catch (e) {
      setError(String(e))
    } finally {
      setRecomputing(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-800 bg-red-950/30 p-6 text-red-300">
        <p className="font-medium">Error loading trades</p>
        <p className="text-sm mt-1">{error}</p>
      </div>
    )
  }

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 1

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link to="/" className="hover:text-foreground transition-colors">Leagues</Link>
            <span>/</span>
            <span>{data?.league_name ?? '…'}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">
              {loading && !data ? 'Loading…' : data?.league_name}
            </h1>
            {data?.format_key && (
              <Badge variant="outline" className="text-xs">
                {data.format_key.replace('_', ' ').toUpperCase()}
              </Badge>
            )}
          </div>
          {data && (
            <p className="text-muted-foreground text-sm mt-0.5">
              {data.total} trade{data.total !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/leagues/${leagueId}/managers`)}
          >
            Manager Profiles →
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRecompute}
            disabled={recomputing}
          >
            {recomputing ? 'Recomputing…' : 'Recompute Grades'}
          </Button>
        </div>
      </div>

      {/* Trade table */}
      {loading && !data ? (
        <div className="space-y-2">
          {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
      ) : (
        <div className="space-y-2">
          {data?.trades.map(trade => (
            <TradeRow key={trade.trade_id} trade={trade} onClick={() => navigate(`/trades/${trade.trade_id}`)} />
          ))}
          {data?.trades.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              No trades found for this league.
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function TradeRow({ trade, onClick }: { trade: Trade; onClick: () => void }) {
  const [sideA, sideB] = trade.sides

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl border border-border bg-card hover:bg-muted/30 hover:border-muted-foreground/40 transition-all p-4 cursor-pointer"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-muted-foreground font-mono">
          {formatDate(trade.executed_at)}
        </span>
        <span className="text-xs text-muted-foreground">
          Season {trade.season} · Wk {trade.week}
        </span>
      </div>

      {/* Two-column layout — one per side */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
        {/* Side A */}
        <TradeSideCell side={sideA} />

        {/* VS divider */}
        <div className="flex items-center justify-center pt-1">
          <span className="text-xs text-muted-foreground font-mono px-1">↔</span>
        </div>

        {/* Side B */}
        <TradeSideCell side={sideB} />
      </div>
    </button>
  )
}

function TradeSideCell({ side }: { side: Trade['sides'][0] | undefined }) {
  if (!side) return <div />

  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium truncate">{side.manager_name}</span>
        <div className="flex items-center gap-1 shrink-0">
          <GradeBadge grade={side.decision_grade} />
          <span className="text-xs text-muted-foreground">/</span>
          <GradeBadge grade={side.outcome_grade} />
        </div>
      </div>
      <div className="text-xs text-muted-foreground">received:</div>
      <AssetList assets={side.assets_received} />
    </div>
  )
}
