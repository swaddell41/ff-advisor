"""
Personal dashboard API routes — all scoped to the SLEEPER_USER_ID from .env.

GET  /api/me                              — my user info + league memberships
GET  /api/me/dashboard                    — aggregate stats, bias highlights, recent trades
GET  /api/leagues/{league_id}/trade-targets  — ranked trade partner list for a league
GET  /api/leagues/{league_id}/my-posture  — my auto-detected posture (with override check)
POST /api/leagues/{league_id}/my-posture  — store a posture override
"""

from __future__ import annotations

import logging
import os
from datetime import date

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.acquire import acquisition_report
from app.auth import current_session_user
from app.db import get_connection
from app.deals import evaluate_deal
from app.player_news import player_card
from app.refresh import data_freshness, refresh_current_leagues
from app.sell import my_assets, sell_report
from app.profiles.engine import (
    _get_manager_trades,
    classify_posture,
    compute_age_biases,
    compute_differential_stats,
    compute_position_biases,
    compute_positional_needs,
    compute_posture_patterns,
    get_league_family_ids,
    score_trade_targets,
    _ensure_graded,
)

logger = logging.getLogger(__name__)
router = APIRouter()

MY_USER_ID = os.environ.get("SLEEPER_USER_ID", "")


def _conn():
    return get_connection()


def _require_user_id():
    """Session user when signed in; .env fallback keeps local dev working."""
    session_uid = current_session_user.get()
    if session_uid:
        return session_uid
    if not MY_USER_ID:
        raise HTTPException(
            status_code=401,
            detail="Not signed in (and no SLEEPER_USER_ID fallback set)",
        )
    return MY_USER_ID


# ---------------------------------------------------------------------------
# GET /api/me
# ---------------------------------------------------------------------------

@router.get("/api/me")
def get_me():
    uid = _require_user_id()
    conn = _conn()
    try:
        manager = conn.execute(
            "SELECT user_id, username, display_name FROM managers WHERE user_id = ?",
            (uid,),
        ).fetchone()

        leagues = conn.execute(
            """
            SELECT lm.league_id, lm.roster_id, l.name, l.season, l.format_key
            FROM league_managers lm
            JOIN leagues l ON l.id = lm.league_id
            WHERE lm.user_id = ?
            ORDER BY l.season DESC
            """,
            (uid,),
        ).fetchall()

        return {
            "user_id": uid,
            "username": manager["username"] if manager else uid,
            "display_name": manager["display_name"] if manager else uid,
            "leagues": [dict(r) for r in leagues],
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/me/dashboard
# ---------------------------------------------------------------------------

@router.get("/api/me/dashboard")
def get_dashboard():
    """
    Aggregate dashboard data for the logged-in user.

    Returns:
    - overall_stats: win rate, avg differential, total trades across ALL leagues
    - bias_highlights: top 3 actionable bias patterns (worst position + age biases)
    - recent_trades: last 15 trades across all leagues with grades and asset info
    - leagues: list of leagues I'm in (for trade targets section)
    """
    uid = _require_user_id()
    conn = _conn()
    try:
        # All my leagues
        league_rows = conn.execute(
            """
            SELECT lm.league_id, l.name, l.season, l.format_key
            FROM league_managers lm
            JOIN leagues l ON l.id = lm.league_id
            WHERE lm.user_id = ?
            ORDER BY l.season DESC
            """,
            (uid,),
        ).fetchall()

        all_league_ids = [r["league_id"] for r in league_rows]

        if not all_league_ids:
            return {
                "overall_stats": None,
                "bias_highlights": [],
                "recent_trades": [],
                "leagues": [],
            }

        _ensure_graded(conn, all_league_ids)

        # All my trades across all leagues
        all_trades = _get_manager_trades(conn, uid, all_league_ids)

        # Overall stats
        diff_stats = compute_differential_stats(all_trades)
        pos_biases = compute_position_biases(all_trades)
        age_biases = compute_age_biases(all_trades)

        # Bias highlights — pick the 3 most notable patterns
        highlights = _extract_bias_highlights(pos_biases, age_biases)

        # Recent trades — last 15 with full context
        recent = _build_recent_trades(conn, all_trades[:15])

        # League summaries for trade targets section
        # Group leagues by family so we show one entry per franchise
        seen_families: set[str] = set()
        league_summaries = []
        for r in league_rows:
            family = frozenset(get_league_family_ids(conn, r["league_id"]))
            family_key = min(family)  # stable key
            if family_key in seen_families:
                continue
            seen_families.add(family_key)

            # Get my posture for this league (override or auto-detected)
            my_posture = _get_my_posture(conn, uid, r["league_id"])
            league_summaries.append({
                "league_id": r["league_id"],
                "name": r["name"],
                "format_key": r["format_key"],
                "my_posture": my_posture,
            })

        return {
            "user_id": uid,
            "overall_stats": diff_stats,
            "bias_highlights": highlights,
            "recent_trades": recent,
            "leagues": league_summaries,
        }
    finally:
        conn.close()


def _extract_bias_highlights(pos_biases: dict, age_biases: dict) -> list[dict]:
    """
    Extract the top 3 most notable bias patterns as plain-language highlights.
    Prioritises the most extreme (most negative) biases.
    """
    candidates: list[dict] = []

    # Position buy biases
    for pos, data in pos_biases.items():
        acq = data.get("acquiring", {})
        avg = acq.get("avg_differential")
        n = acq.get("count", 0)
        if avg is not None and n >= 2:
            candidates.append({
                "type": "position_buy",
                "label": f"Buying {pos}s",
                "avg_differential": avg,
                "count": n,
                "wins": acq.get("wins", 0),
                "losses": acq.get("losses", 0),
                "severity": abs(avg),
                "direction": "overpays" if avg < -0.05 else "gets value" if avg > 0.05 else "neutral",
            })

        shed = data.get("shedding", {})
        avg_s = shed.get("avg_differential")
        n_s = shed.get("count", 0)
        if avg_s is not None and n_s >= 2 and avg_s < -0.08:
            candidates.append({
                "type": "position_sell",
                "label": f"Selling {pos}s",
                "avg_differential": avg_s,
                "count": n_s,
                "wins": shed.get("wins", 0),
                "losses": shed.get("losses", 0),
                "severity": abs(avg_s),
                "direction": "undersells",
            })

    # Age buy biases
    for bucket, data in age_biases.items():
        acq = data.get("acquiring", {})
        avg = acq.get("avg_differential")
        n = acq.get("count", 0)
        label = data.get("label", bucket)
        if avg is not None and n >= 2 and abs(avg) > 0.06:
            candidates.append({
                "type": "age_buy",
                "label": f"Buying {label} players",
                "avg_differential": avg,
                "count": n,
                "wins": acq.get("wins", 0),
                "losses": acq.get("losses", 0),
                "severity": abs(avg),
                "direction": "overpays" if avg < -0.05 else "gets value",
            })

    # Sort by severity, take top 3
    candidates.sort(key=lambda c: c["severity"], reverse=True)
    return candidates[:3]


def _build_recent_trades(conn, trades: list[dict]) -> list[dict]:
    """Enrich recent trades with league name, asset names, and lens grades."""
    from app.multi_grade import lens_grades
    from app.pick_conversion import PickResolutionContext

    # One pick resolver per league family — draft parsing isn't free.
    resolvers: dict[str, PickResolutionContext] = {}

    result = []
    for t in trades:
        league_row = conn.execute(
            "SELECT name FROM leagues WHERE id = ?", (t["league_id"],)
        ).fetchone()

        received_names = _asset_labels(t["assets_received"])
        given_names = _asset_labels(t["assets_given"])

        lid = t["league_id"]
        if lid not in resolvers:
            resolvers[lid] = PickResolutionContext(conn, lid)

        result.append({
            "lenses": lens_grades(conn, t["trade_id"], t["roster_id"], resolver=resolvers[lid]),
            "trade_id": t["trade_id"],
            "league_id": t["league_id"],
            "league_name": league_row["name"] if league_row else t["league_id"],
            "season": t["season"],
            "week": t["week"],
            "executed_at": t["executed_at"],
            "decision_grade": t["d_grade"],
            "outcome_grade": t["o_grade"],
            "decision_differential": t["d_diff"],
            "assets_received": received_names,
            "assets_given": given_names,
        })
    return result


def _asset_labels(assets: list[dict]) -> list[str]:
    labels = []
    for a in assets:
        if a["asset_type"] == "player":
            name = a.get("full_name") or a.get("player_id", "?")
            labels.append(name)
        elif a["asset_type"] == "pick":
            labels.append(f"{a['pick_season']} R{a['pick_round']}")
        elif a["asset_type"] == "faab":
            labels.append(f"${a['faab_amount']} FAAB")
    return labels


# ---------------------------------------------------------------------------
# Posture helpers
# ---------------------------------------------------------------------------

def _get_my_posture(conn, user_id: str, league_id: str) -> str:
    """Return override if set, otherwise auto-detect from trade patterns."""
    override = conn.execute(
        "SELECT posture FROM user_posture_overrides WHERE user_id = ? AND league_id = ?",
        (user_id, league_id),
    ).fetchone()
    if override:
        return override["posture"]

    # Auto-detect from family-wide trade patterns
    family_ids = get_league_family_ids(conn, league_id)
    trades = _get_manager_trades(conn, user_id, family_ids)
    if not trades:
        return "middling"
    patterns = compute_posture_patterns(trades)
    return classify_posture(patterns)


# ---------------------------------------------------------------------------
# GET /api/leagues/{league_id}/my-posture
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/my-posture")
def get_my_posture(league_id: str):
    uid = _require_user_id()
    conn = _conn()
    try:
        override_row = conn.execute(
            "SELECT posture FROM user_posture_overrides WHERE user_id = ? AND league_id = ?",
            (uid, league_id),
        ).fetchone()
        is_override = override_row is not None

        posture = _get_my_posture(conn, uid, league_id)
        return {
            "league_id": league_id,
            "posture": posture,
            "is_override": is_override,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/leagues/{league_id}/my-posture
# ---------------------------------------------------------------------------

class PostureOverrideRequest(BaseModel):
    posture: str  # 'rebuild' | 'contend' | 'middling' | 'auto'


@router.post("/api/leagues/{league_id}/managers/{target_user_id}/posture")
def set_manager_posture(league_id: str, target_user_id: str, body: PostureOverrideRequest):
    """
    Override the posture label for any manager in the league.
    Accepts the same body as set_my_posture; posture='auto' clears the override.
    """
    if body.posture not in ("rebuild", "contend", "middling", "auto"):
        raise HTTPException(status_code=400, detail="posture must be rebuild|contend|middling|auto")

    conn = _conn()
    try:
        if body.posture == "auto":
            conn.execute(
                "DELETE FROM user_posture_overrides WHERE user_id = ? AND league_id = ?",
                (target_user_id, league_id),
            )
        else:
            conn.execute(
                "INSERT OR REPLACE INTO user_posture_overrides (user_id, league_id, posture) VALUES (?, ?, ?)",
                (target_user_id, league_id, body.posture),
            )
        conn.commit()
        return {"user_id": target_user_id, "league_id": league_id, "posture": body.posture}
    finally:
        conn.close()


@router.post("/api/leagues/{league_id}/my-posture")
def set_my_posture(league_id: str, body: PostureOverrideRequest):
    uid = _require_user_id()
    if body.posture not in ("rebuild", "contend", "middling", "auto"):
        raise HTTPException(status_code=400, detail="posture must be rebuild|contend|middling|auto")

    conn = _conn()
    try:
        if body.posture == "auto":
            # Clear override — revert to auto-detection
            conn.execute(
                "DELETE FROM user_posture_overrides WHERE user_id = ? AND league_id = ?",
                (uid, league_id),
            )
        else:
            conn.execute(
                "INSERT OR REPLACE INTO user_posture_overrides (user_id, league_id, posture) VALUES (?, ?, ?)",
                (uid, league_id, body.posture),
            )
        conn.commit()
        posture = _get_my_posture(conn, uid, league_id)
        return {"league_id": league_id, "posture": posture, "is_override": body.posture != "auto"}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/me/roster-needs/{league_id}
# ---------------------------------------------------------------------------

@router.get("/api/me/roster-needs/{league_id}")
def get_roster_needs(league_id: str):
    """
    Return my positional value vs league average for a league.
    Used to render the roster needs bar chart on the dashboard.
    """
    uid = _require_user_id()
    conn = _conn()
    try:
        needs = compute_positional_needs(conn, uid, league_id)
        # Strip all_managers (large, not needed by the frontend needs chart)
        needs.pop("all_managers", None)
        return {"league_id": league_id, **needs}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/leagues/{league_id}/acquire/{position}
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/acquire/{position}")
def get_acquisition_report(league_id: str, position: str):
    """
    "I want to acquire a {position} in this league" — ranked source managers
    with player-level detail and suggested packages.
    """
    uid = _require_user_id()
    conn = _conn()
    try:
        league = conn.execute(
            "SELECT id FROM leagues WHERE id = ?", (league_id,)
        ).fetchone()
        if not league:
            raise HTTPException(status_code=404, detail=f"League {league_id} not found")
        try:
            return acquisition_report(conn, uid, league_id, position)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Player card (identity + values + news)
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/players/{player_id}/card")
def get_player_card(league_id: str, player_id: str):
    conn = _conn()
    try:
        card = player_card(conn, league_id, player_id)
        if card is None:
            raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
        return card
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Data freshness / refresh
# ---------------------------------------------------------------------------

@router.get("/api/freshness")
def get_freshness():
    conn = _conn()
    try:
        return data_freshness(conn)
    finally:
        conn.close()


@router.post("/api/refresh")
def post_refresh():
    """Re-pull rosters, current-season trades, and traded picks; grade new trades."""
    conn = _conn()
    try:
        summary = refresh_current_leagues(conn)
        return {**summary, **data_freshness(conn)}
    finally:
        conn.close()


@router.get("/api/cron/daily")
def cron_daily(request: Request):
    """
    Daily job for Vercel Cron: refresh league data, then snapshot values.
    Protected by CRON_SECRET when set (Vercel sends it as a Bearer token).
    """
    secret = os.environ.get("CRON_SECRET")
    if secret and request.headers.get("authorization") != f"Bearer {secret}":
        raise HTTPException(status_code=401, detail="Bad cron secret")

    from app.grading.engine import grade_all
    from app.snapshots import run_value_snapshots

    conn = _conn()
    try:
        refresh_summary = refresh_current_leagues(conn)
        snapshot_summary = run_value_snapshots(conn)
        # Re-grade everything so stored OUTCOME grades track today's values —
        # hindsight is supposed to move as players prove out. Idempotent.
        regraded = grade_all(conn)
        return {
            "refresh": refresh_summary,
            "snapshots": snapshot_summary,
            "regraded_leagues": len(regraded),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Sell tool
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/my-assets")
def get_my_assets(league_id: str):
    """Everything I could sell in this league: roster players + future picks."""
    uid = _require_user_id()
    conn = _conn()
    try:
        return my_assets(conn, uid, league_id)
    finally:
        conn.close()


@router.get("/api/leagues/{league_id}/sell/player/{player_id}")
def get_sell_player(league_id: str, player_id: str):
    """Ranked buyers for one of my players."""
    uid = _require_user_id()
    conn = _conn()
    try:
        try:
            return sell_report(conn, uid, league_id, {"type": "player", "player_id": player_id})
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
    finally:
        conn.close()


@router.get("/api/leagues/{league_id}/managers/{target_user_id}/assets")
def get_manager_assets(league_id: str, target_user_id: str):
    """A counterparty's tradable assets — used by the deal builder."""
    conn = _conn()
    try:
        return my_assets(conn, target_user_id, league_id)
    finally:
        conn.close()


class AssetRef(BaseModel):
    type: str  # 'player' | 'pick'
    player_id: str | None = None
    season: int | None = None
    round: int | None = None


class DealEvaluateRequest(BaseModel):
    counterparty_user_id: str
    my_assets: list[AssetRef] = []
    their_assets: list[AssetRef] = []


@router.post("/api/leagues/{league_id}/deals/evaluate")
def post_evaluate_deal(league_id: str, body: DealEvaluateRequest):
    """Live evaluation of a working trade against the counterparty's demonstrated prices."""
    uid = _require_user_id()
    conn = _conn()
    try:
        return evaluate_deal(
            conn, uid, league_id,
            body.counterparty_user_id,
            [a.model_dump() for a in body.my_assets],
            [a.model_dump() for a in body.their_assets],
        )
    finally:
        conn.close()


@router.get("/api/leagues/{league_id}/sell/pick/{season}/{round_num}")
def get_sell_pick(league_id: str, season: int, round_num: int):
    """Ranked buyers for one of my future picks."""
    uid = _require_user_id()
    conn = _conn()
    try:
        return sell_report(
            conn, uid, league_id, {"type": "pick", "season": season, "round": round_num}
        )
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/leagues/{league_id}/trade-targets
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/trade-targets")
def get_trade_targets(league_id: str):
    uid = _require_user_id()
    conn = _conn()
    try:
        league = conn.execute(
            "SELECT name FROM leagues WHERE id = ?", (league_id,)
        ).fetchone()
        if not league:
            raise HTTPException(status_code=404, detail=f"League {league_id} not found")

        my_posture = _get_my_posture(conn, uid, league_id)
        # Compute positional needs once and pass into scoring to avoid double work
        positional_needs = compute_positional_needs(conn, uid, league_id)
        targets = score_trade_targets(
            conn, uid, league_id,
            my_posture=my_posture,
            positional_needs=positional_needs,
        )
        # Return needs summary (without all_managers) alongside targets
        needs_summary = {k: v for k, v in positional_needs.items() if k != "all_managers"}

        return {
            "league_id": league_id,
            "league_name": league["name"],
            "my_posture": my_posture,
            "positional_needs": needs_summary,
            "targets": targets,
        }
    finally:
        conn.close()
