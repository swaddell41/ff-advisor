"""One clock: dates are UTC everywhere (snapshots are written in UTC, and
reading them against local midnight skipped a day near the boundary)."""

from datetime import date, datetime, timezone


def utc_today() -> date:
    return datetime.now(timezone.utc).date()
