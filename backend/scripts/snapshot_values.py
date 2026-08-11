"""
Weekly value snapshot script.

Pulls current dynasty values from RosterAudit and writes a snapshot row
per player and per pick to the database.

Usage:
    cd backend
    python scripts/snapshot_values.py

Run this once before grading (the grading engine requires at least one
snapshot), then weekly thereafter to build a historical value timeline.

The script detects all unique format_keys currently stored in the leagues
table and snapshots values for each one. This means if you add a new
league later, its format will be picked up automatically on the next run.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure the backend package is importable when run directly
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

from app.db import get_connection, init_schema
from app.ingestion.rosteraudit import (
    RosterAuditClient,
    write_pick_snapshots,
    write_player_snapshots,
)

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("snapshot")


def get_format_keys(conn) -> list[str]:
    """
    Return all unique format_keys currently in the leagues table.

    Falls back to ["sf_ppr"] if no leagues have been ingested yet, so
    you can run snapshot_values.py before ingest_leagues.py if needed.
    """
    rows = conn.execute(
        "SELECT DISTINCT format_key FROM leagues WHERE format_key IS NOT NULL"
    ).fetchall()
    if not rows:
        logger.warning(
            "No leagues found in DB — defaulting to sf_ppr. "
            "Run ingest_leagues.py first for accurate format detection."
        )
        return ["sf_ppr"]
    keys = [row["format_key"] for row in rows]
    logger.info("Format keys to snapshot: %s", keys)
    return keys


def main() -> None:
    today = datetime.now(timezone.utc).date()
    logger.info("Snapshotting values for %s", today.isoformat())

    conn = get_connection()
    init_schema(conn)
    client = RosterAuditClient()

    format_keys = get_format_keys(conn)

    total_players = 0
    total_picks = 0

    # Fetch pick values once (they're the same regardless of format_key — the
    # /picks endpoint returns all slots in both SF and 1QB formats).
    logger.info("Fetching pick values from RosterAudit…")
    pick_data = client.get_pick_values()
    logger.info("Received %d pick entries from RosterAudit", len(pick_data))

    for format_key in format_keys:
        logger.info("Fetching player values for format_key=%s…", format_key)
        player_values = client.get_player_values(format_key)
        logger.info(
            "format_key=%s: received values for %d players", format_key, len(player_values)
        )

        n_players = write_player_snapshots(conn, format_key, player_values, today)
        total_players += n_players
        logger.info(
            "format_key=%s: wrote %d player snapshot rows", format_key, n_players
        )

        n_picks = write_pick_snapshots(conn, format_key, pick_data, today)
        total_picks += n_picks
        logger.info(
            "format_key=%s: wrote %d pick snapshot rows", format_key, n_picks
        )

    conn.close()

    logger.info(
        "DONE — %d player rows, %d pick rows across %d format(s)",
        total_players, total_picks, len(format_keys),
    )
    print(
        f"\nSnapshot complete: {total_players} player values, "
        f"{total_picks} pick values across {len(format_keys)} format(s) "
        f"as of {today.isoformat()}"
    )


if __name__ == "__main__":
    main()
