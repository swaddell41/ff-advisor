"""
Trade grading engine.

For each trade, for each side (roster_id), this module computes:

  decision grade  — values at the week of the trade
  outcome grade   — current (most-recent snapshot) values

Both grades produce:
  - total_value_received
  - total_value_given
  - differential  (received - given)
  - letter_grade  (A+ → F, see GRADE_CUTOFFS)
  - used_value_fallback  (True when no historical snapshot existed and we
                          fell back to the oldest available snapshot)

Differential is expressed as a percentage of the larger side's total value,
which normalises small trades vs. large trades:

    pct = differential / max(received, given)   (0.0 if both sides are 0)

Letter grade buckets — tune GRADE_CUTOFFS to adjust:
    A+  ≥ +25%
    A   +15% to +25%
    A-  +8% to +15%
    B+  +3% to +8%
    B   -3% to +3%  (neutral)
    B-  -3% to -8%
    C   -8% to -15%
    D   -15% to -25%
    F   ≤ -25%

FAAB assets are excluded from value calculations — there is no reliable
way to compare dynasty-value units to FAAB dollars. FAAB is still recorded
in trade_assets and shown in the UI, but does not affect the grade.

Re-grading is idempotent: existing rows in trade_grades are deleted before
each recompute for the affected trades.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from sqlite3 import Connection

from app.value_sources import RosterAuditValueSource

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Grade cutoffs — expressed as decimal fractions of the larger side's total.
# Positive = received more than given (good for this side).
# Tuning: adjust these thresholds to taste.
# ---------------------------------------------------------------------------
GRADE_CUTOFFS: list[tuple[float, str]] = [
    (0.25, "A+"),
    (0.15, "A"),
    (0.08, "A-"),
    (0.03, "B+"),
    (-0.03, "B"),
    (-0.08, "B-"),
    (-0.15, "C"),
    (-0.25, "D"),
    (float("-inf"), "F"),
]


def assign_letter_grade(differential: int, received: int, given: int) -> str:
    """
    Return the letter grade for one side of a trade.

    differential = received - given
    pct = differential / max(received, given)
    """
    larger = max(received, given)
    if larger == 0:
        return "B"  # both sides are 0 — neutral

    pct = differential / larger
    for threshold, grade in GRADE_CUTOFFS:
        if pct >= threshold:
            return grade
    return "F"


# ---------------------------------------------------------------------------
# Core grading logic
# ---------------------------------------------------------------------------

def _parse_trade_date(executed_at: str | None) -> date:
    """
    Parse a Sleeper ISO timestamp string to a date.
    Falls back to today if the string is missing or unparseable.
    """
    if not executed_at:
        return date.today()
    try:
        dt = datetime.fromisoformat(executed_at)
        return dt.date()
    except (ValueError, TypeError):
        return date.today()


def _value_assets_for_roster(
    conn: Connection,
    trade_id: str,
    roster_id: int,
    direction: str,  # "received" | "given"
    fmt: str,
    as_of: date,
    source: RosterAuditValueSource,
) -> tuple[int, bool]:
    """
    Sum the dynasty value of all assets going to (received) or from (given)
    a roster_id in a trade, as of the given date.

    Returns (total_value, used_any_fallback).

    FAAB assets are skipped — no dynasty-value equivalent.
    """
    col = "to_roster_id" if direction == "received" else "from_roster_id"

    rows = conn.execute(
        f"""
        SELECT asset_type, player_id, pick_season, pick_round, faab_amount
        FROM trade_assets
        WHERE trade_id = ? AND {col} = ? AND asset_type != 'faab'
        """,
        (trade_id, roster_id),
    ).fetchall()

    total = 0
    used_fallback = False

    for row in rows:
        if row["asset_type"] == "player":
            val, fallback = source.get_player_value(row["player_id"], fmt, as_of)
            if val is None:
                logger.debug(
                    "No value for player %s in format %s as of %s",
                    row["player_id"], fmt, as_of,
                )
                continue
            total += val
            used_fallback = used_fallback or fallback

        elif row["asset_type"] == "pick":
            val, fallback = source.get_pick_value(
                row["pick_season"], row["pick_round"], fmt, as_of
            )
            if val is None:
                logger.debug(
                    "No value for pick %s.%s in format %s as of %s",
                    row["pick_season"], row["pick_round"], fmt, as_of,
                )
                continue
            total += val
            used_fallback = used_fallback or fallback

    return total, used_fallback


def grade_trade(
    conn: Connection,
    trade_id: str,
    source: RosterAuditValueSource | None = None,
    current_date: date | None = None,
) -> int:
    """
    Grade a single trade and write results to trade_grades.

    Returns the number of side-grade rows written (typically 2, one per side,
    × 2 grade types = 4 rows).

    Idempotent: existing trade_grades rows for this trade_id are deleted first.
    """
    if source is None:
        source = RosterAuditValueSource(conn)
    if current_date is None:
        current_date = date.today()

    # Fetch trade + league format
    trade_row = conn.execute(
        "SELECT league_id, executed_at FROM trades WHERE id = ?", (trade_id,)
    ).fetchone()
    if trade_row is None:
        logger.warning("grade_trade: trade %s not found", trade_id)
        return 0

    league_row = conn.execute(
        "SELECT format_key FROM leagues WHERE id = ?", (trade_row["league_id"],)
    ).fetchone()
    fmt = (league_row["format_key"] if league_row else None) or "sf_ppr"

    trade_date = _parse_trade_date(trade_row["executed_at"])

    # Get all sides
    sides = conn.execute(
        "SELECT roster_id FROM trade_sides WHERE trade_id = ?", (trade_id,)
    ).fetchall()

    if not sides:
        logger.warning("grade_trade: no sides found for trade %s", trade_id)
        return 0

    # Delete existing grades for idempotency
    conn.execute("DELETE FROM trade_grades WHERE trade_id = ?", (trade_id,))

    rows_written = 0
    for side in sides:
        rid = side["roster_id"]

        for grade_type, as_of in [("decision", trade_date), ("outcome", current_date)]:
            received, fallback_r = _value_assets_for_roster(
                conn, trade_id, rid, "received", fmt, as_of, source
            )
            given, fallback_g = _value_assets_for_roster(
                conn, trade_id, rid, "given", fmt, as_of, source
            )

            differential = received - given
            letter = assign_letter_grade(differential, received, given)
            used_fallback = fallback_r or fallback_g

            # For the decision grade, mark as fallback if neither side had
            # a snapshot on or before the trade date (both returned fallback=True
            # means we have no historical data at all for this trade date).
            # For outcome, fallback is always False (current values are fresh).
            if grade_type == "outcome":
                used_fallback = False

            conn.execute(
                """
                INSERT INTO trade_grades
                    (trade_id, side_roster_id, grade_type,
                     total_value_received, total_value_given,
                     differential, letter_grade, used_value_fallback)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trade_id, rid, grade_type,
                    received, given, differential, letter,
                    1 if used_fallback else 0,
                ),
            )
            rows_written += 1

    conn.commit()
    return rows_written


def grade_league(
    conn: Connection,
    league_id: str,
    source: RosterAuditValueSource | None = None,
    current_date: date | None = None,
) -> tuple[int, int]:
    """
    Grade all trades in a league.

    Returns (trades_graded, total_grade_rows).
    """
    if source is None:
        source = RosterAuditValueSource(conn)
    if current_date is None:
        current_date = date.today()

    trade_ids = conn.execute(
        "SELECT id FROM trades WHERE league_id = ?", (league_id,)
    ).fetchall()

    trades_graded = 0
    total_rows = 0
    for row in trade_ids:
        rows = grade_trade(conn, row["id"], source, current_date)
        if rows > 0:
            trades_graded += 1
            total_rows += rows

    logger.info(
        "League %s: graded %d trades (%d grade rows)", league_id, trades_graded, total_rows
    )
    return trades_graded, total_rows


def grade_all(
    conn: Connection,
    source: RosterAuditValueSource | None = None,
    current_date: date | None = None,
) -> dict[str, int]:
    """
    Grade all trades across all leagues in the DB.

    Returns {league_id: trades_graded}.
    """
    if source is None:
        source = RosterAuditValueSource(conn)
    if current_date is None:
        current_date = date.today()

    leagues = conn.execute("SELECT id FROM leagues").fetchall()
    results: dict[str, int] = {}

    for league in leagues:
        lid = league["id"]
        traded, _ = grade_league(conn, lid, source, current_date)
        results[lid] = traded

    return results
