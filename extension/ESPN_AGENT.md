# Agent brief: finish ESPN draft support

You are picking up the ESPN half of the draft-assistant extension in this
directory. Sleeper support is COMPLETE and is your reference
implementation — read `README.md` first, then this file. The goal is
feature parity on ESPN redraft drafts: live pick tracking, roster-aware
recommendations (lookahead + run model), and the audit panel, all
verified in an ESPN mock draft. The user's real ESPN redraft draft is in
early September 2026 — that is the deadline.

## Current state (what already works)

- `inject-espn.js` taps ESPN draft-room WebSockets (MAIN world,
  document_start, all_frames; Proxy + `Reflect.construct`) and relays
  incoming text frames ≤4000 chars via the `ffa-espn-frame` CustomEvent.
- `content-espn.js` parses frames defensively: token frames whose command
  word contains `SELECT` (heuristics: playerId = largest int ≥1000,
  teamId = int ≤64, pickNo ≤600) plus a JSON scanner for
  `playerId`/`teamId` fields. Publishes `espnDraft` {leagueId, myTeamId,
  picks[{espn_id, team_id, pick_no}], framesSeen} to
  `chrome.storage.local`, and keeps `espnDebugFrames` — a ring buffer of
  the last 80 raw frames. The side panel has a "copy debug frames"
  affordance to export it.
- `annotate.js` (`watchEspnPicks`, `applyEspn`) consumes `espnDraft`:
  maps espn_id → player via the board's crosswalk (backend joins
  DynastyProcess `player_ids`, 6.2k rows), builds `pickedIds`, my roster
  counts from `team_id === myTeamId`, and detects superflex from
  `lineupSlotCounts` (slot 7 = OP, or >1 of slot 0 = QB) fetched from
  `lm-api-reads.fantasy.espn.com` with credentials. An `espnSF` panel
  toggle overrides when the API is unreachable.
- `panel.js` has an `espn_sim=N` offline mode that fabricates N picks so
  the pipeline renders without a live draft.
- The recommendation engine in `annotate.js` is platform-agnostic EXCEPT
  the pieces listed below.

## What's missing (your work, in order)

1. **Parser calibration against real frames.** The `SELECTED` frame
   format is community-lore, never verified against a live 2026 draft
   room. Get into an ESPN mock draft (see Testing), let a few picks
   happen, export `espnDebugFrames`, and fix `parseFrame()` to match
   reality. This is the critical unknown — do it first. If frames turn
   out to be JSON or binary, keep the defensive multi-shape approach.
2. **Per-team rosters → run model.** Sleeper's run model keys off
   `state.slotCounts` (every team's positional counts) and
   `state.mySlot`. On ESPN: accumulate counts per `team_id` from parsed
   picks, and derive my slot / snake order from the draft's team order
   (the WS frames or the mm-draft API carry pick order; `myTeamId` comes
   from the URL). Then wire them into the existing `nextMyPickInfo` /
   `simulateRoom` / `worstCaseAtNext` path — the functions are
   platform-agnostic once `state.mySlot`, `state.slotCounts`,
   `state.lineup`, and `state.currentPick` are populated. Today ESPN
   falls back to the value-order model (`expectedNextBest`) with no run
   awareness.
3. **Lineup from league settings.** `applyEspn` already reads
   `lineupSlotCounts` (slot ids: 0=QB, 2=RB, 4=WR, 6=TE, 7=OP/superflex,
   16=D/ST, 17=K, 23=FLEX) — verify `state.lineup` gets teams/rounds too
   (needed by snake math and replacement baselines). Mocks may need
   defaults (10 teams, 16 rounds) when the league API is unreachable.
4. **DOM annotation check.** `annotate.js`'s scanner walks TEXT nodes and
   is site-agnostic, but badge placement targets Sleeper's
   `.name-wrapper > .position` meta line with a gutter fallback. Inspect
   ESPN draft-room player rows and add an ESPN-specific meta-line
   anchor if the fallback looks bad. Names must never truncate or be
   overlapped.
5. **End-to-end mock verification.** Full acceptance: in an ESPN mock,
   badges appear on rows, picks disappear from the board within ~2s, the
   ★ strip updates pick-by-pick with correct roster counts, lookahead
   drop + run warning render, and the audit panel shows the roster-aware
   room model (not the fallback note).

## Landmines — violating these bricks the ESPN app or the extension

- **NEVER relay via `window.postMessage`** anywhere on espn.com. Their
  lobby ↔ draft-room windows coordinate over postMessage; one foreign
  message crashes their React app to a blank page (undefined.pageName).
  Only the `ffa-espn-frame` CustomEvent (JSON-string detail).
- **Never replace `WebSocket` with a plain function wrapper** — Proxy +
  `Reflect.construct` only (subclass/instanceof preservation). Never
  touch outgoing traffic.
- **No content-script fetches** — page CSP kills them. All HTTP goes
  through the background `ffa-fetch` proxy (`background.js`), and new
  hosts must be added to its ALLOWED list AND `host_permissions`.
- The ESPN league API (`lm-api-reads.fantasy.espn.com`) needs
  `credentials: 'include'` and works only for leagues the logged-in
  browser can see; mock drafts may return nothing — degrade gracefully.
- Guard every `chrome.*` call against "Extension context invalidated"
  (orphaned scripts after reload) — follow the `alive()`/try-catch
  patterns already in these files. Tell the user to refresh draft tabs
  after reloading the extension.
- The draft room is a POPUP window (`all_frames: true` matters), and it
  did not load at all on the user's work machine — corporate network
  blocks the draft WebSocket. Test from a personal network. Sam's ESPN
  leagues are REDRAFT: board must use `mode=redraft` (fc_redraft values)
  — `annotate.js` already selects this for ESPN.

## Testing

1. Load unpacked at `chrome://extensions`; after ANY reload, refresh the
   draft tab.
2. ESPN mock lobby: fantasy.espn.com → Fantasy Football → Mock Draft
   Lobby → join a live mock (10-team snake). The draft room opens as a
   popup — check that `inject-espn.js` ran in it (look for the FFA status
   pill; `window.__ffaWsTapInstalled` in the popup's console).
3. Watch `chrome.storage.local` (`espnDraft.framesSeen`) to confirm the
   tap sees traffic before worrying about parsing.
4. Offline iteration: side panel → `espn_sim=N`.
5. Offline math verification (established pattern): replay the
   recommender in a script against the prod board
   (`https://ff-advisor-sam-waddells-projects.vercel.app/api/draftboard?format=1qb_ppr&mode=redraft`)
   and assert the ★ pick matches expectations — see recent commit
   messages for worked examples.
6. `node --check` every JS file you touch. Bump `manifest.json` version
   on every behavioral change and note it in the commit message.

## Style & scope

- Match the existing code style: vanilla JS, no build step, no deps,
  heavy explanatory comments for WHY (see `annotate.js`).
- Don't touch the Sleeper paths (`content.js`, Sleeper branches in
  `annotate.js`) except to lift shared logic — Sleeper is live and
  working; regressions there are worse than ESPN slipping.
- Commit in small steps with the verification evidence in the message.
