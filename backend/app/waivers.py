"""
Waiver watch: who's popular on the wire, whether they beat what I already
have, and what to bid.

Signals
  * Popularity — Sleeper's public trending-adds feed (24h add counts across
    all Sleeper leagues, cached 1h) plus ESPN's 7-day percent-owned change
    from the cached kona sheet. Popularity is also the COMPETITION proxy for
    bidding: a top-5 trend needs the top of the range to win.
  * Availability — not on any roster in THIS league (Sleeper rosters / ESPN
    mRoster).
  * Fit — this week's consensus projection vs the weakest starter I'd
    displace (the "bar" at that position, flex-aware), plus season
    projection vs my best bench body at the position (depth value).

FAAB — a resource-allocation rulebook distilled from current expert
guidance (FantasyPros, 4for4, Fantasy Footballers, Yahoo, Footballguys):
  * Tiers by opportunity, as % of REMAINING budget: league-winner (a real
    starting role, RB/WR, big weekly gain) 40-60% · new weekly starter
    15-30% · flex/upside depth 5-12% · streamer (K/DST/spot QB) 1-4%.
  * No single claim above 30% of remaining unless it's the league-winner
    tier; keep roughly half the budget through the first month.
  * FAAB depreciates: weeks 5-10 are the richest (injuries turn handcuffs
    into starters), after week 11 scale bids down, playoffs only pay for
    players who start immediately.
  * Bid on role changes, not box-score hype: the tier is decided by the
    projection gap over my own bar, popularity only moves a bid within its
    tier.
Leagues on traditional waiver priority get a "use your priority / wait for
free agency" verdict instead of a dollar figure.
"""

import requests

from app.db import get_connection
from app.lineup import (
    blend,
    current_nfl_week,
    fetch_sleeper_projections,
    fetch_vegas,
    _wk_proj,
)
from app.redraft import (
    ESPN_POS,
    ESPN_SLOT,
    SLOT_ELIGIBILITY,
    _cache_get,
    _cache_set,
    _dst_espn_id_by_abbrev,
    _sleeper_to_espn,
    fetch_auction_values,
    optimal_lineup,
)

TREND_TTL = 3600
STREAMERS = {"K", "DST"}


def fetch_trending(conn) -> dict[str, dict]:
    """sleeper player_id -> {count, rank} from the public trending-adds feed."""
    key = "sleeper://trending/add"
    cached = _cache_get(conn, key, TREND_TTL)
    if cached is not None:
        return cached
    out: dict[str, dict] = {}
    try:
        resp = requests.get(
            "https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=60",
            timeout=15,
        )
        resp.raise_for_status()
        for i, row in enumerate(resp.json() or []):
            out[str(row.get("player_id"))] = {"count": int(row.get("count") or 0), "rank": i + 1}
        if out:
            _cache_set(conn, key, out)
    except Exception:
        pass
    return out


def season_factor(week: int) -> tuple[float, str]:
    if week <= 4:
        return 1.0, "early season: spend for real roles, but keep ~half the budget for weeks 5-10"
    if week <= 10:
        return 1.0, "weeks 5-10 are where league-winners surface — this is what the budget is for"
    if week <= 14:
        return 0.85, "late season: fewer weeks of value left, bids scale down"
    return 0.6, "playoffs: only pay for someone who starts for you this week"


def recommend_bid(tier: str, remaining: int, week: int, trend_rank: int | None) -> dict:
    ranges = {
        "league-winner": (0.40, 0.60),
        "starter": (0.15, 0.30),
        "upside": (0.05, 0.12),
        "streamer": (0.01, 0.04),
    }
    if tier not in ranges or remaining <= 0:
        return {"bid": 0, "pct": 0.0, "why": []}
    lo, hi = ranges[tier]
    # Competition: hot trends need the top of the range to actually win.
    comp = 1.0 if (trend_rank and trend_rank <= 5) else 0.6 if (trend_rank and trend_rank <= 20) else 0.3
    pct = lo + (hi - lo) * comp
    factor, note = season_factor(week)
    pct *= factor
    why = [note]
    if tier != "league-winner" and pct > 0.30:
        pct = 0.30
        why.append("capped at 30% of remaining — only a league-winner role justifies more")
    if tier != "league-winner" and week <= 4:
        pct = min(pct, 0.25)
    bid = max(1, round(pct * remaining))
    if trend_rank and trend_rank <= 5:
        why.append(f"#{trend_rank} most-added player right now — expect competition, bid the top of the tier")
    elif trend_rank and trend_rank <= 20:
        why.append(f"#{trend_rank} most-added — moderate competition")
    return {"bid": bid, "pct": round(pct, 3), "why": why}


def _eligible_slots(pos: str) -> set[str]:
    return {slot for slot, elig in SLOT_ELIGIBILITY.items() if pos in elig}


def analyze(
    my_players: list[dict],
    candidates: list[dict],
    slots: list[str],
    week: int,
    faab: dict,
    waiver_position: int | None,
    limit: int = 15,
) -> dict:
    """
    my_players / candidates rows: {name, pos, team, aav (weekly blend),
    season, injury, trend_rank, trend_count, pct_owned, pct_change, ...}.
    """
    starters, bench = optimal_lineup(my_players, slots)
    bars: dict[str, dict | None] = {}
    for pos in ("QB", "RB", "WR", "TE", "K", "DST"):
        slot_set = _eligible_slots(pos)
        pool = [s for s in starters if s["slot"] in slot_set]
        bars[pos] = min(pool, key=lambda s: s["aav"] or 0) if pool else None

    def best_bench(pos: str):
        b = [p for p in bench if p["pos"] == pos]
        return max(b, key=lambda p: p.get("season") or 0) if b else None

    droppable = [p for p in bench if p["pos"] not in STREAMERS]
    drop = min(droppable, key=lambda p: (p.get("season") or 0)) if droppable else None

    league_slots = set(slots)
    out = []
    for c in candidates:
        pos = c["pos"]
        if not (_eligible_slots(pos) & league_slots):
            continue  # position can't start in this league (e.g. no K slot)
        bar = bars.get(pos)
        bar_wk = (bar["aav"] or 0) if bar else 0.0
        delta_wk = round((c["aav"] or 0) - bar_wk, 1)
        bb = best_bench(pos)
        depth_delta = round((c.get("season") or 0) - ((bb.get("season") or 0) if bb else 0), 1)
        trend_rank = c.get("trend_rank")
        hot = bool(trend_rank and trend_rank <= 20)

        if pos in STREAMERS:
            tier = "streamer" if delta_wk > 0 else "pass"
        elif delta_wk >= 5 and pos in ("RB", "WR") and (c.get("season") or 0) >= (bar.get("season") or 0 if bar else 0):
            tier = "league-winner"
        elif delta_wk >= 2:
            tier = "starter"
        # Upside money is for players who beat your bar today, or are hot
        # (the market sees a role coming) AND add depth/sit near the bar.
        # A backup QB/TE nobody is adding is not a waiver story — pass.
        elif delta_wk > 0 or (hot and (depth_delta > 0 or delta_wk > -3)):
            tier = "upside"
        else:
            tier = "pass"

        verdict = {
            "league-winner": f"Starts for you now (+{delta_wk}/wk over {bar['name'] if bar else 'an empty slot'}) with a real role — league-winner tier",
            "starter": f"Weekly starter upgrade: +{delta_wk} over {bar['name'] if bar else 'an empty slot'}",
            "upside": ("Depth upgrade" + (f" over {bb['name']}" if bb else "")) if depth_delta > 0 else "Near your bar — worth a cheap flier",
            "streamer": f"Streaming option this week (+{delta_wk} over {bar['name'] if bar else 'an empty slot'})",
            "pass": "Doesn't beat what you have",
        }[tier]

        bid = recommend_bid(tier, faab.get("remaining", 0), week, trend_rank) if faab.get("enabled") else None
        priority = None
        if not faab.get("enabled"):
            if tier in ("league-winner", "starter"):
                priority = f"Use your waiver priority{f' (#{waiver_position})' if waiver_position else ''} — a starter is worth burning it"
            elif tier in ("upside", "streamer"):
                priority = "Don't burn priority — grab in free agency if he clears"
            else:
                priority = "Pass"

        out.append({
            **c,
            "delta_wk": delta_wk,
            "bar": {"name": bar["name"], "wk": bar["aav"], "slot": bar["slot"]} if bar else None,
            "depth_delta": depth_delta,
            "tier": tier,
            "verdict": verdict,
            "faab": bid,
            "priority_advice": priority,
        })

    score = lambda r: (
        {"league-winner": 4, "starter": 3, "upside": 2, "streamer": 1, "pass": 0}[r["tier"]],
        r["delta_wk"],
        -(r.get("trend_rank") or 999),
    )
    out.sort(key=score, reverse=True)
    keep = [r for r in out if r["tier"] != "pass"][:limit]
    keep += [r for r in out if r["tier"] == "pass"][:10]
    out = keep
    return {
        "week": week,
        "faab": faab,
        "waiver_position": waiver_position,
        "season_note": season_factor(week)[1],
        "bars": {p: ({"name": b["name"], "wk": b["aav"]} if b else None) for p, b in bars.items()},
        "drop": {"name": drop["name"], "pos": drop["pos"], "season": drop.get("season")} if drop else None,
        "candidates": out,
    }


def _row(name: str, pos: str, v: dict | None, week: int, slpr: dict | None, skey: str,
         vegas: dict, trend: dict | None) -> dict:
    espn_wk = _wk_proj(v, week)
    slpr_wk = slpr.get(skey) if slpr else None
    team = (v or {}).get("team") or ""
    return {
        "name": name,
        "pos": pos,
        "team": team,
        "aav": blend(espn_wk, slpr_wk),
        "espn_proj": espn_wk,
        "slpr_proj": slpr_wk,
        "season": (v or {}).get("proj"),
        "injury": (v or {}).get("injury") or "",
        "pct_owned": (v or {}).get("pct_owned"),
        "pct_change": (v or {}).get("pct_change"),
        "start_pct": (v or {}).get("start_pct"),
        "trend_rank": (trend or {}).get("rank"),
        "trend_count": (trend or {}).get("count"),
        **(vegas.get(team) or {}),
    }


def waivers_sleeper(league_id: str, season: int, user_id: str, roster_id: int | None = None) -> dict:
    from app.ingestion.sleeper import SleeperClient

    conn = get_connection()
    try:
        week = current_nfl_week()
        values = fetch_auction_values(conn, season)
        xwalk = _sleeper_to_espn(conn)
        rev = {v: k for k, v in xwalk.items()}
        dst = _dst_espn_id_by_abbrev()
        rev.update({v: k for k, v in dst.items()})
        client = SleeperClient(conn)
        league = client.get_league(league_id)
        rosters = client.get_league_rosters(league_id)
        all_players = client.get_all_players()
        trending = fetch_trending(conn)
        vegas = fetch_vegas(conn, week)
        sproj = fetch_sleeper_projections(conn, season, week)
        rec = float((league.get("scoring_settings") or {}).get("rec") or 0)
        skey = "ppr" if rec >= 1 else ("half_ppr" if rec >= 0.5 else "std")

        mine = next(
            (r for r in rosters
             if (roster_id is not None and r.get("roster_id") == roster_id)
             or (roster_id is None and str(r.get("owner_id")) == str(user_id))),
            None,
        )
        if mine is None:
            raise ValueError("no roster for this user in that league")
        taken = {str(p) for r in rosters for p in (r.get("players") or [])}
        slots = [s for s in (league.get("roster_positions") or []) if s != "BN"]
        s = league.get("settings") or {}
        budget = int(s.get("waiver_budget") or 0)
        used = int((mine.get("settings") or {}).get("waiver_budget_used") or 0)
        faab = {"enabled": int(s.get("waiver_type") or 0) == 2 and budget > 0,
                "budget": budget, "used": used, "remaining": max(0, budget - used)}
        wpos = (mine.get("settings") or {}).get("waiver_position")

        def mk(sid: str) -> dict | None:
            eid = xwalk.get(sid) or dst.get(sid)
            v = values.get(eid) if eid else None
            meta = all_players.get(sid) or {}
            pos = (v or {}).get("pos") or meta.get("position") or "?"
            pos = "DST" if pos == "DEF" else pos
            name = (v or {}).get("name") or f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip() or sid
            return _row(name, pos, v, week, sproj.get(sid), skey, vegas, trending.get(sid))

        my_players = [mk(str(p)) for p in (mine.get("players") or [])]
        cands = []
        for eid, v in values.items():
            sid = rev.get(eid)
            if not sid or sid in taken or v["pos"] not in ("QB", "RB", "WR", "TE", "K", "DST"):
                continue
            tr = trending.get(sid)
            if not tr and (v.get("weeks") or {}).get(str(week), 0) < 5:
                continue  # neither popular nor projectable — not a waiver story
            cands.append(_row(v["name"], v["pos"], v, week, sproj.get(sid), skey, vegas, tr))
        out = analyze(my_players, cands, slots, week, faab, wpos)
        out["league"] = league.get("name")
        out["platform"] = "sleeper"
        return out
    finally:
        conn.close()


def waivers_espn(league_id: str, season: int, team_id: int) -> dict:
    from app.api.espn import LM_API, _espn_cookies

    conn = get_connection()
    try:
        week = current_nfl_week()
        values = fetch_auction_values(conn, season)
        xwalk = _sleeper_to_espn(conn)
        rev = {v: k for k, v in xwalk.items()}
        rev.update({v: k for k, v in _dst_espn_id_by_abbrev().items()})
        trending = fetch_trending(conn)
        vegas = fetch_vegas(conn, week)
        sproj = fetch_sleeper_projections(conn, season, week)
        url = (f"{LM_API}/seasons/{season}/segments/0/leagues/{league_id}"
               "?view=mSettings&view=mTeam&view=mRoster")
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
        acq = settings.get("acquisitionSettings") or {}
        team = next((t for t in data.get("teams") or [] if t.get("id") == team_id), None)
        if team is None:
            raise ValueError(f"team {team_id} not in league")
        budget = int(acq.get("acquisitionBudget") or 0)
        used = int(((team.get("transactionCounter") or {}).get("acquisitionBudgetSpent")) or 0)
        faab = {"enabled": bool(acq.get("isUsingAcquisitionBudget")) and budget > 0,
                "budget": budget, "used": used, "remaining": max(0, budget - used)}
        wpos = team.get("waiverRank")

        taken = set()
        my_players = []
        for t in data.get("teams") or []:
            for entry in ((t.get("roster") or {}).get("entries")) or []:
                p = (entry.get("playerPoolEntry") or {}).get("player") or {}
                eid = str(p.get("id"))
                taken.add(eid)
                if t.get("id") == team_id:
                    v = values.get(eid)
                    pos = (v or {}).get("pos") or ESPN_POS.get(p.get("defaultPositionId"), "?")
                    sid = rev.get(eid)
                    my_players.append(_row(p.get("fullName") or eid, pos, v, week,
                                           sproj.get(sid or ""), "ppr", vegas, trending.get(sid or "")))
        cands = []
        for eid, v in values.items():
            if eid in taken or v["pos"] not in ("QB", "RB", "WR", "TE", "K", "DST"):
                continue
            sid = rev.get(eid)
            tr = trending.get(sid) if sid else None
            if not tr and (v.get("weeks") or {}).get(str(week), 0) < 5:
                continue
            cands.append(_row(v["name"], v["pos"], v, week, sproj.get(sid or ""), "ppr", vegas, tr))
        out = analyze(my_players, cands, slots, week, faab, wpos)
        out["league"] = settings.get("name") or "ESPN League"
        out["platform"] = "espn"
        return out
    finally:
        conn.close()
