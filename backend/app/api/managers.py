"""
Manager profile API routes.

GET  /api/leagues/{league_id}/managers           — list all managers with summary stats
GET  /api/leagues/{league_id}/managers/{user_id} — full profile (4 dimensions)
POST /api/managers/{user_id}/scouting_report     — generate / return cached LLM report
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.db import get_connection
from app.profiles.engine import (
    compute_league_profiles,
    compute_profile,
    profile_hash,
)

logger = logging.getLogger(__name__)
router = APIRouter()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# System prompt for scouting reports
SCOUTING_SYSTEM_PROMPT = """You are a dynasty fantasy football scout. Given structured trading \
statistics for a manager, write a 150-word scouting report. Be specific and quantitative — \
reference actual numbers from the data. Do NOT invent patterns not present in the data. \
If the sample size is below 10 trades, lead with a caveat about sample size."""


def _conn():
    return get_connection()


# ---------------------------------------------------------------------------
# GET /api/leagues/{league_id}/managers
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/managers")
def list_managers(
    league_id: str,
    scope: str = Query("family", pattern="^(season|family|all)$"),
):
    conn = _conn()
    try:
        league = conn.execute(
            "SELECT id, name FROM leagues WHERE id = ?", (league_id,)
        ).fetchone()
        if not league:
            raise HTTPException(status_code=404, detail=f"League {league_id} not found")

        summaries = compute_league_profiles(conn, league_id, scope=scope)
        return {
            "league_id": league_id,
            "league_name": league["name"],
            "scope": scope,
            "managers": summaries,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/leagues/{league_id}/managers/{user_id}
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/managers/{user_id}")
def get_manager_profile(
    league_id: str,
    user_id: str,
    scope: str = Query("family", pattern="^(season|family|all)$"),
):
    conn = _conn()
    try:
        profile = compute_profile(conn, user_id, league_id, scope=scope)
        if profile is None:
            raise HTTPException(
                status_code=404,
                detail=f"No trades found for manager {user_id} in league {league_id} (scope={scope})",
            )

        phash = profile_hash(profile)

        # Cache key includes scope so season/family/all each have independent caches
        cache_key = f"{user_id}:{league_id}:{scope}"
        phash_keyed = hashlib.sha256(f"{cache_key}:{phash}".encode()).hexdigest()[:16]

        cached = conn.execute(
            "SELECT report_text, profile_hash FROM scouting_reports WHERE user_id = ? AND league_id = ?",
            (f"{user_id}:{scope}", league_id),
        ).fetchone()

        scouting_report = None
        if cached and cached["profile_hash"] == phash_keyed:
            scouting_report = cached["report_text"]

        return {
            **profile,
            "scouting_report": scouting_report,
            "profile_hash": phash,
            "anthropic_configured": bool(ANTHROPIC_API_KEY),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/managers/{user_id}/scouting_report
# ---------------------------------------------------------------------------

class ScoutingReportRequest(BaseModel):
    league_id: str
    scope: str = "family"


@router.post("/api/managers/{user_id}/scouting_report")
def generate_scouting_report(user_id: str, body: ScoutingReportRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=400,
            detail="ANTHROPIC_API_KEY is not configured. Set it in your .env file.",
        )

    conn = _conn()
    try:
        profile = compute_profile(conn, user_id, body.league_id, scope=body.scope)
        if profile is None:
            raise HTTPException(
                status_code=404,
                detail=f"No trades found for manager {user_id} in league {body.league_id}",
            )

        phash = profile_hash(profile)
        cache_user_key = f"{user_id}:{body.scope}"
        phash_keyed = hashlib.sha256(f"{cache_user_key}:{body.league_id}:{phash}".encode()).hexdigest()[:16]

        # Return cached report if the profile hasn't changed
        cached = conn.execute(
            "SELECT report_text, profile_hash FROM scouting_reports WHERE user_id = ? AND league_id = ?",
            (cache_user_key, body.league_id),
        ).fetchone()
        if cached and cached["profile_hash"] == phash_keyed:
            return {"report": cached["report_text"], "cached": True}

        # Call Anthropic
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

            # Send only the structured profile data — no raw trade JSON
            profile_summary = {k: v for k, v in profile.items() if k not in ("scouting_report",)}
            user_content = json.dumps(profile_summary, indent=2, default=str)

            message = client.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=400,
                system=SCOUTING_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_content}],
            )
            report_text = message.content[0].text

        except ImportError:
            raise HTTPException(
                status_code=500,
                detail="anthropic package not installed. Run: pip install anthropic",
            )
        except Exception as e:
            logger.error("Anthropic API error: %s", e)
            raise HTTPException(status_code=500, detail=f"Anthropic API error: {e}")

        # Cache the report (keyed by user_id:scope so different scopes cache independently)
        conn.execute(
            """
            INSERT OR REPLACE INTO scouting_reports
                (user_id, league_id, profile_hash, report_text, generated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                cache_user_key, body.league_id, phash_keyed, report_text,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()

        return {"report": report_text, "cached": False}
    finally:
        conn.close()
