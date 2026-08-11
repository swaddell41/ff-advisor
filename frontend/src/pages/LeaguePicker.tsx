import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type League } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'

export default function LeaguePicker() {
  const [leagues, setLeagues] = useState<League[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.getLeagues()
      .then(d => setLeagues(d.leagues))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Your Leagues</h1>
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-800 bg-red-950/30 p-6 text-red-300">
        <p className="font-medium">Failed to load leagues</p>
        <p className="text-sm mt-1 text-red-400">{error}</p>
        <p className="text-sm mt-2 text-muted-foreground">Make sure the backend is running: <code className="text-xs bg-muted px-1 py-0.5 rounded">make backend</code></p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Browse Leagues</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Select a league to browse trade history, grades, and manager profiles.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {leagues.map(league => (
          <Card key={league.name} className="bg-card">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base leading-snug">{league.name}</CardTitle>
                <Badge variant="outline" className="text-xs shrink-0">
                  {league.format_key.replace('_', ' ').toUpperCase()}
                </Badge>
              </div>
              <CardDescription>
                {league.seasons.length} season{league.seasons.length !== 1 ? 's' : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* League-level entry points */}
              {(() => {
                const sorted = [...league.seasons].sort((a, b) => b.season - a.season)
                const latestId = sorted[0]?.league_id
                return (
                  <div className="flex gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      className="flex-1"
                      onClick={() => navigate(`/leagues/${latestId}/managers`)}
                    >
                      Manager Profiles
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => navigate(`/leagues/${latestId}/trades`)}
                    >
                      Trade History
                    </Button>
                  </div>
                )
              })()}

              <Separator />

              {/* Per-season trade history */}
              <div>
                <p className="text-xs text-muted-foreground mb-2">Browse by season</p>
                <div className="flex flex-wrap gap-2">
                  {[...league.seasons].sort((a, b) => b.season - a.season).map(s => (
                    <button
                      key={s.league_id}
                      onClick={() => navigate(`/leagues/${s.league_id}/trades`)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm hover:border-primary hover:text-primary transition-colors cursor-pointer"
                    >
                      <span className="font-medium">{s.season}</span>
                      <span className="text-muted-foreground text-xs">{s.trade_count} trades</span>
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
