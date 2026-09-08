"""
Redraft team evaluation priced by REAL auction results.

Data source — ESPN Fantasy "Live Draft Trends":
  https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}
    /segments/0/leaguedefaults/3?view=kona_player_info
Each player's `ownership.auctionValueAverage` is the average winning bid
across actual ESPN auction drafts (standard $200 budgets) and
`averageDraftPosition` the live ADP from real snake drafts. Public endpoint,
no auth. We pull the top 800 by percent-owned (~250 players carry a
meaningful AAV, covering every startable position including K/DST) and cache
the sheet in sleeper_cache for 12 hours.

Honest scope: AAV moves daily during draft season and freezes when drafts
stop, so this grades rosters at DRAFT-DAY market value — "who won the
draft", not rest-of-season strength.

Evaluation: for each team, fill the league's actual starting slots greedily
by AAV (dedicated slots first, then FLEX/SUPER_FLEX variants), and report
starters/bench/total dollars plus per-position starter dollars ranked across
the league — strengths and weaknesses in one sheet.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any

import requests

from app.db import get_connection

logger = logging.getLogger(__name__)

TRENDS_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}"
    "/segments/0/leaguedefaults/3?view=kona_player_info"
)
TRENDS_TTL_SECONDS = 12 * 3600
ESPN_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}

# ESPN proTeamId -> Sleeper team abbreviation (Sleeper's DST player_id IS the
# abbreviation). ESPN D/ST player ids are -(16000 + proTeamId).
PRO_TEAM = {
    1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
    8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
    15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
    21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA",
    27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}

# Which player positions may fill each lineup slot token (Sleeper tokens;
# ESPN slot ids are translated to these in api/espn-land before use).
SLOT_ELIGIBILITY = {
    "QB": {"QB"},
    "RB": {"RB"},
    "WR": {"WR"},
    "TE": {"TE"},
    "K": {"K"},
    "DEF": {"DST"},
    "FLEX": {"RB", "WR", "TE"},
    "WRRB_FLEX": {"RB", "WR"},
    "REC_FLEX": {"WR", "TE"},
    "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
}


def _cache_get(conn, key: str, ttl: int) -> Any | None:
    row = conn.execute(
        "SELECT response_json, fetched_at FROM sleeper_cache WHERE url = ?", (key,)
    ).fetchone()
    if not row:
        return None
    fetched = datetime.fromisoformat(row[1])
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    if (datetime.now(timezone.utc) - fetched).total_seconds() > ttl:
        return None
    return json.loads(row[0])


def _cache_set(conn, key: str, data: Any) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO sleeper_cache (url, response_json, fetched_at) VALUES (?, ?, ?)",
        (key, json.dumps(data), datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


def fetch_auction_values(conn, season: int) -> dict:
    """espn_id (str) -> {name, pos, team, aav, adp}; cached 12h."""
    key = f"espn://auction/{season}"
    cached = _cache_get(conn, key, TRENDS_TTL_SECONDS)
    if cached is not None:
        return cached
    resp = requests.get(
        TRENDS_URL.format(season=season),
        headers={
            "x-fantasy-filter": json.dumps(
                {"players": {"limit": 800,
                             "sortPercOwned": {"sortPriority": 100, "sortAsc": False}}}
            )
        },
        timeout=20,
    )
    resp.raise_for_status()
    out: dict[str, dict] = {}
    for entry in resp.json().get("players") or []:
        p = entry.get("player") or {}
        own = p.get("ownership") or {}
        aav = own.get("auctionValueAverage")
        pid = p.get("id")
        pos = ESPN_POS.get(p.get("defaultPositionId"))
        if pid is None or pos is None or aav is None:
            continue
        out[str(pid)] = {
            "name": p.get("fullName"),
            "pos": pos,
            "team": PRO_TEAM.get(p.get("proTeamId"), ""),
            "aav": round(float(aav), 2),
            "adp": round(float(own.get("averageDraftPosition") or 0), 1),
        }
    if not out:
        raise RuntimeError("ESPN draft trends returned no auction values")
    _cache_set(conn, key, out)
    return out


def _sleeper_to_espn(conn) -> dict[str, str]:
    return {
        str(r[0]): str(r[1])
        for r in conn.execute("SELECT sleeper_id, espn_id FROM player_ids").fetchall()
    }


def _dst_espn_id_by_abbrev() -> dict[str, str]:
    return {abbr: str(-(16000 + tid)) for tid, abbr in PRO_TEAM.items()}


def optimal_lineup(players: list[dict], slots: list[str]) -> tuple[list[dict], list[dict]]:
    """
    Fill the league's starting slots greedily by AAV: every player (value
    order) takes his dedicated slot if one is open, else the tightest open
    flex he's eligible for. Returns (starters_with_slot, bench).
    """
    open_slots: dict[str, int] = {}
    for s in slots:
        if s in SLOT_ELIGIBILITY:
            open_slots[s] = open_slots.get(s, 0) + 1
    # Dedicated first, then narrower flexes before SUPER_FLEX.
    flex_order = ["WRRB_FLEX", "REC_FLEX", "FLEX", "SUPER_FLEX"]
    starters, bench = [], []
    for p in sorted(players, key=lambda x: -(x.get("aav") or 0)):
        placed = None
        for slot, elig in SLOT_ELIGIBILITY.items():
            if slot in flex_order:
                continue
            if open_slots.get(slot, 0) > 0 and p["pos"] in elig:
                placed = slot
                break
        if placed is None:
            for slot in flex_order:
                if open_slots.get(slot, 0) > 0 and p["pos"] in SLOT_ELIGIBILITY[slot]:
                    placed = slot
                    break
        if placed:
            open_slots[placed] -= 1
            starters.append({**p, "slot": placed})
        else:
            bench.append(p)
    return starters, bench


def _team_sheet(name: str, owner: str, players: list[dict], slots: list[str]) -> dict:
    starters, bench = optimal_lineup(players, slots)
    by_pos: dict[str, float] = {}
    for s in starters:
        by_pos[s["pos"]] = by_pos.get(s["pos"], 0.0) + (s["aav"] or 0)
    starters_total = round(sum(s["aav"] or 0 for s in starters), 1)
    bench_total = round(sum(b["aav"] or 0 for b in bench), 1)
    return {
        "name": name,
        "owner": owner,
        "starters_total": starters_total,
        "bench_total": bench_total,
        "total": round(starters_total + bench_total, 1),
        "by_pos": {k: round(v, 1) for k, v in by_pos.items()},
        "starters": starters,
        "bench": sorted(bench, key=lambda x: -(x.get("aav") or 0)),
        "unmatched": sum(1 for p in players if p.get("aav") is None),
    }


def _rank_teams(teams: list[dict]) -> None:
    """Attach overall + per-position ranks (1 = richest) in place."""
    order = sorted(teams, key=lambda t: -t["starters_total"])
    for i, t in enumerate(order):
        t["rank"] = i + 1
    positions = {p for t in teams for p in t["by_pos"]}
    for pos in positions:
        by = sorted(teams, key=lambda t: -(t["by_pos"].get(pos, 0.0)))
        for i, t in enumerate(by):
            t.setdefault("pos_rank", {})[pos] = i + 1


def evaluate_sleeper(league_id: str, season: int) -> dict:
    from app.ingestion.sleeper import SleeperClient

    conn = get_connection()
    try:
        values = fetch_auction_values(conn, season)
        xwalk = _sleeper_to_espn(conn)
        dst = _dst_espn_id_by_abbrev()
        client = SleeperClient(conn)
        league = client.get_league(league_id)
        users = {u["user_id"]: u for u in client.get_league_users(league_id)}
        rosters = client.get_league_rosters(league_id)
        all_players = client.get_all_players()
        slots = [s for s in (league.get("roster_positions") or []) if s != "BN"]

        teams = []
        for r in rosters:
            u = users.get(r.get("owner_id") or "", {})
            tname = (u.get("metadata") or {}).get("team_name") or u.get("display_name") or f"Roster {r.get('roster_id')}"
            plist = []
            for sid in r.get("players") or []:
                eid = xwalk.get(str(sid)) or dst.get(str(sid))
                v = values.get(eid) if eid else None
                meta = all_players.get(str(sid)) or {}
                pos = (v or {}).get("pos") or meta.get("position") or "?"
                pname = (v or {}).get("name") or (
                    f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip() or str(sid)
                )
                plist.append({
                    "name": pname, "pos": "DST" if pos == "DEF" else pos,
                    "aav": (v or {}).get("aav") if v else None,
                    "adp": (v or {}).get("adp") if v else None,
                })
            teams.append(_team_sheet(tname, u.get("display_name") or "", plist, slots))
        _rank_teams(teams)
        return {
            "platform": "sleeper",
            "league": {"name": league.get("name"), "teams": len(teams), "slots": slots},
            "season": season,
            "teams": sorted(teams, key=lambda t: t["rank"]),
        }
    finally:
        conn.close()


# ESPN lineup slot ids -> our slot tokens (bench/IR and IDP slots excluded).
ESPN_SLOT = {
    0: "QB", 2: "RB", 4: "WR", 6: "TE", 17: "K", 16: "DEF",
    23: "FLEX", 3: "WRRB_FLEX", 5: "REC_FLEX", 7: "SUPER_FLEX",
}


def evaluate_espn(league_id: str, season: int) -> dict:
    from app.api.espn import _espn_cookies, LM_API

    conn = get_connection()
    try:
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

        teams = []
        for t in data.get("teams") or []:
            tname = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip() or f"Team {t.get('id')}"
            plist = []
            for entry in ((t.get("roster") or {}).get("entries")) or []:
                p = (entry.get("playerPoolEntry") or {}).get("player") or {}
                v = values.get(str(p.get("id")))
                pos = (v or {}).get("pos") or ESPN_POS.get(p.get("defaultPositionId"), "?")
                plist.append({
                    "name": p.get("fullName") or str(p.get("id")),
                    "pos": pos,
                    "aav": (v or {}).get("aav") if v else None,
                    "adp": (v or {}).get("adp") if v else None,
                })
            teams.append(_team_sheet(tname, "", plist, slots))
        _rank_teams(teams)
        return {
            "platform": "espn",
            "league": {"name": (settings.get("name") or "ESPN League"), "teams": len(teams), "slots": slots},
            "season": season,
            "teams": sorted(teams, key=lambda t: t["rank"]),
        }
    finally:
        conn.close()
