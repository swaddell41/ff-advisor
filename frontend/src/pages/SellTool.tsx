import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  api,
  type AcquirePlayer,
  type AskPackage,
  type LeagueSummaryForDashboard,
  type MyAssetsResponse,
  type PickInventoryItem,
  type SellBuyer,
  type SellResponse,
} from '@/lib/api'
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
  rebuild: 'text-blue-400',
  contend: 'text-orange-400',
  middling: 'text-muted-foreground',
}
const ASK_KIND_LABELS: Record<string, string> = {
  picks_only: 'Ask for picks',
  player: 'Ask for a player',
  player_plus_pick: 'Ask player + pick',
}

type SelectedAsset =
  | { type: 'player'; playerId: string; label: string }
  | { type: 'pick'; season: number; round: number; label: string }

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

function AssetChip({
  label,
  sub,
  selected,
  onClick,
}: {
  label: string
  sub: string
  selected: boolean
  onClick: () => void
}) {
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

function AskCard({ ask, askValue }: { ask: AskPackage; askValue: number }) {
  const fair = ask.ask_total >= askValue * 0.9
  return (
    <div className="rounded-lg border border-border/70 bg-background/50 p-2.5 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{ASK_KIND_LABELS[ask.kind] ?? ask.kind}</span>
        <span className={cn('text-xs font-mono', fair ? 'text-green-400' : 'text-yellow-400')}>
          {(ask.ask_total / 1000).toFixed(1)}k back
        </span>
      </div>
      <p className="text-xs font-mono">{ask.items.map(i => i.label).join(' + ')}</p>
    </div>
  )
}

function BuyerCard({ buyer, leagueId }: { buyer: SellBuyer; leagueId: string }) {
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
              <span
                className="text-xs font-mono font-semibold text-green-500"
                title={buyer.premium_reasons.join(' · ')}
              >
                +{Math.round(buyer.premium_pct * 100)}% premium
              </span>
            )}
            <span className="text-xs text-muted-foreground">{buyer.total_trades} trades</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{buyer.summary}</p>
          {buyer.premium_reasons.length > 0 && (
            <p className="text-xs text-green-600 dark:text-green-400 leading-relaxed">
              Ask {(buyer.ask_value / 1000).toFixed(1)}k ({buyer.premium_reasons.join('; ')})
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
            <AskCard key={i} ask={a} askValue={buyer.ask_value} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic pt-1 border-t border-border/50">
          No clean package from their assets — they'd have to get creative.
        </p>
      )}
    </div>
  )
}

export default function SellTool() {
  const [leagues, setLeagues] = useState<LeagueSummaryForDashboard[]>([])
  const [leagueId, setLeagueId] = useState<string>('')
  const [assets, setAssets] = useState<MyAssetsResponse | null>(null)
  const [selected, setSelected] = useState<SelectedAsset | null>(null)
  const [report, setReport] = useState<SellResponse | null>(null)
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [loadingReport, setLoadingReport] = useState(false)

  useEffect(() => {
    api.getDashboard().then(d => {
      setLeagues(d.leagues)
      if (d.leagues.length > 0) setLeagueId(d.leagues[0].league_id)
    }).catch(console.error)
  }, [])

  useEffect(() => {
    if (!leagueId) return
    setLoadingAssets(true)
    setSelected(null)
    setReport(null)
    api.getMyAssets(leagueId)
      .then(setAssets)
      .catch(console.error)
      .finally(() => setLoadingAssets(false))
  }, [leagueId])

  useEffect(() => {
    if (!leagueId || !selected) return
    setLoadingReport(true)
    const req =
      selected.type === 'player'
        ? api.getSellPlayer(leagueId, selected.playerId)
        : api.getSellPick(leagueId, selected.season, selected.round)
    req.then(setReport).catch(console.error).finally(() => setLoadingReport(false))
  }, [leagueId, selected])

  const byPosition = (pos: string): AcquirePlayer[] =>
    (assets?.players ?? []).filter(p => p.position === pos)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sell an asset</h1>
          <p className="text-sm text-muted-foreground">
            Pick something you hold — it finds who needs it, who'll overpay, and what to ask for.
          </p>
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
              <SelectItem key={l.league_id} value={l.league_id} className="text-xs">
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Asset picker */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">What are you selling?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadingAssets || !assets ? (
            <Skeleton className="h-20 w-full rounded" />
          ) : (
            <>
              {['QB', 'RB', 'WR', 'TE'].map(pos => {
                const players = byPosition(pos)
                if (players.length === 0) return null
                return (
                  <div key={pos} className="flex items-start gap-2">
                    <span className="text-xs font-mono font-semibold text-muted-foreground w-7 pt-1.5">
                      {pos}
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {players.map(p => (
                        <AssetChip
                          key={p.player_id}
                          label={p.name}
                          sub={`${(p.value / 1000).toFixed(1)}k${p.age != null ? ` · ${Math.floor(p.age)}y` : ''}`}
                          selected={selected?.type === 'player' && selected.playerId === p.player_id}
                          onClick={() =>
                            setSelected({ type: 'player', playerId: p.player_id, label: p.name })
                          }
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
              {assets.picks.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-xs font-mono font-semibold text-muted-foreground w-7 pt-1.5">
                    PKS
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {assets.picks.map((p: PickInventoryItem, i) => (
                      <AssetChip
                        key={`${p.label}-${i}`}
                        label={p.label}
                        sub={`${(p.value / 1000).toFixed(1)}k`}
                        selected={
                          selected?.type === 'pick' &&
                          selected.season === p.season &&
                          selected.round === p.round
                        }
                        onClick={() =>
                          setSelected({ type: 'pick', season: p.season, round: p.round, label: p.label })
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Buyers */}
      {selected == null ? (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Select an asset above to see who's buying.
        </p>
      ) : loadingReport ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        </div>
      ) : report ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-sm font-semibold">
              Buyers for {report.asset.name}
              <span className="text-muted-foreground font-normal">
                {' '}· {(report.asset.value / 1000).toFixed(1)}k sticker
                {report.asset.age != null && ` · ${Math.floor(report.asset.age)}y`}
              </span>
            </h2>
            {report.my_need_positions.length > 0 && (
              <span className="text-xs text-muted-foreground">
                (asks favor your needs: {report.my_need_positions.join(', ')})
              </span>
            )}
          </div>
          {report.buyers.map(b => (
            <BuyerCard key={b.user_id} buyer={b} leagueId={report.league_id} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
