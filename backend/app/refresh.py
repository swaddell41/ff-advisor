"""
On-demand data refresh — keeps rosters and trades current between full
ingestion runs.

For each current-season league in LEAGUE_IDS this re-pulls (respecting the
Sleeper client's cache TTLs, so it's cheap): managers + rosters (which
rewrites roster_players), this season's weekly transactions, and traded
picks. Any trade that has never been graded gets graded afterwards — the
lazy _ensure_graded path only fires for leagues with zero grades, so new
trades in an already-graded league would otherwise stay ungraded forever.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from sqlite3 import Connection

from app.grading.engine import grade_trade
from app.ingestion.sleeper import SleeperClient
from app.value_sources import RosterAuditValueSource

logger = logging.getLogger(__name__)


def _league_ids_from_env() -> list[str]:
    raw = os.environ.get("LEAGUE_IDS", "")
    return [x.strip() for x in raw.split(",") if x.strip()]


def _all_current_league_ids(conn: Connection) -> list[str]:
    """Every league any app user has selected, plus the .env set."""
    ids = set(_league_ids_from_env())
    for r in conn.execute("SELECT DISTINCT league_id FROM user_leagues").fetchall():
        ids.add(r["league_id"])
    return sorted(ids)


def refresh_current_leagues(conn: Connection) -> dict:
    """Refresh rosters/trades/traded-picks for the current leagues. Returns a summary."""
    from scripts.ingest_leagues import (
        ingest_managers,
        ingest_players,
        ingest_traded_picks,
        ingest_trades,
    )

    client = SleeperClient(conn)
    league_ids = _all_current_league_ids(conn)
    new_trades = 0

    # Keep the player pool current (teams, status, injuries) — TTL-guarded,
    # so this is a no-op unless the cached blob is older than a day.
    ingest_players(conn, client)

    for league_id in league_ids:
        season_row = conn.execute(
            "SELECT season FROM leagues WHERE id = ?", (league_id,)
        ).fetchone()
        if season_row is None:
            # Selected but never imported — the onboarding job owns first import.
            continue
        roster_to_user = ingest_managers(conn, client, league_id)
        season = season_row["season"]
        new_trades += ingest_trades(
            conn, client, league_id, season, roster_to_user, mutable=True
        )
        ingest_traded_picks(conn, client, league_id)

    # Grade anything never graded (new trades in already-graded leagues).
    ungraded = conn.execute(
        "SELECT t.id FROM trades t LEFT JOIN trade_grades tg ON tg.trade_id = t.id "
        "WHERE tg.trade_id IS NULL"
    ).fetchall()
    source = RosterAuditValueSource(conn)
    for row in ungraded:
        grade_trade(conn, row["id"], source)

    return {
        "refreshed_leagues": len(league_ids),
        "new_trades": new_trades,
        "newly_graded": len(ungraded),
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
    }


def data_freshness(conn: Connection) -> dict:
    """When was each layer of data last pulled?"""
    roster_row = conn.execute(
        "SELECT MAX(fetched_at) as t FROM sleeper_cache WHERE url LIKE '%/rosters'"
    ).fetchone()
    value_row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source='rosteraudit'"
    ).fetchone()
    market_row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source='fantasycalc'"
    ).fetchone()
    return {
        "rosters_fetched_at": roster_row["t"] if roster_row else None,
        "values_snapshot_date": value_row["d"] if value_row else None,
        "market_snapshot_date": market_row["d"] if market_row else None,
    }
