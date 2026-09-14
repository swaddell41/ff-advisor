"""GET /api/me/home — the My Leagues home payload."""

from fastapi import APIRouter

from app.api.me import _require_user_id
from app.api.redraft import list_saved_leagues
from app.db import get_connection
from app.home import build_home
from pydantic import BaseModel

from app.live import build_live, median_pref_key
from app.redraft import _cache_get, _cache_set

router = APIRouter()


@router.get("/api/me/home")
def home(season: int = 2026):
    uid = _require_user_id()
    conn = get_connection()
    try:
        leagues = list_saved_leagues(conn, uid)
    finally:
        conn.close()
    return build_home(uid, leagues, season)


@router.get("/api/me/live")
def live(season: int = 2026):
    uid = _require_user_id()
    conn = get_connection()
    try:
        leagues = list_saved_leagues(conn, uid)
    finally:
        conn.close()
    return build_live(uid, leagues, season)


class MedianPref(BaseModel):
    platform: str
    league_id: str
    on: bool


@router.post("/api/me/prefs/median")
def set_median_pref(body: MedianPref):
    """Turn the vs-league-median matchup view on/off for one league."""
    uid = _require_user_id()
    conn = get_connection()
    try:
        key = f"{body.platform}:{body.league_id}"
        cur = set(_cache_get(conn, median_pref_key(uid), 10**9) or [])
        (cur.add if body.on else cur.discard)(key)
        _cache_set(conn, median_pref_key(uid), sorted(cur))
        return {"median": sorted(cur)}
    finally:
        conn.close()
