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

from app.grading.engine import _parse_trade_date, assign_letter_grade
from app.pick_conversion import PickResolutionContext

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


def _value_assets(
    conn: Connection,
    trade_id: str,
    roster_id: int,
    direction: str,
    fmt: str,
    as_of: date,
    source: SnapshotValueSource,
    resolver: PickResolutionContext | None,
) -> tuple[int, bool, bool]:
    """
    Sum one side's asset values. When a resolver is given (outcome pass),
    picks whose draft has already happened are valued as the PLAYER actually
    selected with them — real hindsight, not generic pick value.

    Returns (total, used_fallback, any_pick_realized).
    """
    col = "to_roster_id" if direction == "received" else "from_roster_id"
    rows = conn.execute(
        f"SELECT asset_type, player_id, pick_season, pick_round, "
        f"pick_original_owner_roster_id FROM trade_assets "
        f"WHERE trade_id = ? AND {col} = ? AND asset_type != 'faab'",
        (trade_id, roster_id),
    ).fetchall()

    total = 0
    used_fallback = False
    realized = False

    for row in rows:
        if row["asset_type"] == "player":
            val, fb = source.get_player_value(row["player_id"], fmt, as_of)
            if val is not None:
                total += val
                used_fallback = used_fallback or fb
            continue

        # pick asset
        if resolver is not None:
            pid, status = resolver.resolve_pick(
                row["pick_season"], row["pick_round"], row["pick_original_owner_roster_id"]
            )
            if status == "resolved" and pid:
                val, fb = source.get_player_value(pid, fmt, as_of)
                if val is not None:
                    total += val
                    used_fallback = used_fallback or fb
                    realized = True
                    continue
        val, fb = source.get_pick_value(row["pick_season"], row["pick_round"], fmt, as_of)
        if val is not None:
            total += val
            used_fallback = used_fallback or fb

    return total, used_fallback, realized


def lens_grades(
    conn: Connection,
    trade_id: str,
    roster_id: int,
    resolver: PickResolutionContext | None = None,
) -> dict:
    """
    Grade one side of one trade through all three lenses.

    Returns {lens: {"decision": g, "outcome": g}} where g is
    {"letter", "pct", "received", "given", "estimated", "realized"} or None
    when the lens has no data for any asset in the trade. "realized" marks
    outcome grades where a traded pick was valued as the player it became.
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

    if resolver is None:
        resolver = PickResolutionContext(conn, trade_row["league_id"])

    out: dict[str, dict] = {}
    for key, source_name, pick_source in LENSES:
        source = SnapshotValueSource(conn, source_name, pick_source)
        lens: dict[str, dict | None] = {}
        for grade_type, as_of in (("decision", trade_date), ("outcome", today)):
            # Decision = what was knowable then (generic pick values).
            # Outcome = hindsight (conveyed picks become the drafted player).
            res = resolver if grade_type == "outcome" else None
            received, fb_r, real_r = _value_assets(
                conn, trade_id, roster_id, "received", fmt, as_of, source, res
            )
            given, fb_g, real_g = _value_assets(
                conn, trade_id, roster_id, "given", fmt, as_of, source, res
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
                "realized": (real_r or real_g) if grade_type == "outcome" else False,
            }
        out[key] = lens
    return out
