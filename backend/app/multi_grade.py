"""
Multi-lens trade grading, computed at read time for display.

The stored trade_grades table stays RosterAudit-only on purpose — every
manager's bias profile is built from it, and that needs one consistent
price sheet. But a single lens can misrepresent a trade the user made ON
PURPOSE against another lens (buying an injury-recovery player the market
believes in prices as an F on our sheet and a win at market prices).

So for the user's own recent trades we grade through the same three lenses
the deal builder uses:

  ours    — RosterAudit (the stored grade)
  market  — FantasyCalc (real completed trades)
  experts — DynastyProcess (consensus rankings; picks priced at our values,
            same convention as the deal builder)

History honesty: market/experts snapshots only exist from Aug 2026 — for
older trades their "decision" grade is backfilled from the oldest snapshot
we have and flagged estimated=True.
"""

from __future__ import annotations

from datetime import date
from sqlite3 import Connection

from app.grading.engine import (
    _parse_trade_date,
    _value_assets_for_roster,
    assign_letter_grade,
)

# (key, player/value source, pick source)
LENSES = [
    ("ours", "rosteraudit", "rosteraudit"),
    ("market", "fantasycalc", "fantasycalc"),
    ("experts", "dynastyprocess", "rosteraudit"),
]


class SnapshotValueSource:
    """RosterAuditValueSource generalized to any snapshot source."""

    def __init__(self, conn: Connection, source: str, pick_source: str | None = None) -> None:
        self._conn = conn
        self._source = source
        self._pick_source = pick_source or source

    def get_player_value(self, sleeper_id: str, fmt: str, as_of: date):
        row = self._conn.execute(
            "SELECT value, snapshot_date FROM value_snapshots "
            "WHERE player_id = ? AND source = ? AND format = ? AND snapshot_date <= ? "
            "ORDER BY snapshot_date DESC LIMIT 1",
            (sleeper_id, self._source, fmt, as_of.isoformat()),
        ).fetchone()
        if row is not None:
            return row["value"], row["snapshot_date"] < as_of.isoformat()
        row = self._conn.execute(
            "SELECT value FROM value_snapshots "
            "WHERE player_id = ? AND source = ? AND format = ? "
            "ORDER BY snapshot_date ASC LIMIT 1",
            (sleeper_id, self._source, fmt),
        ).fetchone()
        return (row["value"], True) if row else (None, False)

    def get_pick_value(self, season: int, rnd: int, fmt: str, as_of: date):
        row = self._conn.execute(
            "SELECT mid_value, snapshot_date FROM pick_value_snapshots "
            "WHERE season = ? AND round = ? AND source = ? AND format = ? AND snapshot_date <= ? "
            "ORDER BY snapshot_date DESC LIMIT 1",
            (season, rnd, self._pick_source, fmt, as_of.isoformat()),
        ).fetchone()
        if row is not None:
            return row["mid_value"], row["snapshot_date"] < as_of.isoformat()
        row = self._conn.execute(
            "SELECT mid_value FROM pick_value_snapshots "
            "WHERE season = ? AND round = ? AND source = ? AND format = ? "
            "ORDER BY snapshot_date ASC LIMIT 1",
            (season, rnd, self._pick_source, fmt),
        ).fetchone()
        return (row["mid_value"], True) if row else (None, False)


def lens_grades(conn: Connection, trade_id: str, roster_id: int) -> dict:
    """
    Grade one side of one trade through all three lenses.

    Returns {lens: {"decision": g, "outcome": g}} where g is
    {"letter", "pct", "received", "given", "estimated"} or None when the
    lens has no data for any asset in the trade.
    """
    trade_row = conn.execute(
        "SELECT league_id, executed_at FROM trades WHERE id = ?", (trade_id,)
    ).fetchone()
    if trade_row is None:
        return {}
    league_row = conn.execute(
        "SELECT format_key FROM leagues WHERE id = ?", (trade_row["league_id"],)
    ).fetchone()
    fmt = (league_row["format_key"] if league_row else None) or "sf_ppr"
    trade_date = _parse_trade_date(trade_row["executed_at"])
    today = date.today()

    out: dict[str, dict] = {}
    for key, source_name, pick_source in LENSES:
        source = SnapshotValueSource(conn, source_name, pick_source)
        lens: dict[str, dict | None] = {}
        for grade_type, as_of in (("decision", trade_date), ("outcome", today)):
            received, fb_r = _value_assets_for_roster(
                conn, trade_id, roster_id, "received", fmt, as_of, source
            )
            given, fb_g = _value_assets_for_roster(
                conn, trade_id, roster_id, "given", fmt, as_of, source
            )
            if received == 0 and given == 0:
                lens[grade_type] = None
                continue
            larger = max(received, given)
            pct = (received - given) / larger if larger > 0 else 0.0
            lens[grade_type] = {
                "letter": assign_letter_grade(received - given, received, given),
                "pct": round(pct, 3),
                "received": received,
                "given": given,
                # Outcome grades always use current prices; only decision
                # grades can be backfilled estimates.
                "estimated": (fb_r or fb_g) if grade_type == "decision" else False,
            }
        out[key] = lens
    return out
