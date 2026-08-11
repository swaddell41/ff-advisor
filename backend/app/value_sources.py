"""
Value source abstraction layer.

The ValueSource Protocol defines the interface that all value providers must
implement. Phase 1 ships RosterAuditValueSource. KTCValueSource is a clearly-
marked stub for a future phase.

Usage by the grading engine:
    source = RosterAuditValueSource(conn)
    value, used_fallback = source.get_player_value("7564", "sf_ppr", trade_date)
    pick_value, _ = source.get_pick_value(2024, 1, "sf_ppr", trade_date)
"""

from __future__ import annotations

from datetime import date
from sqlite3 import Connection
from typing import Protocol


class ValueSource(Protocol):
    """
    Interface that every value provider must satisfy.

    Both methods return a (value, used_fallback) tuple:
    - value:        integer dynasty value on the given date, or None if unknown.
    - used_fallback: True when no snapshot exists for the exact date and the
                    grading engine fell back to the oldest/nearest snapshot.
                    The Phase 2 UI uses this flag to show a warning indicator.
    """

    def get_player_value(
        self, sleeper_id: str, fmt: str, as_of: date
    ) -> tuple[int | None, bool]:
        """
        Return the dynasty value of a player in the given format on `as_of`.

        sleeper_id: Sleeper's string player ID (e.g. "7564")
        fmt:        RosterAudit format key ("sf_ppr", "sf_ppr_tep", etc.)
        as_of:      The date to look up (typically the trade execution date)
        """
        ...

    def get_pick_value(
        self, season: int, round: int, fmt: str, as_of: date
    ) -> tuple[int | None, bool]:
        """
        Return the dynasty value of a draft pick (mid-slot) in the given format.

        season: Draft year (e.g. 2024)
        round:  Round number (1 = 1st round)
        fmt:    RosterAudit format key
        as_of:  The date to look up
        """
        ...


class RosterAuditValueSource:
    """
    Reads dynasty values from value_snapshots / pick_value_snapshots in the DB.

    Fallback behavior: if no snapshot exists on or before `as_of`, we use the
    oldest available snapshot and set used_fallback=True. The grading engine
    stores this flag so the UI can display a "⚠ historical values unavailable"
    indicator.

    Snapshot data is written by scripts/snapshot_values.py (run weekly).
    """

    SOURCE = "rosteraudit"

    def __init__(self, conn: Connection) -> None:
        self._conn = conn

    def get_player_value(
        self, sleeper_id: str, fmt: str, as_of: date
    ) -> tuple[int | None, bool]:
        # Try exact-date or most-recent snapshot on or before as_of.
        row = self._conn.execute(
            """
            SELECT value, snapshot_date
            FROM value_snapshots
            WHERE player_id = ? AND source = ? AND format = ?
              AND snapshot_date <= ?
            ORDER BY snapshot_date DESC
            LIMIT 1
            """,
            (sleeper_id, self.SOURCE, fmt, as_of.isoformat()),
        ).fetchone()

        if row is not None:
            snap_date = date.fromisoformat(row["snapshot_date"])
            used_fallback = snap_date < as_of
            return row["value"], used_fallback

        # No snapshot on or before as_of — fall back to the oldest available.
        row = self._conn.execute(
            """
            SELECT value
            FROM value_snapshots
            WHERE player_id = ? AND source = ? AND format = ?
            ORDER BY snapshot_date ASC
            LIMIT 1
            """,
            (sleeper_id, self.SOURCE, fmt),
        ).fetchone()

        if row is None:
            return None, False

        return row["value"], True

    def get_pick_value(
        self, season: int, round: int, fmt: str, as_of: date
    ) -> tuple[int | None, bool]:
        # Most-recent snapshot on or before as_of.
        row = self._conn.execute(
            """
            SELECT mid_value, snapshot_date
            FROM pick_value_snapshots
            WHERE season = ? AND round = ? AND source = ? AND format = ?
              AND snapshot_date <= ?
            ORDER BY snapshot_date DESC
            LIMIT 1
            """,
            (season, round, self.SOURCE, fmt, as_of.isoformat()),
        ).fetchone()

        if row is not None:
            snap_date = date.fromisoformat(row["snapshot_date"])
            used_fallback = snap_date < as_of
            return row["mid_value"], used_fallback

        # Fall back to oldest.
        row = self._conn.execute(
            """
            SELECT mid_value
            FROM pick_value_snapshots
            WHERE season = ? AND round = ? AND source = ? AND format = ?
            ORDER BY snapshot_date ASC
            LIMIT 1
            """,
            (season, round, self.SOURCE, fmt),
        ).fetchone()

        if row is None:
            return None, False

        return row["mid_value"], True


# ---------------------------------------------------------------------------
# TODO: KTCValueSource
# ---------------------------------------------------------------------------
# KTC (KeepTradeCut) does not have a public API. Implementing this class
# requires HTML scraping of keeptradecut.com, which is fragile and may
# violate their ToS. Defer until either:
#   (a) KTC publishes a public API, or
#   (b) We decide scraping is acceptable and build a resilient scraper.
#
# When implemented, KTCValueSource must satisfy the ValueSource Protocol
# above (get_player_value / get_pick_value signatures) and be registered
# in VALUE_SOURCES dict in rosteraudit.py so it can be selected per-league.
#
class KTCValueSource:
    """
    Stub — NOT IMPLEMENTED.
    See module docstring for rationale.
    """

    SOURCE = "ktc"

    def __init__(self, conn: Connection) -> None:
        raise NotImplementedError(
            "KTCValueSource is not yet implemented. "
            "Use RosterAuditValueSource for now."
        )

    def get_player_value(
        self, sleeper_id: str, fmt: str, as_of: date
    ) -> tuple[int | None, bool]:
        raise NotImplementedError

    def get_pick_value(
        self, season: int, round: int, fmt: str, as_of: date
    ) -> tuple[int | None, bool]:
        raise NotImplementedError
