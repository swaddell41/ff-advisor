"""
Live scoreboard: this week's matchup in every in-season league, with each
starter's points so far and the state of their NFL game.

Sources
  * Sleeper — public /v1/league/{id}/matchups/{week}: live points per
    roster and per player (starters_points aligned to starters), refreshed
    through the client with a 20s TTL.
  * ESPN — league view mMatchupScore + mBoxscore for the scoring period:
    schedule[].home/away.totalPointsLive and rosterForCurrentScoringPeriod
    entries with appliedStatTotal.
  * NFL game state — ESPN's public scoreboard (state pre/in/post + clock),
    cached 30s, keyed by team so each starter carries its game status.
  * Projection for unplayed starters — the cached ESPN weekly projection,
    so "projected final" = points so far + projections of players who
    haven't kicked off.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

from app.db import get_connection
from app.lineup import LIVE_ROSTER_TTL, current_nfl_week
from app.redraft import (
    ESPN_POS,
    ESPN_SLOT,
    PRO_TEAM,
    _cache_get,
    _cache_set,
    _dst_espn_id_by_abbrev,
    _sleeper_to_espn,
    fetch_auction_values,
)

STATUS_TTL = 30
MATCHUP_TTL = 20


def fetch_game_status(conn) -> dict[str, dict]:
    """team abbrev -> {state: pre|in|post, detail, opp} from ESPN's scoreboard."""
    key = "scoreboard://status"
    cached = _cache_get(conn, key, STATUS_TTL)
    if cached is not None:
        return cached
    out: dict[str, dict] = {}
    try:
        resp = requests.get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", timeout=15)
        resp.raise_for_status()
        for ev in resp.json().get("events") or []:
            comp = (ev.get("competitions") or [{}])[0]
            st = (ev.get("status") or {}).get("type") or {}
            state = st.get("state") or "pre"
            detail = st.get("shortDetail") or ""
            teams = []
            for c in comp.get("competitors") or []:
                ab = ((c.get("team") or {}).get("abbreviation") or "").upper()
                teams.append(("WAS" if ab == "WSH" else ab, c.get("score")))
            for i, (ab, score) in enumerate(teams):
                opp = teams[1 - i][0] if len(teams) == 2 else ""
                out[ab] = {"state": state, "detail": detail, "opp": opp,
                           "score": score, "opp_score": teams[1 - i][1] if len(teams) == 2 else None}
        if out:
            _cache_set(conn, key, out)
    except Exception:
        pass
    return out


def _game(status: dict, team: str) -> dict:
    g = status.get(team)
    if not g:
        return {"state": "bye", "detail": "bye"}
    return {"state": g["state"], "detail": g["detail"]}


def _side(name: str, owner: str, starters: list[dict], total: float | None = None) -> dict:
    pts = round(sum(s["points"] for s in starters), 2) if total is None else round(float(total), 2)
    return {
        "name": name,
        "owner": owner,
        "points": pts,
        "proj_remaining": round(sum(s["proj"] for s in starters if s["game"]["state"] == "pre"), 1),
        "yet_to_play": sum(1 for s in starters if s["game"]["state"] == "pre"),
        "in_play": sum(1 for s in starters if s["game"]["state"] == "in"),
        "starters": starters,
    }


def live_sleeper(league_id: str, week: int, user_id: str, season: int = 2026) -> dict:
    from app.ingestion.sleeper import SleeperClient

    conn = get_connection()
    try:
        client = SleeperClient(conn)
        league = client.get_league(league_id)
        users = {u["user_id"]: u for u in client.get_league_users(league_id)}
        rosters = client.get_league_rosters(league_id, ttl=LIVE_ROSTER_TTL)
        matchups = client.get_matchups(league_id, week, ttl=MATCHUP_TTL)
        all_players = client.get_all_players()
        values = fetch_auction_values(conn, season)
        xwalk = _sleeper_to_espn(conn)
        dst = _dst_espn_id_by_abbrev()
        status = fetch_game_status(conn)
        slots = [s for s in (league.get("roster_positions") or []) if s != "BN"]

        by_roster = {r["roster_id"]: r for r in rosters}

        def team_name(rid: int) -> tuple[str, str]:
            r = by_roster.get(rid) or {}
            u = users.get(r.get("owner_id") or "", {})
            return ((u.get("metadata") or {}).get("team_name") or u.get("display_name") or f"Roster {rid}",
                    u.get("display_name") or "")

        def starters_of(m: dict) -> list[dict]:
            rows = []
            pts = m.get("starters_points") or []
            for i, sid in enumerate(m.get("starters") or []):
                if not sid or sid == "0":
                    continue
                meta = all_players.get(str(sid)) or {}
                eid = xwalk.get(str(sid)) or dst.get(str(sid))
                v = values.get(eid) if eid else None
                team = (meta.get("team") or (v or {}).get("team") or "").upper()
                pos = meta.get("position") or (v or {}).get("pos") or "?"
                name = (v or {}).get("name") or f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip() or str(sid)
                rows.append({
                    "name": name, "pos": "DST" if pos == "DEF" else pos,
                    "slot": slots[i] if i < len(slots) else "?",
                    "team": team,
                    "points": round(float(pts[i]) if i < len(pts) and pts[i] is not None else 0.0, 2),
                    "proj": float(((v or {}).get("weeks") or {}).get(str(week)) or 0.0),
                    "game": _game(status, team),
                })
            return rows

        mine = next((m for m in matchups if str((by_roster.get(m["roster_id"]) or {}).get("owner_id")) == str(user_id)), None)
        opp = next((m for m in matchups if mine and m["matchup_id"] == mine["matchup_id"] and m["roster_id"] != mine["roster_id"]), None)
        me_side = _side(*team_name(mine["roster_id"]), starters_of(mine), mine.get("points")) if mine else None
        opp_side = _side(*team_name(opp["roster_id"]), starters_of(opp), opp.get("points")) if opp else None

        board = []
        seen = set()
        for m in matchups:
            mid = m.get("matchup_id")
            if mid in seen or mid is None:
                continue
            pair = [x for x in matchups if x.get("matchup_id") == mid]
            if len(pair) == 2:
                seen.add(mid)
                a, b = pair
                board.append({"a": {"name": team_name(a["roster_id"])[0], "points": float(a.get("points") or 0)},
                              "b": {"name": team_name(b["roster_id"])[0], "points": float(b.get("points") or 0)}})
        return {"platform": "sleeper", "league_id": league_id, "league": league.get("name"),
                "week": week, "me": me_side, "opp": opp_side, "scoreboard": board}
    finally:
        conn.close()


def live_espn(league_id: str, week: int, team_id: int, season: int = 2026, name: str | None = None) -> dict:
    from app.api.espn import LM_API, _espn_cookies

    conn = get_connection()
    try:
        values = fetch_auction_values(conn, season)
        status = fetch_game_status(conn)
        url = (f"{LM_API}/seasons/{season}/segments/0/leagues/{league_id}"
               f"?view=mMatchupScore&view=mBoxscore&view=mTeam&scoringPeriodId={week}")
        resp = requests.get(url, cookies=_espn_cookies(), timeout=20)
        resp.raise_for_status()
        data = resp.json()
        names = {t["id"]: (t.get("name") or f"Team {t['id']}") for t in data.get("teams") or []}
        sched = [m for m in data.get("schedule") or [] if m.get("matchupPeriodId") == week]

        def total(s: dict) -> float:
            return float(s.get("totalPointsLive") if s.get("totalPointsLive") is not None else (s.get("totalPoints") or 0))

        def starters_of(s: dict) -> list[dict]:
            rows = []
            for e in ((s.get("rosterForCurrentScoringPeriod") or {}).get("entries")) or []:
                slot = ESPN_SLOT.get(int(e.get("lineupSlotId", 20)))
                if not slot:
                    continue
                ppe = e.get("playerPoolEntry") or {}
                p = ppe.get("player") or {}
                eid = str(p.get("id"))
                v = values.get(eid)
                team = PRO_TEAM.get(p.get("proTeamId"), (v or {}).get("team") or "")
                rows.append({
                    "name": p.get("fullName") or eid,
                    "pos": (v or {}).get("pos") or ESPN_POS.get(p.get("defaultPositionId"), "?"),
                    "slot": "DEF" if slot == "DEF" else slot,
                    "team": team,
                    "points": round(float(ppe.get("appliedStatTotal") or 0), 2),
                    "proj": float(((v or {}).get("weeks") or {}).get(str(week)) or 0.0),
                    "game": _game(status, team),
                })
            order = ["QB", "RB", "WR", "TE", "WRRB_FLEX", "REC_FLEX", "FLEX", "SUPER_FLEX", "K", "DEF"]
            rows.sort(key=lambda r: order.index(r["slot"]) if r["slot"] in order else 99)
            return rows

        mine = next((m for m in sched if team_id in ((m.get("home") or {}).get("teamId"), (m.get("away") or {}).get("teamId"))), None)
        me_side = opp_side = None
        if mine:
            me_raw = mine["home"] if (mine.get("home") or {}).get("teamId") == team_id else mine.get("away")
            opp_raw = mine["away"] if me_raw is mine.get("home") else mine.get("home")
            me_side = _side(names.get(me_raw.get("teamId"), ""), "", starters_of(me_raw), total(me_raw)) if me_raw else None
            opp_side = _side(names.get(opp_raw.get("teamId"), ""), "", starters_of(opp_raw), total(opp_raw)) if opp_raw else None
        board = [{"a": {"name": names.get((m.get("home") or {}).get("teamId"), "?"), "points": total(m.get("home") or {})},
                  "b": {"name": names.get((m.get("away") or {}).get("teamId"), "?"), "points": total(m.get("away") or {})}}
                 for m in sched if m.get("home") and m.get("away")]
        return {"platform": "espn", "league_id": league_id, "league": name or (data.get("settings") or {}).get("name") or "ESPN League",
                "week": week, "me": me_side, "opp": opp_side, "scoreboard": board}
    finally:
        conn.close()


def build_live(uid: str, leagues: list[dict], season: int = 2026) -> dict:
    week = current_nfl_week()

    def one(lg: dict) -> dict | None:
        try:
            if lg["platform"] == "espn":
                tid = int(lg.get("team_id") or 0)
                if not tid:
                    return None
                return live_espn(lg["league_id"], week, tid, season, name=lg.get("name"))
            return live_sleeper(lg["league_id"], week, uid, season)
        except Exception as e:
            return {"platform": lg["platform"], "league_id": lg["league_id"], "league": lg.get("name"),
                    "week": week, "me": None, "opp": None, "scoreboard": [], "error": str(e)}

    with ThreadPoolExecutor(max_workers=6) as ex:
        results = [r for r in ex.map(one, leagues) if r and (r.get("me") or r.get("error"))]
    conn = get_connection()
    try:
        status = fetch_game_status(conn)
    finally:
        conn.close()
    counts: dict[str, int] = {}
    seen_games = set()
    for ab, g in status.items():
        key = tuple(sorted([ab, g.get("opp") or ""]))
        if key in seen_games:
            continue
        seen_games.add(key)
        counts[g["state"]] = counts.get(g["state"], 0) + 1
    return {
        "week": week,
        "games": [{"state": k, "count": v} for k, v in counts.items()],
        "matchups": results,
        "updated": datetime.now(timezone.utc).isoformat(),
    }
