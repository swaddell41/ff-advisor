# ESPN draft support — state of the world

This file briefs anyone (human or agent) picking up the ESPN half of the
draft-assistant extension. Read `README.md` first for the architecture
and the recommendation engine; this file covers what is ESPN-specific,
what has been verified, and what remains.

**The original brief (v0.4.4) listed five tasks. All five are done or
deliberately closed.** Sam's real ESPN redraft draft is in early
September 2026. Sleeper is live, working, and protected by tests —
regressions there are still worse than ESPN slipping.

## Architecture (enforced, not aspirational)

One shared decision engine; platforms differ ONLY in how league
settings/picks are ingested and how results render into the DOM.
`arch-test.js` makes this executable: the engine region of `annotate.js`
must contain no platform tokens, both adapters must populate the full
engine input contract (`format, lineup, pickedIds, myCounts, mySlot,
slotCounts, draftType, myQBLate, mode` + `setCurrentPick`), and no
engine function may appear in any rendering file. If you change shared
scan/badge code, verify on BOTH platforms — two bugs shipped this way
(v0.4.5 badge reconciliation nuked Sleeper badges; ESPN masked it).

## The ESPN protocol (captured live, no longer folklore)

`wss://fantasydraft.espn.com/game-1/league-<id>/JOIN?...`, space-
separated token frames:

    SELECTED  <teamId> <playerId> <n> [memberId]   a pick (memberId = own picks only)
    SELECTING <teamId> 30000                       team on the clock (30000 = pick clock ms)
    AUTOSUGGEST <playerId>                         what autopick would take — NOT a pick
    CLOCK 0 <msRemaining> · PONG · TOKEN · JOINED · AUTODRAFT <teamId> <bool>
    INIT <base64>                                  full state — big-endian int32 binary, unparsed
    STATE <n>                                      bare status code, NOT pick history

Hard-won parser facts (`content-espn.js`):

- Match `/^(AUTO)?SELECTED$/` exactly. A substring test swallows
  SELECTING and records the 30000 pick clock as a phantom player id.
- The trailing `<n>` is NOT a pick number and NOT the round (team 8
  reported 1, then 8, then 4 on consecutive turns). Pick order comes
  from frame ARRIVAL order, which reconstructed a clean snake in the
  captured data. Tokens are read positionally.
- Picks made before the tap connects arrive only in the binary INIT
  frame. Do not try to parse it — see the mid-draft strategy below.

## Data sources and their limits

| Source | Works for | Limit |
|---|---|---|
| WebSocket tap (live frames) | everything | only picks made while connected |
| `chrome.storage` persistence | refresh/reload mid-draft | only what the tap saw (12h TTL, per-league) |
| `lm-api-reads...?view=mSettings` | real leagues + practice drafts | via background proxy, creds; gives lineup slots, size, rounds |
| `lm-api-reads...?view=mDraftDetail` (20s poll) | REAL league drafts | **never written by practice drafts** — reports the parent league's unstarted draft, all slots playerId -1. Filter unmade picks NUMERICALLY (`Number(playerId) > 0`); the sentinel is -1 and a string compare against '0' admits it |
| DOM header cross-check ("ON THE CLOCK: PICK N") | gap detection | detection only, never a data source |

Mid-draft strategy that follows from the table: persistence covers
reloads; the draftDetail poll recovers outage-missed picks in a REAL
league; in a mock, missed picks are **detected but not recoverable**
(`state.espnGap` → pill warning → seating guard refuses → engine
degrades to the value-order model instead of running a confidently-wrong
room model). League size is observed from the running draft itself on
both platforms (`observedTeamCount`) and outranks settings.

## Verified live vs pending

Verified in a live ESPN mock (league 951798216 era, v0.4.5–v0.5.0):
badges one-per-row across scrolling, picks parsed and vanishing, roster
counts exact, superflex/rounds from the league API through the proxy,
seating + roster-aware run model engaged (audit panel showed the room
model, snake math agreed with ESPN's own header: pick #23 = round 3 pick
7 in an 8-team room).

Pending live verification:
1. Mid-draft refresh persistence (v0.5.6) — join a mock, 5+ picks,
   refresh, roster/pool must survive.
2. The v0.6.0 completion-plan engine in any live room (both platforms).
3. `mDraftDetail` backfill against the REAL September league (cannot be
   tested before a real draft exists).

## Landmines — violating these bricks the ESPN app or the extension

- NEVER relay via `window.postMessage` on espn.com — their lobby/draft
  windows coordinate on it; one foreign message blanks their React app.
  Only the `ffa-espn-frame` CustomEvent (JSON-string detail).
- Wrap `WebSocket` with Proxy + `Reflect.construct` only. Never touch
  outgoing traffic.
- No content-script fetches (page CSP). All HTTP via the background
  `ffa-fetch` proxy; new hosts go in its ALLOWED list AND
  `host_permissions`. The proxy takes a `creds` flag for ESPN.
- Guard every `chrome.*` call (orphaned scripts after reload). After any
  extension reload, REFRESH draft tabs — the tap only sees sockets
  opened after it installs.
- The draft room is a popup (`all_frames: true`). ESPN's player tables
  are FixedDataTable (`div[role="row"]`, `.public_fixedDataTableCell_cellContent`)
  — the only `<tr>` on the page are sidebar tables. `cellContent` only
  when reading cells; `[role="gridcell"]` is its parent and double-counts.
- Sam's ESPN leagues are REDRAFT (`mode=redraft`, set explicitly).
- Corporate networks can block the draft WebSocket; ESPN also rejects
  JOIN when a stale draft session is open elsewhere (`connect @ draft.js`
  failures with the extension disabled proved this is ESPN-side, not us).
- A `WebSocket connection failed: construct @ inject-espn.js:45` stack is
  ATTRIBUTION, not causation — Chrome blames the construction site. The
  SSE fallback failing identically proves it isn't the tap.

## Diagnostics

Side panel → **copy diagnostics** (works in Sleeper mode too). One
click, no console — this exists because the page console has no
`chrome.storage` and the service-worker console has no `document`, and
picking the wrong one burned four round-trips in a live draft. Exports
version, `espnDraft`, `espnBackfillInfo` (incl. the unmade-pick
sentinel), `espnCmdWords` (protocol census), STATE/INIT frames, both
frame rings, and `espnDomSample`/`espnHistorySample` (DOM shape samples).

## Test suites (run all: `for t in extension/*-test.js; do node $t; done`)

| Suite | Guards |
|---|---|
| `parser-test.js` | ESPN frame parsing, replayed against captured bytes |
| `teams-test.js` | league-size observation, both platforms' key shapes |
| `backfill-test.js` | draftDetail merge + unmade-pick sentinel (19 asserts) |
| `hydrate-test.js` | pick persistence across a session boundary |
| `gap-test.js` | missed-pick detection, seating refusal on gaps |
| `rowscan-test.js` | badge reconciliation incl. Sleeper multi-player rows |
| `arch-test.js` | shared-engine contract (see Architecture) |
| `strategy-test.js` | engine ≥ every forced strategy on final-lineup value |
| `robustness-test.js` | engine within 2.5% of best even vs rooms that don't share its model |

`strategy-test.js` and `robustness-test.js` run the REAL `recommend()`
in a sandbox against `board-fixture.json` (frozen board snapshot). They
exist because the greedy scorer was one-pick myopic ("4 WRs and a TE
before an RB") until the v0.6.0 roster-completion plan; the fixture
keeps the finding reproducible. Bump `manifest.json` on every behavioral
change; commit with verification evidence (established convention).

Tooling note for agents in this environment: bash-heredoc-written files
lose one backslash level (`\\.` → `\.`, and `\b` in python strings once
became a literal 0x08). Prefer regex literals, string `includes`, or
python index-splicing; sweep for control characters after writing.

## Deliberately closed / parked

- **STATE/INIT parsing** — INIT is opaque binary; superseded by
  persistence + draftDetail. Do not reopen without a compelling reason.
- **Pick History DOM scraping** — would recover outage picks in mocks
  (the one uncovered case). Sticky sampler (`espnHistorySample`) is in
  place if ever needed; parked as a testing-only inconvenience.
- **Badge meta-line anchor (original task 4)** — the brief's condition
  ("if the fallback looks bad") is unmet; inline badges render cleanly.
- **ADP-based opponent model** — measured, not worth it: the engine
  re-plans from observed state each pick and stays within 1.6% of the
  best line even against maximally mismatched rooms (see
  `robustness-test.js` commit for the numbers).

## Draft-day checklist (September)

1. Personal network, not corporate. Close stale ESPN draft tabs first.
2. Extension loaded, then REFRESH the draft-room popup; confirm the FFA
   pill and `ESPN · league <id>` in the side panel.
3. Be connected from pick 1 (seating derives from a complete round 1;
   the draftDetail poll is the backstop in the real league).
4. Watch the pill: `⚠ N picks missed` means the run model is off and
   recommendations are value-order only — still correct players, less
   room awareness.
5. If anything looks wrong: side panel → copy diagnostics → save it.
