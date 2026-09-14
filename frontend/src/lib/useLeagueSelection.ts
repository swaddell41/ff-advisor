import { useEffect, useRef, useState } from 'react'
import { useSavedLeagues, type SavedLeague } from '@/components/SavedLeagues'
import { errMsg } from '@/lib/utils'

/**
 * The league-selection flow every redraft-hub page shares: platform +
 * league id (+ ESPN team), a ?platform=&league=&team= deep link that wins
 * over the last-used league in localStorage, the one-time ESPN team picker,
 * the fetch itself, and the write-back to the account's saved leagues.
 */
export const SEASON = 2026

type Platform = 'sleeper' | 'espn'
interface Options<T> {
  storeKey: string
  /** Build the API URL; `tid` is the ESPN team id ('' for Sleeper). */
  url: (platform: Platform, leagueId: string, tid: string, extra?: string) => string
  /** League display name from a successful response (for the saved chip). */
  leagueName: (data: T) => string
  /** ESPN pages need a team; Redraft evaluates the whole league. */
  needsTeam?: boolean
}

export function useLeagueSelection<T>(opts: Options<T>) {
  const { storeKey, url, leagueName, needsTeam = true } = opts
  const savedRef = useRef<{ platform?: Platform; leagueId?: string; teamId?: string } | null>(null)
  if (savedRef.current === null) {
    const qp = new URLSearchParams(window.location.search)
    if (qp.get('league')) {
      savedRef.current = { platform: (qp.get('platform') as Platform) || 'sleeper', leagueId: qp.get('league') || '', teamId: qp.get('team') || '' }
    } else {
      try { savedRef.current = JSON.parse(localStorage.getItem(storeKey) || '{}') } catch { savedRef.current = {} }
    }
  }
  const saved = savedRef.current!
  const { leagues, save, remove } = useSavedLeagues()
  const [platform, setPlatform] = useState<Platform>(saved.platform || 'sleeper')
  const [leagueId, setLeagueId] = useState<string>(saved.leagueId || '')
  const [teamId, setTeamId] = useState<string>(saved.teamId || '')
  const [teams, setTeams] = useState<{ id: number; name: string }[] | null>(null)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const persist = (pf: Platform, id: string, tid: string) => {
    try { localStorage.setItem(storeKey, JSON.stringify({ platform: pf, leagueId: id, teamId: tid })) } catch { /* private mode */ }
  }

  const run = async (pf: Platform = platform, id: string = leagueId, tid: string = teamId, extra?: string) => {
    if (!id.trim()) return
    setBusy(true); setError(null); setTeams(null)
    try {
      if (pf === 'espn' && needsTeam && !tid) {
        // One-time team pick: the draft proxy already returns the team list.
        const lr = await fetch(`/api/espn/draft/${encodeURIComponent(id.trim())}?season=${SEASON}`)
        const lj = await lr.json()
        if (!lr.ok) throw new Error(lj.detail || `HTTP ${lr.status}`)
        setTeams(lj.teams || [])
        return
      }
      const r = await fetch(url(pf, id.trim(), tid, extra))
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setData(j as T)
      persist(pf, id.trim(), tid)
      save({ platform: pf, league_id: id.trim(), season: SEASON, name: leagueName(j as T) || '', team_id: tid })
    } catch (e: unknown) {
      setError(errMsg(e)); setData(null)
    } finally { setBusy(false) }
  }

  // Auto-run the remembered / deep-linked league once on mount.
  useEffect(() => { if (saved.leagueId) run(saved.platform || 'sleeper', saved.leagueId, saved.teamId || '') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pickSavedLeague = (l: SavedLeague, extra?: string) => {
    setPlatform(l.platform); setLeagueId(l.league_id); setTeamId(l.team_id || '')
    run(l.platform, l.league_id, l.team_id || '', extra)
  }
  const pickTeam = (id: number) => { setTeamId(String(id)); run(platform, leagueId, String(id)) }

  return { platform, setPlatform, leagueId, setLeagueId, teamId, setTeamId, teams, data, error, busy, run, pickSavedLeague, pickTeam, leagues, remove, setData }
}
