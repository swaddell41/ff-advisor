"""
DynastyProcess value source — the "expert consensus" third opinion.

DynastyProcess publishes free weekly player values derived from FantasyPros
Expert Consensus Rankings (ECR). That gives the tool a third independent
methodology alongside RosterAudit (house model) and FantasyCalc (real-trade
market): model / market / expert consensus. Where all three agree, trust the
number; where they split, the asset is contested and verdicts should be
read as conditional.

Data: raw CSVs from github.com/dynastyprocess/data
  files/values-players.csv — player, value_1qb, value_2qb, fp_id
  files/db_playerids.csv   — fantasypros_id → sleeper_id crosswalk

Players only — their picks file publishes ECR without values. Values are
normalized onto RosterAudit's scale at write time (same approach as
FantasyCalc).
"""

from __future__ import annotations

import csv
import io
import logging
from datetime import date
from sqlite3 import Connection

import requests

logger = logging.getLogger(__name__)

VALUES_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv"
IDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"
SOURCE_NAME = "dynastyprocess"


def _fetch_csv(url: str) -> list[dict]:
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return list(csv.DictReader(io.StringIO(resp.text)))


def write_dynastyprocess_snapshots(
    conn: Connection,
    format_keys: list[str],
    snapshot_date: date,
) -> int:
    """Fetch DP values, map fp_id → sleeper_id, normalize, write per format."""
    values = _fetch_csv(VALUES_URL)
    ids = _fetch_csv(IDS_URL)
    fp_to_sleeper = {
        r["fantasypros_id"]: r["sleeper_id"]
        for r in ids
        if r.get("fantasypros_id") not in (None, "", "NA")
        and r.get("sleeper_id") not in (None, "", "NA")
    }

    d_iso = snapshot_date.isoformat()
    total = 0

    for fmt in format_keys:
        value_col = "value_2qb" if fmt.startswith("sf") else "value_1qb"

        dp_players: dict[str, float] = {}
        for row in values:
            sid = fp_to_sleeper.get(row.get("fp_id", ""))
            if not sid:
                continue
            try:
                v = float(row.get(value_col) or 0)
            except ValueError:
                continue
            if v > 0:
                dp_players[sid] = v

        # Normalize onto RosterAudit's scale via shared-player sums.
        rows = conn.execute(
            "SELECT player_id, value FROM value_snapshots "
            "WHERE source='rosteraudit' AND format=? AND snapshot_date=? AND value > 0",
            (fmt, d_iso),
        ).fetchall()
        ra_sum = sum(r["value"] for r in rows if r["player_id"] in dp_players)
        dp_sum = sum(dp_players[r["player_id"]] for r in rows if r["player_id"] in dp_players)
        factor = (ra_sum / dp_sum) if dp_sum > 0 else 1.0
        logger.info("fmt=%s: dynastyprocess normalization factor %.3f", fmt, factor)

        for sid, v in dp_players.items():
            conn.execute(
                "INSERT OR REPLACE INTO value_snapshots (player_id, source, format, snapshot_date, value) "
                "VALUES (?, ?, ?, ?, ?)",
                (sid, SOURCE_NAME, fmt, d_iso, round(v * factor)),
            )
            total += 1

        conn.commit()
        logger.info("fmt=%s: wrote %d dynastyprocess player rows", fmt, len(dp_players))

    return total
