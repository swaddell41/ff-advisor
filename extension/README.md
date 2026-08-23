# Dynasty Advisor — Draft Assistant (Chrome extension)

A Chrome MV3 extension that turns Sleeper (and, in progress, ESPN) draft
pages into an advised draft board. It does **not** replace the site's UI —
it injects value badges into the site's own player rows, keeps a fixed
"★ PICK" strip with roster-aware recommendations, and can explain every
recommendation it makes via an audit panel.

Backed by the ff-advisor backend (`/api/draftboard` on the Vercel
deployment), which blends RosterAudit + FantasyCalc values (redraft values
for seasonal drafts, dynasty values otherwise), normalized to a 0–10k
scale, refreshed daily.

## Install

1. `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select this `extension/` directory.
2. Open a Sleeper draft (`sleeper.com/draft/nfl/<id>`, mock drafts work).
3. **After reloading the extension you must refresh any open draft tabs**
   — orphaned content scripts from the old version cannot talk to the new
   service worker ("Extension context invalidated").

Identity is zero-setup on Sleeper (the logged-in user id is read from the
page's localStorage). If roster detection fails, click the ★ strip and
enter your Sleeper username.

## What you see

- **Badges** in each player row (placed inside the position/team meta line
  so names never truncate): `1.8k T3 ↑11` = our value, positional tier,
  and falling-value delta vs. current pick. Green = value falling to you.
- **Footer bar** (bottom-left, scoreboard-graphite styling from the
  claude.ai/design "Draft Advisor Panel" project, direction 4a): amber
  `★ BOWERS 6.1k TE` block, `−2.5k if you wait` (cost of waiting on the
  top pick), `⚠ QB run risk`, the next-best two, picks left / K-DST
  reserve, and the `why?` panel toggle.
- **"why?"** opens the tabbed audit panel above the bar:
  **VERDICT** (the pick as a hero card — value over the positional line,
  wait cost, need multiplier, and what the runner-up lineups finish at),
  **WAIT COST** (per-position: best now → expected at your next pick →
  if a run → value that vanishes, plus every rule in effect), and
  **UNTIL #n** (a timeline of the room model's expected take at every
  pick before your next turn, your roster grid, and board health).
- **Warning pill** (bottom-left): hidden while everything is healthy;
  appears only for real problems (board fetch failed, no names matched,
  or — on ESPN — `⚠ N picks missed — open the Pick History tab to
  recover`, which heals the state via a DOM scrape of ESPN's own pick
  record; mocks have no API history to recover from).
- **`⟳ UPDATING…`** on the bar (Sleeper): the site removes a drafted
  player's row instantly while the public API lags a beat — when the top
  pick's row vanishes the bar says it's updating instead of advertising
  a possibly-taken player, and polls immediately (600ms mutation-driven
  cadence otherwise).

## How the recommendation engine works (annotate.js)

All logic is lineup-derived from the draft's actual settings (teams,
slots, superflex, rounds) — nothing is hardcoded to a league size.

1. **VORP foundation.** Replacement level per position = the value of the
   player at the rank the league's starting slots consume (e.g. QB:
   `teams×(qb+sf)+2`; RB/WR count 45% of flex slots). Draft worth = value
   above that line, so a backup QB (QB13 is ~free in 10-team) loses to a
   weekly starter.
2. **Starters-first gate (hard filter).** While any starting slot is open,
   only players who can fill one are ranked. This is an exclusion, not a
   penalty — soft penalties leak in the endgame when every remaining flex
   option is below replacement and a gated QB's residual VORP tops the
   noise. Gated players return only if NO eligible player remains.
3. **TE2 flex exclusion.** Once the TE slot is filled, TEs don't qualify
   as flex fillers: elite-TE market value is scarcity premium for the TE
   slot, not weekly points; a TE2 produces flex-line numbers at a premium
   price.
4. **Lookahead (cost of waiting).** Score adds each player's "vanishing
   value": his value now minus the expected best at his position at YOUR
   next pick (snake math from the draft order). Choosing between two
   needed positions across two picks reduces exactly to comparing
   drop-offs — a cliffing position (WR19→WR26) beats a flat shelf
   (RB26≈RB28) even at similar VORP.
5. **Roster-aware run model.** We track every team's roster via each
   pick's `draft_slot` and simulate the picks between your turns as each
   team taking its best-value *need* (the same starters-first rules,
   assumed of opponents). Runs emerge naturally: six QB-needy teams
   between your picks means six QBs likely gone. A worst-case bound per
   position (every team that could start it takes it) powers the "if a
   run" audit column and the strip's run warning. The score stays on the
   expected outcome — risk is surfaced, not baked in.
6. **Dual-regime scoring.** Starters phase = VORP + vanishing value.
   Bench phase = raw value + vanishing value (late RB/WRs all have VORP≈0
   by definition, which is exactly why VORP is the wrong bench currency —
   market value proxies ceiling for lottery tickets).
7. **Bench insurance policy** (research-validated, see git history):
   spare QBs/TEs score ×0.12 — in 10-team 1QB leagues the wire is rich,
   stream instead. Exceptions for the FIRST backup QB only: ×0.4 in
   12+-team leagues (thinner wire), ×0.3 if your QB1 arrived in round 8+
   ("pair a cheap QB1 with one upside dart"). TE2 gets no exception.
8. **Need multipliers.** Positional appetite decays with what you've
   drafted (QB in 1QB: [1.0, 0.3, 0.1]; superflex: [1.1, 1.0, 0.5, 0.15];
   TE: [1.0, 0.4, 0.15]; RB/WR decay gently). K/DST aren't on the board;
   the strip tells you when remaining picks should be reserved for them.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 config; content scripts per site; background worker |
| `annotate.js` | **The core.** In-row badges, ★ strip, audit panel, full recommendation engine. Runs on Sleeper and ESPN draft pages |
| `content.js` | Sleeper page → side-panel plumbing |
| `overlay.js` | In-page panel host (action-button toggle on draft pages) |
| `background.js` | Action click routing + `ffa-fetch` proxy (page CSP blocks content-script fetches — ALL API calls route through here) |
| `inject-espn.js` | MAIN-world WebSocket tap for ESPN draft rooms (Proxy + `Reflect.construct`) |
| `content-espn.js` | Parses relayed ESPN frames → picks → `chrome.storage` |
| `panel.html/js/css` | Side panel (board list, platform toggles, `espn_sim` test mode) |

Data sources at runtime: Sleeper public API (`api.sleeper.app` — draft
settings, picks, users; no auth) and the ff-advisor backend
(`/api/draftboard?format=&mode=`).

## Testing

- **Sleeper:** create a mock draft at sleeper.com → mock drafts behave
  identically to real drafts via the public API. The recommendation math
  can be replayed offline: fetch `/v1/draft/{id}` + `/picks`, fetch the
  prod draftboard, and re-run the scoring in a script — see commit
  messages for worked examples (this is the established debugging loop).
- **ESPN:** see `ESPN_AGENT.md`. Offline: set `espn_sim=N` in the side
  panel to simulate N picks against the board without a live draft.
- `node --check extension/annotate.js` before committing.

## Hard-won landmines (do not relearn these)

- Never relay via `window.postMessage` on ESPN — their lobby/draft-room
  windows coordinate on that channel and foreign messages blank their app.
  Use the `ffa-espn-frame` CustomEvent.
- Wrap `WebSocket` with Proxy + `Reflect.construct`, never a plain
  function — plain wrappers break subclasses and can blank the page.
- Content-script `fetch` dies on site CSP — route via background
  `ffa-fetch`.
- Sleeper renders player names as bare TEXT nodes with sibling elements —
  the DOM scanner walks text nodes (TreeWalker), not leaf elements.
- Badges must live in the meta line (`.name-wrapper > .position`), not
  inline with names (truncation) and not in the row gutter (collides with
  star/queue buttons at 213–279px).
- After `chrome://extensions` reload, refresh draft tabs (orphaned
  scripts).
