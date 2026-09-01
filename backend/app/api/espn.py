"""
ESPN draft proxy for the mobile Draft Companion.

ESPN has no public draft API: the desktop extension taps the draft room's
WebSocket, which requires the room to be open in a browser. Off-computer,
the only channel is the league-read API (lm-api-reads), which the extension
already uses for settings (mSettings) and outage backfill (mDraftDetail —
real leagues only; practice drafts never write it). This proxy polls those
same views server-side so a phone can follow a REAL league draft with no
desktop involved.

Private leagues need ESPN's auth cookies. Set env vars:
  ESPN_S2   — the `espn_s2` cookie from a logged-in espn.com session
  ESPN_SWID — the `SWID` cookie (with or without the braces)
Public leagues answer without them.

Local testing: ESPN_FIXTURE=<path to a JSON file shaped like ESPN's
response> serves that file instead of calling ESPN.
"""

import json
import os

import requests
from fastapi import APIRouter, HTTPException

from app.api.me import _require_user_id

router = APIRouter()

LM_API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"

# ESPN lineupSlotCounts ids — mirrors extension/annotate.js exactly:
# 0=QB, 2=RB, 4=WR, 6=TE, 23=FLEX(RB/WR/TE), 3=RB/WR, 5=WR/TE,
# 7=OP (QB-eligible superflex), 17=K, 16=DST, 20=bench, 21=IR.


def _espn_cookies() -> dict:
    s2 = os.environ.get("ESPN_S2", "").strip()
    swid = os.environ.get("ESPN_SWID", "").strip()
    if not s2 or not swid:
        return {}
    if not swid.startswith("{"):
        swid = "{" + swid.strip("{}") + "}"
    return {"espn_s2": s2, "SWID": swid}


def _fetch_league(league_id: str, season: int) -> dict:
    fixture = os.environ.get("ESPN_FIXTURE", "").strip()
    if fixture:
        with open(fixture) as f:
            return json.load(f)
    url = (
        f"{LM_API}/seasons/{season}/segments/0/leagues/{league_id}"
        "?view=mSettings&view=mDraftDetail&view=mTeam"
    )
    resp = requests.get(url, cookies=_espn_cookies(), timeout=15)
    if resp.status_code in (401, 403):
        raise HTTPException(
            status_code=502,
            detail=(
                "ESPN denied access — for a private league set the ESPN_S2 and "
                "ESPN_SWID env vars (espn_s2 / SWID cookies from a logged-in "
                "espn.com session)."
            ),
        )
    try:
        data = resp.json()
    except ValueError:
        raise HTTPException(status_code=502, detail=f"ESPN returned non-JSON (HTTP {resp.status_code})")
    # ESPN reports errors as a `messages` list (deleted league, wrong season…)
    if isinstance(data, dict) and data.get("messages") and "settings" not in data:
        raise HTTPException(status_code=502, detail=f"ESPN: {data['messages'][0]}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"ESPN HTTP {resp.status_code}")
    return data


@router.get("/api/espn/draft/{league_id}")
def espn_draft(league_id: str, season: int):
    """League settings + live draft picks, normalized for the companion page."""
    _require_user_id()
    data = _fetch_league(league_id, season)

    settings = data.get("settings") or {}
    slots = (settings.get("rosterSettings") or {}).get("lineupSlotCounts") or {}

    def n(slot_id: str) -> int:
        return int(slots.get(slot_id) or 0)

    lineup = {
        "teams": settings.get("size") or 10,
        "qb": n("0") or 1,
        "rb": n("2"),
        "wr": n("4"),
        "te": n("6"),
        "flex": n("23") + n("3") + n("5"),
        "sf": n("7"),
        "k": n("17"),
        "dst": n("16"),
        # Every slot the draft fills, bench included, IR excluded — same
        # rule the extension derived the hard way (see annotate.js).
        "rounds": sum(n(sid) for sid in slots if sid != "21") or 16,
    }
    superflex = n("7") > 0 or n("0") > 1

    draft_settings = settings.get("draftSettings") or {}
    pick_order = [int(t) for t in (draft_settings.get("pickOrder") or [])]
    snake = str(draft_settings.get("type") or "SNAKE").upper() == "SNAKE"

    teams = [
        {
            "id": t.get("id"),
            "name": t.get("name")
            or f"{t.get('location', '')} {t.get('nickname', '')}".strip()
            or f"Team {t.get('id')}",
        }
        for t in (data.get("teams") or [])
    ]

    dd = data.get("draftDetail") or {}
    picks = []
    for q in dd.get("picks") or []:
        # draftDetail is pre-allocated for the whole draft; unmade picks
        # carry playerId -1. Numeric test — '-1' > '0' as strings.
        try:
            pid = int(q.get("playerId") or 0)
            overall = int(q.get("overallPickNumber") or 0)
        except (TypeError, ValueError):
            continue
        if pid <= 0 or overall <= 0:
            continue
        picks.append({
            "espn_id": pid,
            "team_id": int(q.get("teamId") or 0),
            "overall": overall,
            "keeper": bool(q.get("keeper")),
        })

    return {
        "league_id": league_id,
        "season": season,
        "name": (settings.get("name") or f"ESPN league {league_id}"),
        "lineup": lineup,
        "superflex": superflex,
        "snake": snake,
        "pick_order": pick_order,
        "teams": teams,
        "picks": picks,
        "drafted": bool(dd.get("drafted")),
        "in_progress": bool(dd.get("inProgress")),
    }
