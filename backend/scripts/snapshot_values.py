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
from app.snapshots import run_value_snapshots

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("snapshot")


def main() -> None:
    logger.info("Snapshotting values…")
    conn = get_connection()
    init_schema(conn)
    summary = run_value_snapshots(conn)
    conn.close()
    logger.info("DONE — %s", summary)
    print(f"\nSnapshot complete: {summary}")


if __name__ == "__main__":
    main()
