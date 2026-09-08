"""GET /api/me/home — the My Leagues home payload."""

from fastapi import APIRouter

from app.api.me import _require_user_id
from app.api.redraft import list_saved_leagues
from app.db import get_connection
from app.home import build_home

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
