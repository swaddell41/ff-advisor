import { useCallback, useEffect, useRef, useState } from 'react'
import { createDraftEngine, pickSlot, type DraftEngine } from '@/lib/draftEngine'
import { cn } from '@/lib/utils'

/**
 * Mobile draft companion: the extension's side-panel recommendation, as a
 * phone-friendly page. Same engine file, same numbers — this page only
 * gathers the inputs (Sleeper's public draft API + our /api/draftboard) and
 * renders the audit the engine produces.
 */

const SLEEPER = 'https://api.sleeper.app/v1'
const POLL_MS = 30_000
const STORE_KEY = 'ffa-draft-companion'

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
  syncedAt: number
}

const k = (v: number) => `${(v / 1000).toFixed(1)}k`

async function sleeperJson(path: string) {
  const r = await fetch(`${SLEEPER}${path}`)
  if (!r.ok) throw new Error(`Sleeper ${path} → ${r.status}`)
  return r.json()
}

export default function DraftCompanion() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
  })()
  const [username, setUsername] = useState<string>(saved.username || '')
  const [userId, setUserId] = useState<string | null>(saved.userId || null)
  const [drafts, setDrafts] = useState<SleeperDraft[] | null>(null)
  const [draftId, setDraftId] = useState<string | null>(saved.draftId || null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const engineRef = useRef<DraftEngine | null>(null)
  const metaRef = useRef<Map<string, SleeperDraft>>(new Map())
  const boardRef = useRef<Map<string, any>>(new Map())

  const persist = (patch: Record<string, any>) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ username, userId, draftId, ...patch })) } catch { /* private mode */ }
  }

  const findDrafts = async () => {
    setBusy(true); setError(null)
    try {
      const u = await sleeperJson(`/user/${encodeURIComponent(username.trim())}`)
      if (!u?.user_id) throw new Error('user not found')
      setUserId(u.user_id)
      const year = new Date().getFullYear()
      const lists = await Promise.all([year, year - 1].map((y) =>
        sleeperJson(`/user/${u.user_id}/drafts/nfl/${y}`).catch(() => [])))
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

  const tick = useCallback(async () => {
    if (!draftId || !userId) return
    setError(null)
    try {
      let meta = metaRef.current.get(draftId)
      if (!meta || meta.status !== 'complete') {
        meta = (await sleeperJson(`/draft/${draftId}`)) as SleeperDraft
        metaRef.current.set(draftId, meta)
      }
      const picks: any[] = await sleeperJson(`/draft/${draftId}/picks`)

      const s: any = meta.settings || {}
      const scoring = String(meta.metadata?.scoring_type || '')
      const format = (s.slots_super_flex || 0) > 0 || scoring.includes('2qb') ? 'sf_ppr' : '1qb_ppr'
      const mode = scoring.includes('dynasty') ? 'dynasty' : 'redraft'
      const boardKey = `${format}:${mode}`
      let board = boardRef.current.get(boardKey)
      if (!board) {
        const r = await fetch(`/api/draftboard?format=${format}&mode=${mode}`)
        if (!r.ok) throw new Error(`draftboard → ${r.status}`)
        board = await r.json()
        boardRef.current.set(boardKey, board)
      }

      if (!engineRef.current) engineRef.current = createDraftEngine()
      const eng = engineRef.current
      const st = eng.state

      // Mirror of the extension's Sleeper boot + pollPicks state assembly.
      st.format = format
      st.mode = mode
      st.draftType = meta.type || 'snake'
      st.lineup = {
        teams: s.teams || 10,
        qb: s.slots_qb ?? 1, rb: s.slots_rb ?? 2, wr: s.slots_wr ?? 2, te: s.slots_te ?? 1,
        flex: (s.slots_flex ?? 1) + (s.slots_wr_rb ?? 0) + (s.slots_wr_rb_te ?? 0),
        sf: s.slots_super_flex ?? 0, k: s.slots_k ?? 0, dst: s.slots_def ?? 0,
        rounds: s.rounds ?? 15,
      }
      st.mySlot = (meta.draft_order && meta.draft_order[userId]) || null
      st.myUserId = userId
      st.allPlayers = board.players
      st.badges = new Map()
      st.pickedIds = new Set(picks.map((p) => String(p.player_id)))
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
      st.slotCounts = slotCounts
      st.myCounts = counts
      st.myQBLate = qbRound !== null && qbRound >= 8
      st.madePickNos = made
      let cur = 1
      while (made.has(cur)) cur += 1
      st.currentPick = cur

      eng.computeReplacement()
      eng.recommend()

      const clockSlot = pickSlot(cur, st.lineup.teams, st.draftType === 'snake')
      setSnap({
        audit: st.audit,
        lineup: st.lineup,
        onClock: st.mySlot != null && clockSlot === st.mySlot,
        mySlot: st.mySlot,
        clockSlot,
        draftName: String(meta.metadata?.name || 'Draft'),
        syncedAt: Date.now(),
      })
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }, [draftId, userId])

  useEffect(() => {
    if (!draftId || !userId) return
    tick()
    const iv = setInterval(tick, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [draftId, userId, tick])

  // ── Setup screen ─────────────────────────────────────────────────────
  if (!draftId || !userId) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <h1 className="text-xl font-semibold">Draft Companion</h1>
        <p className="text-sm text-muted-foreground">
          Live pick recommendations from the same engine as the desktop draft assistant.
          Enter your Sleeper username to find your drafts.
        </p>
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
        {error && <div className="text-sm text-red-400">{error}</div>}
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
        <button
          onClick={() => { setDraftId(null); setSnap(null); setDrafts(null); persist({ draftId: null }) }}
          className="text-xs text-muted-foreground underline underline-offset-2"
        >
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

      {snap && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>synced {new Date(snap.syncedAt).toLocaleTimeString()} · refreshes every 30s</span>
          <button onClick={tick} className="underline underline-offset-2">refresh now</button>
        </div>
      )}
    </div>
  )
}
