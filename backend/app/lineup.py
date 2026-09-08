"""
Start/sit engine: the user's CURRENT lineup vs the optimal one for this
NFL week, priced by ESPN weekly projections (same cached kona sheet the
redraft evaluator uses — statSplitTypeId 1 rows, one per scoring period).

Both platforms expose the currently set lineup, so this is true start/sit:
Sleeper rosters carry `starters` (aligned to the league's non-bench
roster_positions, "0" = empty slot); ESPN roster entries carry
lineupSlotId (bench 20, IR 21). The optimal lineup reuses the redraft
optimizer with weekly points as the value. NFL week comes from Sleeper's
public /v1/state/nfl.

Output is a swap plan: who to start, who to sit, and the projected points
the current lineup leaves on the bench. Injury status and 0.0-projection
starters (bye/out) are flagged.
"""

import requests

from app.db import get_connection
from app.redraft import (
    ESPN_POS,
    ESPN_SLOT,
    _dst_espn_id_by_abbrev,
    _sleeper_to_espn,
    fetch_auction_values,
    optimal_lineup,
)

BAD_INJURY = {"OUT", "INJURY_RESERVE", "SUSPENSION", "DOUBTFUL"}


def current_nfl_week() -> int:
    try:
        st = requests.get("https://api.sleeper.app/v1/state/nfl", timeout=10).json()
        wk = int(st.get("week") or 1)
        return max(1, min(18, wk))
    except Exception:
        return 1


def _wk_proj(v: dict | None, week: int) -> float:
    if not v:
        return 0.0
    return float((v.get("weeks") or {}).get(str(week)) or 0.0)


def _build_result(name: str, week: int, players: list[dict], current_names: set[str], slots: list[str]) -> dict:
    optimal, bench = optimal_lineup(players, slots)
    optimal_names = {p["name"] for p in optimal}
    current = [p for p in players if p["name"] in current_names]
    current_total = round(sum(p["aav"] or 0 for p in current), 1)
    optimal_total = round(sum(p["aav"] or 0 for p in optimal), 1)
    return {
        "team": name,
        "week": week,
        "current_total": current_total,
        "optimal_total": optimal_total,
        "delta": round(optimal_total - current_total, 1),
        "start": sorted(
            [p for p in optimal if p["name"] not in current_names],
            key=lambda p: -(p["aav"] or 0),
        ),
        "sit": sorted(
            [p for p in current if p["name"] not in optimal_names],
            key=lambda p: -(p["aav"] or 0),
        ),
        "optimal": optimal,
        "bench": bench,
        "flags": [
            {"name": p["name"], "why": (p.get("injury") or ("no projection" if not p["aav"] else ""))}
            for p in current
            if (p.get("injury") in BAD_INJURY) or not p["aav"]
        ],
    }


def lineup_sleeper(league_id: str, season: int, user_id: str, roster_id: int | None = None) -> dict:
    from app.ingestion.sleeper import SleeperClient

    conn = get_connection()
    try:
        week = current_nfl_week()
        values = fetch_auction_values(conn, season)
        xwalk = _sleeper_to_espn(conn)
        dst = _dst_espn_id_by_abbrev()
        client = SleeperClient(conn)
        league = client.get_league(league_id)
        rosters = client.get_league_rosters(league_id)
        users = {u["user_id"]: u for u in client.get_league_users(league_id)}
        all_players = client.get_all_players()

        mine = None
        for r in rosters:
            if roster_id is not None and r.get("roster_id") == roster_id:
                mine = r
                break
            if roster_id is None and str(r.get("owner_id")) == str(user_id):
                mine = r
                break
        if mine is None:
            raise ValueError("no roster for this user in that league (pass roster_id)")

        slots = [s for s in (league.get("roster_positions") or []) if s != "BN"]
        starters = set(str(s) for s in (mine.get("starters") or []) if s and s != "0")

        def prow(sid: str) -> dict:
            eid = xwalk.get(str(sid)) or dst.get(str(sid))
            v = values.get(eid) if eid else None
            meta = all_players.get(str(sid)) or {}
            pos = (v or {}).get("pos") or meta.get("position") or "?"
            pname = (v or {}).get("name") or (
                f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip() or str(sid)
            )
            return {
                "name": pname,
                "pos": "DST" if pos == "DEF" else pos,
                "aav": _wk_proj(v, week),
                "injury": (v or {}).get("injury") or (meta.get("injury_status") or ""),
            }

        players = [prow(sid) for sid in (mine.get("players") or [])]
        current_names = {prow(sid)["name"] for sid in starters}
        u = users.get(mine.get("owner_id") or "", {})
        tname = (u.get("metadata") or {}).get("team_name") or u.get("display_name") or "My team"
        out = _build_result(tname, week, players, current_names, slots)
        out["league"] = league.get("name")
        return out
    finally:
        conn.close()


def lineup_espn(league_id: str, season: int, team_id: int) -> dict:
    from app.api.espn import LM_API, _espn_cookies

    conn = get_connection()
    try:
        week = current_nfl_week()
        values = fetch_auction_values(conn, season)
        url = (
            f"{LM_API}/seasons/{season}/segments/0/leagues/{league_id}"
            "?view=mSettings&view=mTeam&view=mRoster"
        )
        resp = requests.get(url, cookies=_espn_cookies(), timeout=20)
        resp.raise_for_status()
        data = resp.json()
        settings = data.get("settings") or {}
        slot_counts = (settings.get("rosterSettings") or {}).get("lineupSlotCounts") or {}
        slots: list[str] = []
        for sid, n in slot_counts.items():
            token = ESPN_SLOT.get(int(sid))
            if token:
                slots.extend([token] * int(n))

        team = next((t for t in data.get("teams") or [] if t.get("id") == team_id), None)
        if team is None:
            raise ValueError(f"team {team_id} not in league")
        players, current_names = [], set()
        for entry in ((team.get("roster") or {}).get("entries")) or []:
            p = (entry.get("playerPoolEntry") or {}).get("player") or {}
            v = values.get(str(p.get("id")))
            row = {
                "name": p.get("fullName") or str(p.get("id")),
                "pos": (v or {}).get("pos") or ESPN_POS.get(p.get("defaultPositionId"), "?"),
                "aav": _wk_proj(v, week),
                "injury": (v or {}).get("injury") or p.get("injuryStatus") or "",
            }
            players.append(row)
            if int(entry.get("lineupSlotId", 20)) in ESPN_SLOT:
                current_names.add(row["name"])
        tname = team.get("name") or f"Team {team_id}"
        out = _build_result(tname, week, players, current_names, slots)
        out["league"] = settings.get("name") or "ESPN League"
        return out
    finally:
        conn.close()
