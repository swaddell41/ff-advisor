# Draft Assistant (Chrome extension)

Live draft board for Sleeper drafts: multi-source values, tier breaks,
roster-need hints, injury flags, and falling-value alerts.

## Install (unpacked, for now)

1. Chrome → `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` folder
4. Pin "Dynasty Advisor — Draft Assistant" to the toolbar

## Use

- Open any Sleeper or ESPN draft room — the assistant appears as a
  **floating card on the page itself** (drag it by the header, collapse
  with —, hide with ✕; the toolbar icon brings it back). Position and
  collapsed state are remembered.
- The Chrome side panel is still available from the toolbar icon on
  non-draft pages, and the panel can connect manually by pasted draft URL/ID.
- Enter your Sleeper username once to get "your picks" tracking and
  positional-need hints.
- Mode auto-detects (redraft values for seasonal drafts, dynasty values for
  dynasty drafts; SF vs 1QB from draft settings) — the toggle overrides it.
- Green `+N` badge = ranked N picks earlier than the current pick and still
  available (falling value).

## Testing without a live draft

Serve the folder (`python3 -m http.server 8787`) and open:
`http://localhost:8787/panel.html?draft=<draft_id>&api=http://localhost:8000`

## Data

Board values come from the ff-advisor backend (RosterAudit + FantasyCalc
redraft/market, refreshed daily). Live picks come straight from Sleeper's
public API, polled every 4 seconds.
