"""
Start/sit engine: the user's CURRENT lineup vs the optimal one for this
NFL week. Methodology follows current start/sit best practice — a point
projection is the baseline, not the whole answer:

  * CONSENSUS projections — ESPN weekly (cached kona sheet, split-1 rows)
    blended with Sleeper's own weekly projections (public
    api.sleeper.app/projections). Two independent sources beat one; their
    disagreement is surfaced as an uncertainty signal.
  * VEGAS game environment — over/under and spread per game from ESPN's
    public scoreboard, turned into implied team totals (the strongest
    single predictor of weekly scoring environment).
  * CROWD — percentStarted from ESPN ownership (what managers actually do).
  * INJURY/AVAILABILITY — designations flagged; OUT/IR/etc zeroed by the
    projections themselves.

Both platforms expose the currently set lineup, so this is true start/sit:
Sleeper rosters carry `starters`; ESPN roster entries carry lineupSlotId
(bench 20, IR 21). The optimizer ranks by the blended projection; every
row carries the full signal set so close calls can be judged in context.
NFL week comes from Sleeper's public /v1/state/nfl.
"""

import requests

from app.redraft import _cache_get, _cache_set

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


def fetch_vegas(conn, week: int) -> dict:
    """
    Team abbrev -> {opp, ou, spread, implied, kickoff} from ESPN's public
    scoreboard. spread is team-relative (negative = favored); implied is the
    team's implied point total: (over/under - spread) / 2. Cached 1h.
    """
    key = f"vegas://nfl/{week}"
    cached = _cache_get(conn, key, 3600)
    if cached is not None:
        return cached
    out: dict[str, dict] = {}
    try:
        resp = requests.get(
            "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
            timeout=15,
        )
        resp.raise_for_status()
        for ev in resp.json().get("events") or []:
            comp = (ev.get("competitions") or [{}])[0]
            comps = comp.get("competitors") or []
            if len(comps) != 2:
                continue
            abbrevs = {}
            for c in comps:
                ab = ((c.get("team") or {}).get("abbreviation") or "").upper()
                abbrevs[ab if ab != "WSH" else "WAS"] = c
            odds = (comp.get("odds") or [{}])[0]
            ou = odds.get("overUnder")
            details = str(odds.get("details") or "")  # e.g. "SEA -3"
            fav, spread = None, 0.0
            parts = details.split()
            if len(parts) == 2:
                fav = parts[0].upper()
                fav = "WAS" if fav == "WSH" else fav
                try:
                    spread = float(parts[1])
                except ValueError:
                    spread = 0.0
            names = list(abbrevs)
            for ab in names:
                other = names[1] if ab == names[0] else names[0]
                team_spread = spread if ab == fav else (-spread if fav else 0.0)
                implied = round((float(ou) - team_spread) / 2, 1) if ou else None
                out[ab] = {
                    "opp": other,
                    "ou": ou,
                    "spread": team_spread,
                    "implied": implied,
                    "kickoff": ev.get("date"),
                }
        if out:
            _cache_set(conn, key, out)
    except Exception:
        pass  # vegas is enrichment, never a blocker
    return out


def fetch_sleeper_projections(conn, season: int, week: int) -> dict:
    """sleeper player_id -> {ppr, half_ppr, std} weekly projection. Cached 6h."""
    key = f"sleeperproj://{season}/{week}"
    cached = _cache_get(conn, key, 6 * 3600)
    if cached is not None:
        return cached
    out: dict[str, dict] = {}
    try:
        resp = requests.get(
            f"https://api.sleeper.app/projections/nfl/{season}/{week}"
            "?season_type=regular"
            "&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF",
            timeout=20,
        )
        resp.raise_for_status()
        for row in resp.json() or []:
            st = row.get("stats") or {}
            out[str(row.get("player_id"))] = {
                "ppr": round(float(st.get("pts_ppr") or 0), 1),
                "half_ppr": round(float(st.get("pts_half_ppr") or 0), 1),
                "std": round(float(st.get("pts_std") or 0), 1),
            }
        if out:
            _cache_set(conn, key, out)
    except Exception:
        pass  # second opinion only — ESPN weekly proj still stands alone
    return out


def blend(espn: float, sleeper: float | None) -> float:
    """Consensus value: mean of the sources that exist."""
    if sleeper is None:
        return round(espn, 1)
    return round((espn + sleeper) / 2, 1)


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

        vegas = fetch_vegas(conn, week)
        sproj = fetch_sleeper_projections(conn, season, week)
        rec = float((league.get("scoring_settings") or {}).get("rec") or 0)
        skey = "ppr" if rec >= 1 else ("half_ppr" if rec >= 0.5 else "std")

        def prow(sid: str) -> dict:
            eid = xwalk.get(str(sid)) or dst.get(str(sid))
            v = values.get(eid) if eid else None
            meta = all_players.get(str(sid)) or {}
            pos = (v or {}).get("pos") or meta.get("position") or "?"
            pname = (v or {}).get("name") or (
                f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip() or str(sid)
            )
            team = (v or {}).get("team") or (meta.get("team") or "")
            sp = sproj.get(str(sid))
            espn_proj = _wk_proj(v, week)
            slpr_proj = sp.get(skey) if sp else None
            return {
                "name": pname,
                "pos": "DST" if pos == "DEF" else pos,
                "aav": blend(espn_proj, slpr_proj),
                "espn_proj": espn_proj,
                "slpr_proj": slpr_proj,
                "start_pct": (v or {}).get("start_pct"),
                "team": team,
                "injury": (v or {}).get("injury") or (meta.get("injury_status") or ""),
                **(vegas.get(team) or {}),
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

        vegas = fetch_vegas(conn, week)
        sproj = fetch_sleeper_projections(conn, season, week)
        espn_to_sleeper = {v: k for k, v in _sleeper_to_espn(conn).items()}
        espn_to_sleeper.update({v: k for k, v in _dst_espn_id_by_abbrev().items()})

        players, current_names = [], set()
        for entry in ((team.get("roster") or {}).get("entries")) or []:
            p = (entry.get("playerPoolEntry") or {}).get("player") or {}
            eid = str(p.get("id"))
            v = values.get(eid)
            tm = (v or {}).get("team") or ""
            sp = sproj.get(espn_to_sleeper.get(eid) or "")
            espn_proj = _wk_proj(v, week)
            # ESPN leagues get the PPR sheet as the second opinion; ESPN's own
            # projection already matches the league's real scoring.
            slpr_proj = sp.get("ppr") if sp else None
            row = {
                "name": p.get("fullName") or eid,
                "pos": (v or {}).get("pos") or ESPN_POS.get(p.get("defaultPositionId"), "?"),
                "aav": blend(espn_proj, slpr_proj),
                "espn_proj": espn_proj,
                "slpr_proj": slpr_proj,
                "start_pct": (v or {}).get("start_pct"),
                "team": tm,
                "injury": (v or {}).get("injury") or p.get("injuryStatus") or "",
                **(vegas.get(tm) or {}),
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
