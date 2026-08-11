"""
League and trade API routes.

GET  /api/leagues                          — list all ingested leagues
GET  /api/leagues/{league_id}/trades       — paginated trade list with grades
GET  /api/trades/{trade_id}               — full trade detail
POST /api/grading/recompute               — re-run grading for league or trade
"""

from __future__ import annotations

import json
import logging
from datetime import date

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.db import get_connection
from app.grading.engine import grade_all, grade_league, grade_trade
from app.value_sources import RosterAuditValueSource

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _conn():
    conn = get_connection()
    conn.row_factory = __import__("sqlite3").Row
    return conn


def _grade_label_color(grade: str | None) -> str:
    if not grade:
        return "neutral"
    if grade in ("A+", "A", "A-"):
        return "green"
    if grade in ("B+", "B", "B-"):
        return "yellow"
    return "red"


def _format_asset(row) -> dict:
    if row["asset_type"] == "player":
        return {
            "type": "player",
            "player_id": row["player_id"],
            "name": row["full_name"] or row["player_id"],
            "position": row["position"],
        }
    elif row["asset_type"] == "pick":
        slot_label = f"{row['pick_season']} {_round_ordinal(row['pick_round'])}"
        return {
            "type": "pick",
            "pick_season": row["pick_season"],
            "pick_round": row["pick_round"],
            "label": slot_label,
        }
    else:
        return {
            "type": "faab",
            "amount": row["faab_amount"],
            "label": f"${row['faab_amount']} FAAB",
        }


def _round_ordinal(n: int) -> str:
    suffixes = {1: "1st", 2: "2nd", 3: "3rd"}
    return suffixes.get(n, f"{n}th")


# ---------------------------------------------------------------------------
# GET /api/leagues
# ---------------------------------------------------------------------------

@router.get("/api/leagues")
def list_leagues():
    conn = _conn()
    try:
        rows = conn.execute(
            """
            SELECT l.id, l.name, l.season, l.format_key,
                   COUNT(DISTINCT t.id) as trade_count
            FROM leagues l
            LEFT JOIN trades t ON t.league_id = l.id
            GROUP BY l.id
            ORDER BY l.name, l.season DESC
            """
        ).fetchall()

        # Group seasons under each league name
        by_name: dict[str, dict] = {}
        for r in rows:
            name = r["name"] or r["id"]
            if name not in by_name:
                by_name[name] = {
                    "name": name,
                    "format_key": r["format_key"],
                    "seasons": [],
                }
            by_name[name]["seasons"].append({
                "league_id": r["id"],
                "season": r["season"],
                "trade_count": r["trade_count"],
            })

        return {"leagues": list(by_name.values())}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/leagues/{league_id}/trades
# ---------------------------------------------------------------------------

@router.get("/api/leagues/{league_id}/trades")
def list_trades(
    league_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    season: int | None = Query(None),
):
    conn = _conn()
    try:
        # Check league exists
        league = conn.execute(
            "SELECT id, name, season, format_key FROM leagues WHERE id = ?",
            (league_id,),
        ).fetchone()
        if not league:
            raise HTTPException(status_code=404, detail=f"League {league_id} not found")

        # Check if any grades exist; trigger recompute if not
        grade_count = conn.execute(
            """
            SELECT COUNT(*) FROM trade_grades tg
            JOIN trades t ON t.id = tg.trade_id
            WHERE t.league_id = ?
            """,
            (league_id,),
        ).fetchone()[0]

        if grade_count == 0:
            logger.info("No grades found for league %s — computing now", league_id)
            source = RosterAuditValueSource(conn)
            grade_league(conn, league_id, source)

        season_filter = "AND t.season = :season" if season else ""
        offset = (page - 1) * page_size

        trades = conn.execute(
            f"""
            SELECT t.id, t.season, t.week, t.executed_at,
                   t.league_id
            FROM trades t
            WHERE t.league_id = :league_id
            {season_filter}
            ORDER BY t.executed_at DESC
            LIMIT :limit OFFSET :offset
            """,
            {"league_id": league_id, "season": season, "limit": page_size, "offset": offset},
        ).fetchall()

        total = conn.execute(
            f"""
            SELECT COUNT(*) FROM trades t
            WHERE t.league_id = :league_id {season_filter}
            """,
            {"league_id": league_id, "season": season},
        ).fetchone()[0]

        result = []
        for trade in trades:
            tid = trade["id"]
            result.append(_build_trade_summary(conn, tid, trade))

        return {
            "league_id": league_id,
            "league_name": league["name"],
            "format_key": league["format_key"],
            "total": total,
            "page": page,
            "page_size": page_size,
            "trades": result,
        }
    finally:
        conn.close()


def _build_trade_summary(conn, trade_id: str, trade_row) -> dict:
    sides = conn.execute(
        """
        SELECT ts.roster_id, ts.user_id,
               m.display_name, m.username
        FROM trade_sides ts
        LEFT JOIN managers m ON m.user_id = ts.user_id
        WHERE ts.trade_id = ?
        """,
        (trade_id,),
    ).fetchall()

    sides_out = []
    for side in sides:
        rid = side["roster_id"]

        assets = conn.execute(
            """
            SELECT ta.*, p.full_name, p.position
            FROM trade_assets ta
            LEFT JOIN players p ON p.sleeper_id = ta.player_id
            WHERE ta.trade_id = ? AND ta.to_roster_id = ?
            """,
            (trade_id, rid),
        ).fetchall()

        grades = conn.execute(
            """
            SELECT grade_type, total_value_received, total_value_given,
                   differential, letter_grade, used_value_fallback
            FROM trade_grades
            WHERE trade_id = ? AND side_roster_id = ?
            """,
            (trade_id, rid),
        ).fetchall()

        grade_map = {g["grade_type"]: dict(g) for g in grades}

        sides_out.append({
            "roster_id": rid,
            "user_id": side["user_id"],
            "manager_name": side["display_name"] or side["username"] or side["user_id"],
            "assets_received": [_format_asset(a) for a in assets],
            "decision_grade": grade_map.get("decision"),
            "outcome_grade": grade_map.get("outcome"),
        })

    return {
        "trade_id": trade_id,
        "season": trade_row["season"],
        "week": trade_row["week"],
        "executed_at": trade_row["executed_at"],
        "sides": sides_out,
    }


# ---------------------------------------------------------------------------
# GET /api/trades/{trade_id}
# ---------------------------------------------------------------------------

@router.get("/api/trades/{trade_id}")
def get_trade(trade_id: str):
    conn = _conn()
    try:
        trade = conn.execute(
            "SELECT id, league_id, season, week, executed_at FROM trades WHERE id = ?",
            (trade_id,),
        ).fetchone()
        if not trade:
            raise HTTPException(status_code=404, detail=f"Trade {trade_id} not found")

        # Check grades exist; compute if not
        grade_count = conn.execute(
            "SELECT COUNT(*) FROM trade_grades WHERE trade_id = ?", (trade_id,)
        ).fetchone()[0]
        if grade_count == 0:
            source = RosterAuditValueSource(conn)
            grade_trade(conn, trade_id, source)

        summary = _build_trade_summary(conn, trade_id, trade)

        # Add per-asset values to the detail view
        for side in summary["sides"]:
            rid = side["roster_id"]
            decision_grade = side.get("decision_grade") or {}
            outcome_grade = side.get("outcome_grade") or {}

            # Fetch all assets given by this side with their values
            given_assets = conn.execute(
                """
                SELECT ta.*, p.full_name, p.position
                FROM trade_assets ta
                LEFT JOIN players p ON p.sleeper_id = ta.player_id
                WHERE ta.trade_id = ? AND ta.from_roster_id = ?
                """,
                (trade_id, rid),
            ).fetchall()
            side["assets_given"] = [_format_asset(a) for a in given_assets]

        return summary
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/grading/recompute
# ---------------------------------------------------------------------------

class RecomputeRequest(BaseModel):
    league_id: str | None = None
    trade_id: str | None = None


@router.post("/api/grading/recompute")
def recompute_grades(body: RecomputeRequest):
    conn = _conn()
    try:
        source = RosterAuditValueSource(conn)

        if body.trade_id:
            rows = grade_trade(conn, body.trade_id, source)
            return {"status": "ok", "trade_id": body.trade_id, "grade_rows": rows}

        if body.league_id:
            traded, rows = grade_league(conn, body.league_id, source)
            return {"status": "ok", "league_id": body.league_id, "trades_graded": traded, "grade_rows": rows}

        # Recompute everything
        results = grade_all(conn, source)
        total = sum(results.values())
        return {"status": "ok", "trades_graded": total, "by_league": results}
    finally:
        conn.close()
