"""Redraft hub API: league evaluation, start/sit, and saved leagues."""

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.api.me import _require_user_id
from app.db import get_connection
from app.lineup import lineup_espn, lineup_sleeper
from app.redraft import METHODS, evaluate_espn, evaluate_sleeper
from app.waivers import waivers_espn, waivers_sleeper

router = APIRouter()


@router.get("/api/waivers")
def waivers(platform: str, league_id: str, season: int = 2026,
            roster_id: int | None = None, team_id: int | None = None):
    uid = _require_user_id()
    try:
        if platform == "sleeper":
            return waivers_sleeper(league_id, season, uid, roster_id)
        if platform == "espn":
            if team_id is None:
                raise ValueError("team_id required for ESPN (pick your team)")
            return waivers_espn(league_id, season, team_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    raise HTTPException(status_code=400, detail="platform must be sleeper or espn")


@router.get("/api/lineup")
def lineup(platform: str, league_id: str, season: int = 2026,
           roster_id: int | None = None, team_id: int | None = None):
    uid = _require_user_id()
    try:
        if platform == "sleeper":
            return lineup_sleeper(league_id, season, uid, roster_id)
        if platform == "espn":
            if team_id is None:
                raise ValueError("team_id required for ESPN (pick your team)")
            return lineup_espn(league_id, season, team_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    raise HTTPException(status_code=400, detail="platform must be sleeper or espn")


class SavedLeague(BaseModel):
    platform: str
    league_id: str
    season: int = 2026
    name: str = ""
    team_id: str = ""


@router.get("/api/me/saved-leagues")
def saved_leagues():
    uid = _require_user_id()
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT platform, league_id, season, name, team_id FROM saved_leagues "
            "WHERE sleeper_user_id = ? ORDER BY added_at DESC",
            (uid,),
        ).fetchall()
        out = [
            {"platform": r[0], "league_id": r[1], "season": r[2], "name": r[3], "team_id": r[4] or ""}
            for r in rows
        ]
        # Dynasty leagues the user imported are leagues too — lineups and
        # waivers apply to them just the same, so they join the chips.
        seen = {(o["platform"], o["league_id"]) for o in out}
        dyn = conn.execute(
            "SELECT ul.league_id, l.name, l.season FROM user_leagues ul "
            "LEFT JOIN leagues l ON l.id = ul.league_id WHERE ul.sleeper_user_id = ?",
            (uid,),
        ).fetchall()
        for lid, name, season in dyn:
            if ("sleeper", str(lid)) in seen:
                continue
            out.append({"platform": "sleeper", "league_id": str(lid), "season": season or 2026,
                        "name": name or str(lid), "team_id": "", "dynasty": True})
        return out
    finally:
        conn.close()


@router.post("/api/me/saved-leagues")
def save_league(body: SavedLeague):
    uid = _require_user_id()
    if body.platform not in ("sleeper", "espn"):
        raise HTTPException(status_code=400, detail="platform must be sleeper or espn")
    conn = get_connection()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO saved_leagues "
            "(sleeper_user_id, platform, league_id, season, name, team_id, added_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (uid, body.platform, body.league_id, body.season, body.name, body.team_id,
             datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/api/me/saved-leagues")
def unsave_league(platform: str, league_id: str):
    uid = _require_user_id()
    conn = get_connection()
    try:
        conn.execute(
            "DELETE FROM saved_leagues WHERE sleeper_user_id = ? AND platform = ? AND league_id = ?",
            (uid, platform, league_id),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/api/redraft/evaluate")
def redraft_evaluate(platform: str, league_id: str, season: int = 2026, method: str = "auction"):
    _require_user_id()
    if method not in METHODS:
        raise HTTPException(status_code=400, detail=f"method must be one of {sorted(METHODS)}")
    try:
        if platform == "sleeper":
            return evaluate_sleeper(league_id, season, method)
        if platform == "espn":
            return evaluate_espn(league_id, season, method)
    except HTTPException:
        raise
    except Exception as e:  # network / bad league id → readable error
        raise HTTPException(status_code=502, detail=str(e))
    raise HTTPException(status_code=400, detail="platform must be sleeper or espn")
