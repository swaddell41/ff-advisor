"""Redraft league evaluation — rosters priced at real ESPN auction averages."""

from fastapi import APIRouter, HTTPException

from app.api.me import _require_user_id
from app.redraft import evaluate_espn, evaluate_sleeper

router = APIRouter()


@router.get("/api/redraft/evaluate")
def redraft_evaluate(platform: str, league_id: str, season: int = 2026):
    _require_user_id()
    try:
        if platform == "sleeper":
            return evaluate_sleeper(league_id, season)
        if platform == "espn":
            return evaluate_espn(league_id, season)
    except HTTPException:
        raise
    except Exception as e:  # network / bad league id → readable error
        raise HTTPException(status_code=502, detail=str(e))
    raise HTTPException(status_code=400, detail="platform must be sleeper or espn")
