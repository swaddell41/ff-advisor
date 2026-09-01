import { pickSlot, type DraftEngine } from './draftEngine'

/**
 * Pre-draft plan: walk the draft forward from the current pick with the SAME
 * machinery the live strip uses — opponents modeled need-aware (the engine's
 * room model), every one of MY turns scored by the engine's full recommend()
 * (VORP + vanish + lineup-completion plan) — and record the top choices at
 * each of my picks.
 *
 * The flattened result doubles as an autodraft queue: both Sleeper and ESPN
 * take from your queue, top-down, when you're absent — so loading it means
 * the platform's own autopick executes this strategy until you arrive.
 */

export interface PlanPick {
  overall: number
  round: number
  top: any[] // audit.top rows: {name, pos, posRank, value, ...}
}

export interface DraftPlan {
  picks: PlanPick[]
  queue: { name: string; pos: string; value: number }[]
  /**
   * Faller net: players the room model expects to be TAKEN before my first
   * pick, that I could start, valued above my planned star. Queued ABOVE the
   * script they are inert when the draft goes as expected (already gone, so
   * autopick skips them) — but if one is still on the board at my turn, he
   * fell, and queue-first autopick correctly grabs the steal instead of the
   * scripted pick.
   */
  net: { name: string; pos: string; value: number }[]
}

// Same starters-first rule the engine assumes of opponents (teamCanStart).
function teamCanStart(L: any, c: Record<string, number>, pos: string): boolean {
  const ded: Record<string, number> = {
    QB: (L.qb + L.sf) - (c.QB || 0),
    RB: L.rb - (c.RB || 0),
    WR: L.wr - (c.WR || 0),
    TE: L.te - (c.TE || 0),
  }
  const flexUsed = Math.max(0, (c.RB || 0) - L.rb) +
    Math.max(0, (c.WR || 0) - L.wr) + Math.max(0, (c.TE || 0) - L.te)
  const flexOpen = Math.max(0, L.flex - flexUsed)
  const anyOpen = flexOpen > 0 || Object.values(ded).some((n) => n > 0)
  if (!anyOpen) return pos === 'RB' || pos === 'WR'
  return (ded[pos] || 0) > 0 || (flexOpen > 0 && (pos === 'RB' || pos === 'WR'))
}

/**
 * Simulate from the engine's CURRENT state (set it up via the normal tick
 * first). Mutates engine state while running — re-run the live tick after.
 */
export function simulatePlan(eng: DraftEngine, myTurns = 8, queueSize = 24): DraftPlan {
  const st = eng.state
  const L = st.lineup
  if (!st.mySlot || !L?.teams) return { picks: [], queue: [], net: [] }

  const snake = st.draftType === 'snake'
  const horizon = (L.rounds || 15) * L.teams
  const made: Set<number> = st.madePickNos || new Set()
  const picked = new Set<string>(st.pickedIds)
  const roomC: Record<string, Record<string, number>> = {}
  for (const k in (st.slotCounts || {})) roomC[k] = { ...st.slotCounts[k] }
  const counts: Record<string, number> = { ...(st.myCounts || {}) }
  const startPick = st.currentPick

  // My starters-first gate (mirrors the engine's canStart, TE flex rule
  // included), evaluated against my roster as it stands NOW — the net only
  // guards my first upcoming pick.
  const teFilled = (counts.TE || 0) >= L.te
  const myDed: Record<string, number> = {
    QB: Math.max(0, (L.qb + L.sf) - (counts.QB || 0)),
    RB: Math.max(0, L.rb - (counts.RB || 0)),
    WR: Math.max(0, L.wr - (counts.WR || 0)),
    TE: Math.max(0, L.te - (counts.TE || 0)),
  }
  const myFlexUsed = Math.max(0, (counts.RB || 0) - L.rb) +
    Math.max(0, (counts.WR || 0) - L.wr) + Math.max(0, (counts.TE || 0) - L.te)
  const myFlexOpen = Math.max(0, L.flex - myFlexUsed)
  const myCanStart = (pos: string) =>
    (myDed[pos] || 0) > 0 ||
    (myFlexOpen > 0 && (pos === 'RB' || pos === 'WR' || (pos === 'TE' && !teFilled)))
  const preTakes: { name: string; pos: string; value: number }[] = []

  const avail = () => st.allPlayers.filter((p: any) => !picked.has(String(p.player_id)))

  const picks: PlanPick[] = []
  for (let pn = startPick; pn <= horizon && picks.length < myTurns; pn++) {
    if (made.has(pn)) continue
    const slot = pickSlot(pn, L.teams, snake)
    if (slot === st.mySlot) {
      st.currentPick = pn
      st.pickedIds = picked
      st.slotCounts = roomC
      st.myCounts = counts
      st.badges = new Map()
      eng.recommend()
      const top = (st.audit?.top || []).slice(0, 3)
      if (!top.length) break
      picks.push({ overall: pn, round: Math.ceil(pn / L.teams), top })
      const choice = avail().find(
        (p: any) => p.name === top[0].name && p.position === top[0].pos
      )
      if (!choice) break
      picked.add(String(choice.player_id))
      counts[choice.position] = (counts[choice.position] || 0) + 1
    } else {
      const c = (roomC[slot] = roomC[slot] || {})
      const pool = avail()
      const take = pool.find((p: any) => teamCanStart(L, c, p.position)) || pool[0]
      if (!take) break
      picked.add(String(take.player_id))
      c[take.position] = (c[take.position] || 0) + 1
      if (picks.length === 0) {
        preTakes.push({ name: take.name, pos: take.position, value: take.value })
      }
    }
  }

  const queue: DraftPlan['queue'] = []
  const seen = new Set<string>()
  for (const p of picks) {
    for (const t of p.top) {
      const key = `${t.name}|${t.pos}`
      if (seen.has(key)) continue
      seen.add(key)
      queue.push({ name: t.name, pos: t.pos, value: t.value })
      if (queue.length >= queueSize) break
    }
    if (queue.length >= queueSize) break
  }

  // Only takes that outvalue my planned star belong in the net — anything
  // below it must never jump the script.
  const starValue = picks[0]?.top[0]?.value ?? Infinity
  const net = preTakes
    .filter((t) => myCanStart(t.pos) && t.value > starValue)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12)

  return { picks, queue, net }
}
