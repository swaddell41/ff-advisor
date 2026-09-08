"""
My Leagues home: every league the user plays, with the action that matters
this week surfaced on the card.

Per league (computed in parallel, each one failing soft):
  * identity — platform, type (redraft / keeper / dynasty; Sleeper's
    settings.type, or the user's dynasty imports), status, team count.
  * standings — record, points, rank in the league.
  * lineup — this week's points left on the bench + who to start/sit
    (the start/sit engine).
  * waivers — the best non-pass claims and their bid (the waiver engine).
  * dynasty trade prompt — the user's STATED posture (override) or the
    auto-detected one, roster needs vs the league, and standings, turned
    into a buy / sell / hold / reassess nudge with the reasoning.
"""

from concurrent.futures import ThreadPoolExecutor

from app.db import get_connection
from app.lineup import current_nfl_week, lineup_espn, lineup_sleeper
from app.waivers import waivers_espn, waivers_sleeper

SLEEPER_TYPE = {0: "redraft", 1: "keeper", 2: "dynasty"}


def trade_prompt(posture: str, wins: int, losses: int, rank: int | None, teams: int,
                 week: int, needs: dict | None) -> dict:
    """Buy / sell / hold / reassess, from stated posture + standings + needs."""
    need_pos = sorted(
        [p for p, d in (needs or {}).items() if d.get("label") in ("need", "slight need")],
        key=lambda p: -(needs[p].get("need_score") or 0),
    )
    surplus = [p for p, d in (needs or {}).items() if d.get("label") in ("surplus", "slight surplus")]
    games = wins + losses
    half = teams / 2 if teams else 6
    early = games < 4
    behind = rank is not None and rank > half
    ahead = rank is not None and rank <= max(1, teams // 3)
    rec = f"{wins}-{losses}"
    where = f"#{rank} of {teams}" if rank else ""

    if week <= 1 and games == 0:
        return {"action": "hold", "text": "Preseason — the trade market re-prices after week 1. Set your goal so this sharpens.",
                "needs": need_pos, "surplus": surplus}
    if posture == "contend":
        if not early and behind:
            return {"action": "reassess", "text": f"Contending but {rec} ({where}) — consolidate 2-for-1 at {need_pos[0] if need_pos else 'your weakest spot'}, or decide to pivot.",
                    "needs": need_pos, "surplus": surplus}
        if need_pos:
            return {"action": "buy", "text": f"Contending and thin at {', '.join(need_pos[:2])} — buy a starter" + (f" using your {'/'.join(surplus[:2])} surplus" if surplus else "") + ".",
                    "needs": need_pos, "surplus": surplus}
        return {"action": "hold", "text": f"Contending, {rec}, no glaring hole — hold unless a counterparty overpays.", "needs": need_pos, "surplus": surplus}
    if posture == "rebuild":
        if not early and ahead:
            return {"action": "reassess", "text": f"Rebuilding but {rec} ({where}) — either sell high into the record or lean in and contend.",
                    "needs": need_pos, "surplus": surplus}
        return {"action": "sell", "text": "Rebuilding — shop productive veterans to contenders for picks and youth" + (f"; your {'/'.join(surplus[:2])} surplus is the inventory" if surplus else "") + ".",
                "needs": need_pos, "surplus": surplus}
    # middling / auto-unknown
    if not early and behind:
        return {"action": "sell", "text": f"{rec} ({where}) and no stated goal — sell productive vets for picks, or declare contend and buy.",
                "needs": need_pos, "surplus": surplus}
    if need_pos and (early or not behind):
        return {"action": "buy", "text": f"In the hunt ({rec}) — a 2-for-1 at {need_pos[0]} could tip it. Set contend/rebuild to firm this up.",
                "needs": need_pos, "surplus": surplus}
    return {"action": "hold", "text": f"{rec} — balanced roster; set your goal (contend / rebuild) to get a sharper prompt.",
            "needs": need_pos, "surplus": surplus}


def _lineup_summary(res: dict) -> dict:
    return {
        "delta": res.get("delta", 0.0),
        "current": res.get("current_total"),
        "optimal": res.get("optimal_total"),
        "start": [p["name"] for p in res.get("start", [])][:3],
        "sit": [p["name"] for p in res.get("sit", [])][:3],
        "flags": [f["name"] for f in res.get("flags", [])][:3],
    }


def _waiver_summary(res: dict) -> dict:
    top = [c for c in res.get("candidates", []) if c["tier"] != "pass"][:3]
    return {
        "faab": res.get("faab"),
        "top": [{"name": c["name"], "pos": c["pos"], "tier": c["tier"],
                 "bid": (c.get("faab") or {}).get("bid"), "delta_wk": c.get("delta_wk")} for c in top],
    }


def _sleeper_card(conn_factory, uid: str, lg: dict, week: int, season: int) -> dict:
    from app.api.me import _get_my_posture
    from app.ingestion.sleeper import SleeperClient
    from app.profiles.engine import compute_positional_needs

    conn = conn_factory()
    try:
        client = SleeperClient(conn)
        league = client.get_league(lg["league_id"])
        rosters = client.get_league_rosters(lg["league_id"])
        s = league.get("settings") or {}
        ltype = "dynasty" if lg.get("dynasty") else SLEEPER_TYPE.get(int(s.get("type") or 0), "redraft")
        mine = next((r for r in rosters if str(r.get("owner_id")) == str(uid)), None)
        standings = sorted(
            rosters,
            key=lambda r: (-int((r.get("settings") or {}).get("wins") or 0),
                           -float((r.get("settings") or {}).get("fpts") or 0)),
        )
        rank = next((i + 1 for i, r in enumerate(standings) if r is mine), None)
        ms = (mine or {}).get("settings") or {}
        wins, losses = int(ms.get("wins") or 0), int(ms.get("losses") or 0)
        card = {
            **lg,
            "type": ltype,
            "status": league.get("status"),
            "teams": league.get("total_rosters"),
            "record": {"wins": wins, "losses": losses, "pts": float(ms.get("fpts") or 0), "rank": rank},
            "url": f"https://sleeper.com/leagues/{lg['league_id']}/team",
        }
        if league.get("status") in ("in_season", "complete") and mine:
            try:
                card["lineup"] = _lineup_summary(lineup_sleeper(lg["league_id"], season, uid))
            except Exception as e:
                card["lineup_error"] = str(e)
            try:
                card["waivers"] = _waiver_summary(waivers_sleeper(lg["league_id"], season, uid))
            except Exception as e:
                card["waivers_error"] = str(e)
        if ltype == "dynasty":
            posture = _get_my_posture(conn, uid, lg["league_id"])
            is_override = conn.execute(
                "SELECT 1 FROM user_posture_overrides WHERE user_id = ? AND league_id = ?",
                (uid, lg["league_id"]),
            ).fetchone() is not None
            needs = None
            try:
                needs = compute_positional_needs(conn, uid, lg["league_id"]).get("needs")
            except Exception:
                pass
            card["dynasty"] = True
            card["posture"] = {"value": posture, "is_override": is_override}
            card["trade"] = trade_prompt(posture, wins, losses, rank, league.get("total_rosters") or 0, week, needs)
        return card
    finally:
        conn.close()


def _espn_card(lg: dict, week: int, season: int) -> dict:
    from app.api.espn import _fetch_league

    data = _fetch_league(lg["league_id"], season)
    settings = data.get("settings") or {}
    dd = data.get("draftDetail") or {}
    team_id = int(lg.get("team_id") or 0) or None
    team = next((t for t in data.get("teams") or [] if t.get("id") == team_id), None)
    rec = ((team or {}).get("record") or {}).get("overall") or {}
    card = {
        **lg,
        "type": "redraft",
        "status": "in_season" if dd.get("drafted") else ("drafting" if dd.get("inProgress") else "pre_draft"),
        "teams": settings.get("size"),
        "name": settings.get("name") or lg.get("name"),
        "record": {"wins": int(rec.get("wins") or 0), "losses": int(rec.get("losses") or 0),
                   "pts": float(rec.get("pointsFor") or 0), "rank": (team or {}).get("playoffSeed")},
        "url": f"https://fantasy.espn.com/football/team?leagueId={lg['league_id']}&teamId={team_id or ''}&seasonId={season}",
    }
    if dd.get("drafted") and team_id:
        try:
            card["lineup"] = _lineup_summary(lineup_espn(lg["league_id"], season, team_id))
        except Exception as e:
            card["lineup_error"] = str(e)
        try:
            card["waivers"] = _waiver_summary(waivers_espn(lg["league_id"], season, team_id))
        except Exception as e:
            card["waivers_error"] = str(e)
    return card


def build_home(uid: str, leagues: list[dict], season: int = 2026) -> dict:
    week = current_nfl_week()

    def one(lg: dict) -> dict:
        try:
            if lg["platform"] == "espn":
                return _espn_card(lg, week, season)
            return _sleeper_card(get_connection, uid, lg, week, season)
        except Exception as e:
            return {**lg, "type": "dynasty" if lg.get("dynasty") else "redraft", "error": str(e)}

    with ThreadPoolExecutor(max_workers=6) as ex:
        cards = list(ex.map(one, leagues))
    order = {"dynasty": 1, "keeper": 0, "redraft": 0}
    cards.sort(key=lambda c: (order.get(c.get("type"), 0), -((c.get("lineup") or {}).get("delta") or 0)))
    return {
        "week": week,
        "leagues": cards,
        "attention": {
            "lineups": sum(1 for c in cards if ((c.get("lineup") or {}).get("delta") or 0) > 0.5),
            "waivers": sum(1 for c in cards if (c.get("waivers") or {}).get("top")),
            "trades": sum(1 for c in cards if (c.get("trade") or {}).get("action") in ("buy", "sell", "reassess")),
        },
    }
