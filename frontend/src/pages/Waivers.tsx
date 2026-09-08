import { useEffect, useState } from 'react'
import { SavedLeagueChips, useSavedLeagues, type SavedLeague } from '@/components/SavedLeagues'
import { cn } from '@/lib/utils'

/**
 * Waiver watch: popular pickups on THIS league's wire, measured against the
 * weakest starter they'd displace, with an expert-rulebook FAAB bid (or a
 * priority verdict for traditional-waiver leagues).
 */

const STORE_KEY = 'ffa-waivers'
const POS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const

interface Cand {
  name: string; pos: string; team?: string; aav: number | null; season?: number | null
  espn_proj?: number; slpr_proj?: number | null; injury?: string
  pct_owned?: number | null; pct_change?: number | null; trend_rank?: number | null; trend_count?: number | null
  opp?: string; implied?: number | null; ou?: number | null
  delta_wk: number; bar: { name: string; wk: number; slot: string } | null; depth_delta: number
  tier: 'league-winner' | 'starter' | 'upside' | 'streamer' | 'pass'
  verdict: string
  faab: { bid: number; pct: number; why: string[] } | null
  priority_advice: string | null
}
interface WaiverResponse {
  league: string; week: number
  faab: { enabled: boolean; budget: number; used: number; remaining: number }
  waiver_position: number | null; season_note: string
  bars: Record<string, { name: string; wk: number } | null>
  drop: { name: string; pos: string; season: number | null } | null
  candidates: Cand[]
}

const TIER_STYLE: Record<Cand['tier'], string> = {
  'league-winner': 'border-amber-500/60 text-amber-400',
  starter: 'border-emerald-500/50 text-emerald-400',
  upside: 'border-border text-foreground',
  streamer: 'border-border text-muted-foreground',
  pass: 'border-border text-muted-foreground',
}

export default function Waivers() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
  })()
  const { leagues, save, remove } = useSavedLeagues()
  const [platform, setPlatform] = useState<'sleeper' | 'espn'>(saved.platform || 'sleeper')
  const [leagueId, setLeagueId] = useState<string>(saved.leagueId || '')
  const [teamId, setTeamId] = useState<string>(saved.teamId || '')
  const [teams, setTeams] = useState<{ id: number; name: string }[] | null>(null)
  const [data, setData] = useState<WaiverResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState<(typeof POS)[number]>('ALL')
  const [showPass, setShowPass] = useState(false)

  const persist = (patch: Record<string, string>) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ platform, leagueId, teamId, ...patch })) } catch { /* private mode */ }
  }

  const run = async (pf = platform, id = leagueId, tid = teamId) => {
    if (!id.trim()) return
    setBusy(true); setError(null); setTeams(null)
    try {
      let url = `/api/waivers?platform=${pf}&league_id=${encodeURIComponent(id.trim())}&season=2026`
      if (pf === 'espn') {
        if (!tid) {
          const lr = await fetch(`/api/espn/draft/${encodeURIComponent(id.trim())}?season=2026`)
          const lj = await lr.json()
          if (!lr.ok) throw new Error(lj.detail || `HTTP ${lr.status}`)
          setTeams(lj.teams || []); setBusy(false); return
        }
        url += `&team_id=${tid}`
      }
      const r = await fetch(url)
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setData(j)
      persist({ platform: pf, leagueId: id.trim(), teamId: tid })
      save({ platform: pf, league_id: id.trim(), season: 2026, name: j.league || '', team_id: tid })
    } catch (e: any) {
      setError(e.message || String(e)); setData(null)
    } finally { setBusy(false) }
  }

  useEffect(() => { if (saved.leagueId) run(saved.platform || 'sleeper', saved.leagueId, saved.teamId || '') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pickSavedLeague = (l: SavedLeague) => {
    setPlatform(l.platform); setLeagueId(l.league_id); setTeamId(l.team_id || '')
    run(l.platform, l.league_id, l.team_id || '')
  }

  const shown = (data?.candidates || [])
    .filter((c) => pos === 'ALL' || c.pos === pos)
    .filter((c) => showPass || c.tier !== 'pass')

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Waiver Watch</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          The most-added players on the wire in this league, measured against the weakest starter
          they'd replace on your roster — with a bid sized by the expert FAAB rulebook.
        </p>
      </div>

      <SavedLeagueChips leagues={leagues} active={{ platform, league_id: leagueId }} onPick={pickSavedLeague} onRemove={remove} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border overflow-hidden">
          {(['sleeper', 'espn'] as const).map((pf) => (
            <button key={pf} onClick={() => { setPlatform(pf); setTeamId('') }}
              className={cn('px-3 py-1.5 text-sm capitalize', platform === pf ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              {pf}
            </button>
          ))}
        </div>
        <input value={leagueId} onChange={(e) => { setLeagueId(e.target.value); setTeamId('') }}
          placeholder={`${platform === 'espn' ? 'ESPN' : 'Sleeper'} league ID`}
          className="w-56 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm" />
        <button onClick={() => run()} disabled={busy || !leagueId.trim()}
          className="rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium disabled:opacity-50">
          {busy ? '…' : 'Scan the wire'}
        </button>
      </div>

      {teams && (
        <div className="space-y-2">
          <div className="text-sm">Which team is yours?</div>
          <div className="flex flex-wrap gap-1.5">
            {teams.map((t) => (
              <button key={t.id} onClick={() => { setTeamId(String(t.id)); run(platform, leagueId, String(t.id)) }}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40">{t.name}</button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="text-sm text-red-400">{error}</div>}

      {data && (
        <>
          <div className="rounded-lg border border-border p-4 grid sm:grid-cols-3 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Budget</div>
              {data.faab.enabled ? (
                <>
                  <div className="text-lg font-semibold">${data.faab.remaining} <span className="text-sm font-normal text-muted-foreground">of ${data.faab.budget} left</span></div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden mt-1"><div className="h-full bg-primary" style={{ width: `${data.faab.budget ? (data.faab.remaining / data.faab.budget) * 100 : 0}%` }} /></div>
                </>
              ) : (
                <div className="text-lg font-semibold">Priority {data.waiver_position ? `#${data.waiver_position}` : ''}<span className="text-sm font-normal text-muted-foreground"> · no FAAB</span></div>
              )}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Week {data.week}</div>
              <div className="text-sm mt-0.5">{data.season_note}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Drop candidate</div>
              <div className="text-sm mt-0.5">{data.drop ? <>{data.drop.name} <span className="text-muted-foreground text-xs">{data.drop.pos} · {Math.round(data.drop.season ?? 0)} ROS</span></> : '—'}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {POS.map((p) => (
              <button key={p} onClick={() => setPos(p)}
                className={cn('rounded-full border px-3 py-1 text-xs', pos === p ? 'border-primary bg-primary/10 text-foreground font-medium' : 'border-border text-muted-foreground')}>{p}</button>
            ))}
            <label className="ml-auto text-xs text-muted-foreground flex items-center gap-1.5">
              <input type="checkbox" checked={showPass} onChange={(e) => setShowPass(e.target.checked)} /> show passes
            </label>
          </div>

          <div className="space-y-2">
            {shown.map((c) => (
              <div key={`${c.name}|${c.pos}`} className={cn('rounded-lg border p-3 space-y-1.5', c.tier === 'league-winner' ? 'border-amber-500/40 bg-amber-500/5' : 'border-border')}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">
                      {c.name} <span className="text-xs text-muted-foreground">{c.pos}{c.team ? ` · ${c.team}` : ''}</span>
                      {c.injury && c.injury !== 'ACTIVE' && <span className="ml-1.5 text-[10px] uppercase text-amber-400">{c.injury.replace('_', ' ')}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-2.5">
                      {c.trend_rank && <span className={cn(c.trend_rank <= 5 && 'text-amber-400')}>#{c.trend_rank} most added</span>}
                      {c.pct_owned != null && <span>{Math.round(c.pct_owned)}% rostered{c.pct_change ? ` (${c.pct_change > 0 ? '+' : ''}${c.pct_change.toFixed(1)} 7d)` : ''}</span>}
                      {c.opp && <span>{c.team} vs {c.opp}{c.implied != null ? ` · implied ${c.implied.toFixed(1)}` : ''}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {c.faab ? (
                      <div className={cn('inline-flex flex-col items-end rounded-md border px-2.5 py-1', TIER_STYLE[c.tier])}>
                        <span className="text-base font-semibold tabular-nums">{c.faab.bid > 0 ? `$${c.faab.bid}` : 'pass'}</span>
                        <span className="text-[10px] uppercase tracking-wider">{c.tier}{c.faab.bid > 0 ? ` · ${Math.round(c.faab.pct * 100)}%` : ''}</span>
                      </div>
                    ) : (
                      <div className={cn('inline-flex rounded-md border px-2.5 py-1 text-[10px] uppercase tracking-wider', TIER_STYLE[c.tier])}>{c.tier}</div>
                    )}
                  </div>
                </div>
                <div className="text-sm">{c.verdict}</div>
                <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3">
                  <span>this week <strong className="text-foreground font-medium">{(c.aav ?? 0).toFixed(1)}</strong>{c.bar ? ` vs your ${c.bar.slot} ${c.bar.name} ${c.bar.wk.toFixed(1)}` : ''}</span>
                  {c.season != null && <span>ROS {Math.round(c.season)}{c.depth_delta ? ` (${c.depth_delta > 0 ? '+' : ''}${Math.round(c.depth_delta)} vs your bench)` : ''}</span>}
                  {c.espn_proj != null && c.slpr_proj != null && <span>ESPN {c.espn_proj.toFixed(1)} · Slpr {c.slpr_proj.toFixed(1)}</span>}
                </div>
                {c.faab && c.faab.why.length > 0 && (
                  <ul className="text-xs text-muted-foreground list-disc pl-4">
                    {c.faab.why.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
                {c.priority_advice && <div className="text-xs text-muted-foreground">{c.priority_advice}</div>}
              </div>
            ))}
            {shown.length === 0 && <div className="text-sm text-muted-foreground">Nothing on the wire beats what you have{pos !== 'ALL' ? ` at ${pos}` : ''}.</div>}
          </div>

          <div className="text-xs text-muted-foreground max-w-2xl space-y-1">
            <div><span className="font-medium text-foreground">How bids are sized:</span> tiers as a share of your <em>remaining</em> budget —
              league-winner 40–60% · new starter 15–30% · upside depth 5–12% · streamer 1–4%. No claim over 30% of remaining unless
              it's a league-winner; keep about half through the first month; bids scale down after week 10 and in the playoffs.
              The tier comes from the projection gap over your own weakest starter — popularity only moves a bid within its tier.</div>
            <div>Sources: Sleeper trending adds (24h), ESPN ownership trends, ESPN + Sleeper weekly projections, ESPN season projections, Vegas implied totals.</div>
          </div>
        </>
      )}
    </div>
  )
}
