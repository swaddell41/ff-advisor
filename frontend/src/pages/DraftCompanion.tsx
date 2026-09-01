import { useCallback, useEffect, useRef, useState } from 'react'
import { createDraftEngine, pickSlot, type DraftEngine } from '@/lib/draftEngine'
import { simulatePlan, type DraftPlan } from '@/lib/draftPlan'
import { cn } from '@/lib/utils'

/**
 * Mobile draft companion: the extension's side-panel recommendation, as a
 * phone-friendly page. Same engine file, same numbers — this page only
 * gathers the inputs and renders the audit the engine produces.
 *
 * Two platforms, two data paths:
 *  - Sleeper: public draft API, straight from the browser.
 *  - ESPN: no public draft API — our backend proxies the league-read API
 *    (mSettings + mDraftDetail, real leagues only) with the user's ESPN
 *    cookies from env. Picks map to board players via the espn_id
 *    crosswalk the draftboard already carries.
 */

const SLEEPER = 'https://api.sleeper.app/v1'
const STORE_KEY = 'ffa-draft-companion'
const POLL_MS = { sleeper: 30_000, espn: 15_000 }

type Platform = 'sleeper' | 'espn'

interface SleeperDraft {
  draft_id: string
  status: string
  type: string
  season: string
  draft_order: Record<string, number> | null
  settings: Record<string, number>
  metadata?: Record<string, string>
}

interface Snapshot {
  audit: any
  lineup: any
  onClock: boolean
  mySlot: number | null
  clockSlot: number
  draftName: string
  unmatched: number
  syncedAt: number
}

const k = (v: number) => `${(v / 1000).toFixed(1)}k`

async function getJson(url: string) {
  const r = await fetch(url)
  if (!r.ok) {
    let detail = `HTTP ${r.status}`
    try { detail = (await r.json()).detail || detail } catch { /* not json */ }
    throw new Error(detail)
  }
  return r.json()
}

export default function DraftCompanion() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
  })()
  const [platform, setPlatform] = useState<Platform>(saved.platform || 'sleeper')
  // Sleeper identity
  const [username, setUsername] = useState<string>(saved.username || '')
  const [userId, setUserId] = useState<string | null>(saved.userId || null)
  const [drafts, setDrafts] = useState<SleeperDraft[] | null>(null)
  const [draftId, setDraftId] = useState<string | null>(saved.draftId || null)
  // ESPN identity
  const [espnLeagueId, setEspnLeagueId] = useState<string>(saved.espnLeagueId || '')
  const [espnSeason, setEspnSeason] = useState<string>(saved.espnSeason || String(new Date().getFullYear()))
  const [espnTeams, setEspnTeams] = useState<{ id: number; name: string }[] | null>(null)
  const [espnTeamId, setEspnTeamId] = useState<number | null>(saved.espnTeamId ?? null)

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<DraftPlan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const engineRef = useRef<DraftEngine | null>(null)
  const metaRef = useRef<Map<string, SleeperDraft>>(new Map())
  const boardRef = useRef<Map<string, any>>(new Map())

  const persist = (patch: Record<string, any>) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        platform, username, userId, draftId, espnLeagueId, espnSeason, espnTeamId, ...patch,
      }))
    } catch { /* private mode */ }
  }

  const getBoard = async (format: string, mode: string) => {
    const key = `${format}:${mode}`
    let board = boardRef.current.get(key)
    if (!board) {
      board = await getJson(`/api/draftboard?format=${format}&mode=${mode}`)
      boardRef.current.set(key, board)
    }
    return board
  }

  const engine = () => {
    if (!engineRef.current) engineRef.current = createDraftEngine()
    return engineRef.current
  }

  // Feed assembled draft state to the engine and publish the snapshot.
  const publish = (st: Record<string, any>, draftName: string, unmatched: number) => {
    const eng = engine()
    Object.assign(eng.state, st)
    eng.computeReplacement()
    eng.recommend()
    const cur = eng.state.currentPick
    const clockSlot = pickSlot(cur, eng.state.lineup.teams, eng.state.draftType === 'snake')
    setSnap({
      audit: eng.state.audit,
      lineup: eng.state.lineup,
      onClock: eng.state.mySlot != null && clockSlot === eng.state.mySlot,
      mySlot: eng.state.mySlot,
      clockSlot,
      draftName,
      unmatched,
      syncedAt: Date.now(),
    })
  }

  // ── Sleeper path ─────────────────────────────────────────────────────
  const findDrafts = async () => {
    setBusy(true); setError(null)
    try {
      const u = await getJson(`${SLEEPER}/user/${encodeURIComponent(username.trim())}`)
      if (!u?.user_id) throw new Error('user not found')
      setUserId(u.user_id)
      const year = new Date().getFullYear()
      const lists = await Promise.all([year, year - 1].map((y) =>
        getJson(`${SLEEPER}/user/${u.user_id}/drafts/nfl/${y}`).catch(() => [])))
      const all: SleeperDraft[] = ([] as SleeperDraft[]).concat(...lists)
        .filter((d) => d && d.draft_id)
        .sort((a: any, b: any) => (b.start_time || 0) - (a.start_time || 0))
      setDrafts(all)
      persist({ userId: u.user_id })
      if (!all.length) setError('No drafts found for this account.')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally { setBusy(false) }
  }

  const sleeperTick = useCallback(async () => {
    if (!draftId || !userId) return
    let meta = metaRef.current.get(draftId)
    if (!meta || meta.status !== 'complete') {
      meta = (await getJson(`${SLEEPER}/draft/${draftId}`)) as SleeperDraft
      metaRef.current.set(draftId, meta)
    }
    const picks: any[] = await getJson(`${SLEEPER}/draft/${draftId}/picks`)

    const s: any = meta.settings || {}
    const scoring = String(meta.metadata?.scoring_type || '')
    const format = (s.slots_super_flex || 0) > 0 || scoring.includes('2qb') ? 'sf_ppr' : '1qb_ppr'
    const mode = scoring.includes('dynasty') ? 'dynasty' : 'redraft'
    const board = await getBoard(format, mode)

    // Mirror of the extension's Sleeper boot + pollPicks state assembly.
    const slotCounts: Record<string, Record<string, number>> = {}
    const counts: Record<string, number> = {}
    let qbRound: number | null = null
    const made = new Set<number>()
    for (const p of picks) {
      const n = Number(p.pick_no)
      if (n > 0) made.add(n)
      const pos = (p.metadata && p.metadata.position) || '?'
      if (p.draft_slot) {
        ;(slotCounts[p.draft_slot] = slotCounts[p.draft_slot] || {})[pos] =
          (slotCounts[p.draft_slot][pos] || 0) + 1
      }
      if (String(p.picked_by) === String(userId)) {
        counts[pos] = (counts[pos] || 0) + 1
        if (pos === 'QB' && qbRound === null) qbRound = Math.ceil((p.pick_no || 1) / (s.teams || 10))
      }
    }
    let cur = 1
    while (made.has(cur)) cur += 1

    publish({
      format, mode,
      draftType: meta.type || 'snake',
      lineup: {
        teams: s.teams || 10,
        qb: s.slots_qb ?? 1, rb: s.slots_rb ?? 2, wr: s.slots_wr ?? 2, te: s.slots_te ?? 1,
        flex: (s.slots_flex ?? 1) + (s.slots_wr_rb ?? 0) + (s.slots_wr_rb_te ?? 0),
        sf: s.slots_super_flex ?? 0, k: s.slots_k ?? 0, dst: s.slots_def ?? 0,
        rounds: s.rounds ?? 15,
      },
      mySlot: (meta.draft_order && meta.draft_order[userId]) || null,
      myUserId: userId,
      allPlayers: board.players,
      badges: new Map(),
      pickedIds: new Set(picks.map((p) => String(p.player_id))),
      slotCounts,
      myCounts: counts,
      myQBLate: qbRound !== null && qbRound >= 8,
      madePickNos: made,
      currentPick: cur,
    }, String(meta.metadata?.name || 'Draft'), 0)
  }, [draftId, userId])

  // ── ESPN path ────────────────────────────────────────────────────────
  const loadEspnLeague = async () => {
    setBusy(true); setError(null)
    try {
      const d = await getJson(`/api/espn/draft/${espnLeagueId.trim()}?season=${espnSeason}`)
      setEspnTeams(d.teams || [])
      persist({ espnLeagueId: espnLeagueId.trim(), espnSeason })
      if (!(d.teams || []).length) setError('League loaded but has no teams — check the league ID.')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally { setBusy(false) }
  }

  const espnTick = useCallback(async () => {
    if (!espnLeagueId || espnTeamId == null) return
    const d = await getJson(`/api/espn/draft/${espnLeagueId}?season=${espnSeason}`)
    const format = d.superflex ? 'sf_ppr' : '1qb_ppr'
    const board = await getBoard(format, 'redraft')
    const byEspn = new Map<number, any>()
    for (const p of board.players) {
      if (p.espn_id) byEspn.set(Number(p.espn_id), p)
    }

    // Draft slot per team: the league's pick order, or (fallback) the
    // observed round-1 order once the draft is running.
    const slotByTeam = new Map<number, number>()
    ;(d.pick_order || []).forEach((tid: number, i: number) => slotByTeam.set(tid, i + 1))
    if (!slotByTeam.size) {
      for (const p of d.picks) {
        if (p.overall <= d.lineup.teams) slotByTeam.set(p.team_id, p.overall)
      }
    }

    const slotCounts: Record<string, Record<string, number>> = {}
    const counts: Record<string, number> = {}
    let qbRound: number | null = null
    const made = new Set<number>()
    const pickedIds = new Set<string>()
    let unmatched = 0
    for (const p of d.picks) {
      made.add(p.overall)
      const player = byEspn.get(Number(p.espn_id))
      if (player) pickedIds.add(String(player.player_id))
      else unmatched += 1
      const pos = player?.position || '?'
      const slot = slotByTeam.get(p.team_id)
      if (slot) {
        ;(slotCounts[slot] = slotCounts[slot] || {})[pos] = (slotCounts[slot][pos] || 0) + 1
      }
      if (p.team_id === espnTeamId) {
        counts[pos] = (counts[pos] || 0) + 1
        if (pos === 'QB' && qbRound === null) qbRound = Math.ceil(p.overall / (d.lineup.teams || 10))
      }
    }
    let cur = 1
    while (made.has(cur)) cur += 1

    publish({
      format, mode: 'redraft',
      draftType: d.snake ? 'snake' : 'linear',
      lineup: d.lineup,
      mySlot: slotByTeam.get(espnTeamId) ?? null,
      myUserId: null,
      allPlayers: board.players,
      badges: new Map(),
      pickedIds,
      slotCounts,
      myCounts: counts,
      myQBLate: qbRound !== null && qbRound >= 8,
      madePickNos: made,
      currentPick: cur,
    }, d.name, unmatched)
  }, [espnLeagueId, espnSeason, espnTeamId])

  // ── Poll loop ────────────────────────────────────────────────────────
  const active = platform === 'sleeper' ? Boolean(draftId && userId) : Boolean(espnLeagueId && espnTeamId != null)
  const tick = useCallback(async () => {
    setError(null)
    try {
      if (platform === 'sleeper') await sleeperTick()
      else await espnTick()
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }, [platform, sleeperTick, espnTick])

  useEffect(() => {
    if (!active) return
    tick()
    const iv = setInterval(tick, POLL_MS[platform])
    const onVis = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [active, platform, tick])

  // Fresh live state → simulate forward → restore live state.
  const generatePlan = async () => {
    setPlanBusy(true)
    try {
      await tick()
      setPlan(simulatePlan(engine()))
      await tick()
    } catch (e: any) {
      setError(e.message || String(e))
    } finally { setPlanBusy(false) }
  }

  const copyQueue = async () => {
    if (!plan) return
    const text = plan.queue.map((q, i) => `${i + 1}. ${q.name} (${q.pos})`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable */ }
  }

  const reset = () => {
    setDraftId(null); setDrafts(null); setEspnTeams(null); setEspnTeamId(null)
    setSnap(null); setError(null)
    persist({ draftId: null, espnTeamId: null })
  }

  // ── Setup screen ─────────────────────────────────────────────────────
  if (!active) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <h1 className="text-xl font-semibold">Draft Companion</h1>
        <p className="text-sm text-muted-foreground">
          Live pick recommendations from the same engine as the desktop draft assistant.
        </p>
        <div className="flex rounded-md border border-border overflow-hidden text-sm">
          {(['sleeper', 'espn'] as Platform[]).map((p) => (
            <button
              key={p}
              onClick={() => { setPlatform(p); setError(null); persist({ platform: p }) }}
              className={cn(
                'flex-1 py-2 font-medium capitalize transition-colors',
                platform === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {p === 'espn' ? 'ESPN' : 'Sleeper'}
            </button>
          ))}
        </div>

        {platform === 'sleeper' && (
          <>
            <div className="flex gap-2">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && username.trim()) findDrafts() }}
                placeholder="Sleeper username"
                className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              />
              <button
                onClick={findDrafts}
                disabled={busy || !username.trim()}
                className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {busy ? '…' : 'Find drafts'}
              </button>
            </div>
            {drafts && drafts.length > 0 && (
              <div className="space-y-2">
                {drafts.map((d) => (
                  <button
                    key={d.draft_id}
                    onClick={() => { setDraftId(d.draft_id); persist({ draftId: d.draft_id }) }}
                    className="w-full text-left rounded-md border border-border px-3 py-2 hover:bg-muted/40 transition-colors"
                  >
                    <div className="text-sm font-medium">{d.metadata?.name || d.draft_id}</div>
                    <div className="text-xs text-muted-foreground">
                      {d.season} · {d.settings?.teams} teams · {d.settings?.rounds} rounds · {d.status}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {platform === 'espn' && (
          <>
            <div className="flex gap-2">
              <input
                value={espnLeagueId}
                onChange={(e) => setEspnLeagueId(e.target.value)}
                placeholder="ESPN league ID"
                inputMode="numeric"
                className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              />
              <input
                value={espnSeason}
                onChange={(e) => setEspnSeason(e.target.value)}
                inputMode="numeric"
                className="w-20 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                title="season"
              />
              <button
                onClick={loadEspnLeague}
                disabled={busy || !espnLeagueId.trim()}
                className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {busy ? '…' : 'Load'}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              The league ID is the <code>leagueId=</code> number in any of your ESPN league URLs.
              Real leagues only (ESPN never publishes mock-draft picks). Private leagues need the
              ESPN_S2 / ESPN_SWID env vars set on the server.
            </p>
            {espnTeams && espnTeams.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm text-muted-foreground">Which team is yours?</div>
                {espnTeams.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { setEspnTeamId(t.id); persist({ espnTeamId: t.id }) }}
                    className="w-full text-left rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>
    )
  }

  // ── Companion screen ─────────────────────────────────────────────────
  const a = snap?.audit
  const top = a?.top || []
  const star = top[0]
  return (
    <div className="max-w-md mx-auto space-y-4 pb-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold leading-tight">{snap?.draftName || 'Draft Companion'}</h1>
          {a && (
            <div className="text-xs text-muted-foreground">
              Pick #{a.pick}{a.round ? ` · Round ${a.round}` : ''}
              {a.la ? ` · your next: #${a.la.next}` : ''}
            </div>
          )}
        </div>
        <button onClick={reset} className="text-xs text-muted-foreground underline underline-offset-2">
          change
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {!snap && !error && <div className="text-sm text-muted-foreground">Loading draft…</div>}

      {snap && (
        <div className={cn(
          'rounded-md px-3 py-2 text-sm font-medium',
          snap.onClock ? 'bg-amber-500/15 text-amber-400 border border-amber-500/40'
            : 'bg-muted/40 text-muted-foreground border border-border'
        )}>
          {snap.onClock
            ? "YOU'RE ON THE CLOCK"
            : a?.la
              ? `${a.la.removals} player${a.la.removals === 1 ? '' : 's'} go before your turn`
              : `slot ${snap.clockSlot} is on the clock`}
        </div>
      )}

      {star && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-amber-400">Recommended</div>
          <div className="text-xl font-semibold">
            ★ {star.name}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {star.pos}{star.posRank} · {k(star.value)}
            </span>
          </div>
          {star.drop > 0 && (
            <div className="text-sm text-amber-400">−{k(star.drop)} if you wait</div>
          )}
          {top.length > 1 && (
            <div className="text-sm text-muted-foreground">
              then {top.slice(1).map((t: any) => `${t.name} ${k(t.value)}`).join(' · ')}
            </div>
          )}
          {a?.runRisk && (
            <div className="text-sm text-red-400">⚠ {a.runRisk.pos} run risk</div>
          )}
        </div>
      )}

      {a?.positions && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="grid grid-cols-[2.2rem_1fr_1fr_auto] gap-x-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
            <div /><div>Best now</div><div>{a.la ? `At #${a.la.next}` : 'Later'}</div><div>Vanish</div>
          </div>
          {a.positions.map((r: any) => (
            <div
              key={r.pos}
              className={cn(
                'grid grid-cols-[2.2rem_1fr_1fr_auto] gap-x-2 px-3 py-2 text-sm border-b border-border last:border-b-0',
                !r.eligible && 'opacity-40'
              )}
            >
              <div className="font-medium">{r.pos}</div>
              <div className="truncate">{r.now ? `${r.now.name} ${k(r.now.value)}` : '—'}{!r.eligible && ' (held)'}</div>
              <div className="truncate text-muted-foreground">{r.nb ? `${r.nb.name} ${k(r.nb.value)}` : '—'}</div>
              <div className={cn('text-right tabular-nums', r.drop > 500 ? 'text-amber-400' : 'text-muted-foreground')}>
                −{k(r.drop)}
              </div>
            </div>
          ))}
        </div>
      )}

      {a?.counts && snap && (
        <div className="flex flex-wrap gap-2 text-xs">
          {(['QB', 'RB', 'WR', 'TE'] as const).map((pos) => {
            const have = a.counts[pos] || 0
            const want = pos === 'QB' ? snap.lineup.qb + snap.lineup.sf : snap.lineup[pos.toLowerCase()]
            return (
              <span key={pos} className={cn(
                'rounded-full border px-2.5 py-1',
                have >= want ? 'border-border text-muted-foreground' : 'border-amber-500/40 text-amber-400'
              )}>
                {pos} {have}/{want}
              </span>
            )
          })}
          {a.roster && (
            <span className="rounded-full border border-border px-2.5 py-1 text-muted-foreground">
              {a.roster.remaining} picks left{a.roster.reserve ? ` · save ${a.roster.reserve} K/DST` : ''}
            </span>
          )}
        </div>
      )}

      {snap && snap.mySlot != null && (
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Autopilot queue</div>
              <div className="text-xs text-muted-foreground">
                Can't be there? Simulate your next picks and load the queue into the {platform === 'espn' ? 'ESPN' : 'Sleeper'} app —
                its autopick drafts from your queue, top-down, until you arrive.
              </div>
            </div>
            <button
              onClick={generatePlan}
              disabled={planBusy}
              className="shrink-0 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {planBusy ? '…' : plan ? 'Regenerate' : 'Generate'}
            </button>
          </div>
          {plan && plan.picks.length > 0 && (
            <>
              <div className="space-y-1.5">
                {plan.picks.map((p) => (
                  <div key={p.overall} className="text-sm">
                    <span className="text-muted-foreground tabular-nums">Rd {p.round} · #{p.overall}</span>{' '}
                    <span className="font-medium">★ {p.top[0].name} <span className="text-muted-foreground font-normal">{p.top[0].pos}</span></span>
                    {p.top.length > 1 && (
                      <span className="text-xs text-muted-foreground">
                        {' '}· or {p.top.slice(1).map((t: any) => t.name).join(' / ')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="border-t border-border pt-2 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Queue order ({plan.queue.length})</div>
                  <button onClick={copyQueue} className="text-xs underline underline-offset-2">
                    {copied ? 'copied ✓' : 'copy list'}
                  </button>
                </div>
                <ol className="text-sm space-y-0.5">
                  {plan.queue.map((q, i) => (
                    <li key={`${q.name}|${q.pos}`} className="flex gap-2">
                      <span className="text-muted-foreground tabular-nums w-5 text-right">{i + 1}.</span>
                      <span>{q.name} <span className="text-muted-foreground text-xs">{q.pos}</span></span>
                    </li>
                  ))}
                </ol>
                <div className="text-xs text-muted-foreground pt-1">
                  Snapshot of this moment — regenerate after picks happen, and re-order your in-app queue to match.
                </div>
              </div>
            </>
          )}
          {plan && plan.picks.length === 0 && (
            <div className="text-xs text-muted-foreground">Couldn't simulate — draft order may not be posted yet.</div>
          )}
        </div>
      )}

      {snap && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            synced {new Date(snap.syncedAt).toLocaleTimeString()} · refreshes every {POLL_MS[platform] / 1000}s
            {snap.unmatched > 0 && ` · ${snap.unmatched} picks off-board (K/DST)`}
          </span>
          <button onClick={tick} className="underline underline-offset-2">refresh now</button>
        </div>
      )}
    </div>
  )
}
