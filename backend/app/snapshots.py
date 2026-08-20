"""
Value snapshot job, callable from anywhere: the CLI script (local), the
daily launchd job, or the Vercel Cron endpoint.

Snapshots RosterAudit (pricing base) plus the two reference layers
(FantasyCalc market, DynastyProcess expert consensus) for every format key
present in the leagues table. Reference-layer failures are non-fatal.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from sqlite3 import Connection

from app.ingestion.dynastyprocess import write_dynastyprocess_snapshots
from app.ingestion.fantasycalc import write_fantasycalc_snapshots
from app.ingestion.rosteraudit import (
    RosterAuditClient,
    write_pick_snapshots,
    write_player_snapshots,
)

logger = logging.getLogger(__name__)


def get_format_keys(conn: Connection) -> list[str]:
    rows = conn.execute(
        "SELECT DISTINCT format_key FROM leagues WHERE format_key IS NOT NULL"
    ).fetchall()
    keys = {r["format_key"] for r in rows}
    # Baselines the draft assistant needs even when no imported league uses
    # them — an arbitrary Sleeper draft can be superflex or 1QB.
    keys.update({"sf_ppr", "1qb_ppr"})
    return sorted(keys)


def run_value_snapshots(conn: Connection) -> dict:
    """Snapshot all three sources for every known format. Returns a summary."""
    today = datetime.now(timezone.utc).date()
    format_keys = get_format_keys(conn)
    client = RosterAuditClient()

    total_players = 0
    total_picks = 0

    pick_data = client.get_pick_values()
    for fmt in format_keys:
        player_values = client.get_player_values(fmt)
        total_players += write_player_snapshots(conn, fmt, player_values, today)
        total_picks += write_pick_snapshots(conn, fmt, pick_data, today)

    fc_players = dp_players = 0
    try:
        fc_players, _ = write_fantasycalc_snapshots(conn, format_keys, today)
    except Exception as e:
        logger.warning("FantasyCalc snapshot failed (non-fatal): %s", e)
    try:
        dp_players = write_dynastyprocess_snapshots(conn, format_keys, today)
    except Exception as e:
        logger.warning("DynastyProcess snapshot failed (non-fatal): %s", e)

    return {
        "snapshot_date": today.isoformat(),
        "formats": format_keys,
        "rosteraudit_players": total_players,
        "rosteraudit_picks": total_picks,
        "fantasycalc_players": fc_players,
        "dynastyprocess_players": dp_players,
    }
