import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Per-user saved leagues (server-side, so they follow the account across
 * devices). Chips render on every redraft-hub page; clicking one hands the
 * league to the page, the × unsaves it.
 */

export interface SavedLeague {
  platform: 'sleeper' | 'espn'
  league_id: string
  season: number
  name: string
  team_id: string
}

export function useSavedLeagues() {
  const [leagues, setLeagues] = useState<SavedLeague[]>([])
  const refresh = async () => {
    try {
      const r = await fetch('/api/me/saved-leagues')
      if (r.ok) setLeagues(await r.json())
    } catch { /* signed out */ }
  }
  useEffect(() => { refresh() }, [])
  const save = async (l: SavedLeague) => {
    await fetch('/api/me/saved-leagues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(l),
    })
    refresh()
  }
  const remove = async (platform: string, league_id: string) => {
    await fetch(`/api/me/saved-leagues?platform=${platform}&league_id=${encodeURIComponent(league_id)}`, { method: 'DELETE' })
    refresh()
  }
  return { leagues, save, remove, refresh }
}

export function SavedLeagueChips({
  leagues, active, onPick, onRemove,
}: {
  leagues: SavedLeague[]
  active?: { platform: string; league_id: string } | null
  onPick: (l: SavedLeague) => void
  onRemove: (platform: string, league_id: string) => void
}) {
  if (!leagues.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {leagues.map((l) => {
        const isActive = active && active.platform === l.platform && active.league_id === l.league_id
        return (
          <span
            key={`${l.platform}:${l.league_id}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs cursor-pointer',
              isActive ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground'
            )}
          >
            <button onClick={() => onPick(l)}>{l.name || l.league_id}
              <span className="ml-1 opacity-60 uppercase text-[9px]">{l.platform}</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(l.platform, l.league_id) }}
              className="opacity-50 hover:opacity-100"
              title="Remove saved league"
            >
              ×
            </button>
          </span>
        )
      })}
    </div>
  )
}
