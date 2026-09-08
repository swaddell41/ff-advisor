"""Redraft league evaluation — rosters priced at real ESPN auction averages."""

from fastapi import APIRouter, HTTPException

from app.api.me import _require_user_id
from app.redraft import METHODS, evaluate_espn, evaluate_sleeper

router = APIRouter()


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
