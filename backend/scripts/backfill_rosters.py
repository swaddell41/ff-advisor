"""
One-time backfill script: populate roster_players from cached Sleeper roster data.

Reads cached /v1/league/{id}/rosters responses from sleeper_cache and writes
player compositions into roster_players — no new API calls needed.

Usage:
    cd backend
    python scripts/backfill_rosters.py
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
from app.db import get_connection, init_schema
from scripts.ingest_leagues import populate_roster_players

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("backfill_rosters")


def main() -> None:
    conn = get_connection()
    init_schema(conn)

    # Get all league IDs in the DB
    leagues = conn.execute("SELECT id FROM leagues").fetchall()
    logger.info("Found %d leagues to backfill", len(leagues))

    total_rows = 0
    for league_row in leagues:
        league_id = league_row["id"]
        cache_url = f"https://api.sleeper.app/v1/league/{league_id}/rosters"

        cached = conn.execute(
            "SELECT response_json FROM sleeper_cache WHERE url = ?", (cache_url,)
        ).fetchone()

        if not cached:
            logger.warning("No cached rosters for league %s — skipping", league_id)
            continue

        rosters = json.loads(cached["response_json"])
        n = populate_roster_players(conn, league_id, rosters)
        total_rows += n

    conn.close()
    logger.info("DONE — wrote %d total roster_players rows across %d leagues", total_rows, len(leagues))
    print(f"\nBackfill complete: {total_rows} roster player rows across {len(leagues)} leagues")


if __name__ == "__main__":
    main()
