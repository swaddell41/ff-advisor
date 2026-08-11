"""
RosterAudit API client and value snapshot writer.

RosterAudit is a public API — no auth required.
Attribution required when displaying values: "Values by RosterAudit.com"

Base URL: https://rosteraudit.com/wp-json/ra/v1

Key endpoints used here:
  /rankings/values?format_key=sf_ppr   — bulk player values (compact)
  /picks                               — pick values by season/round/slot

Rate limit: 200 req/min for most endpoints.

Format key mapping
------------------
RosterAudit only has PPR presets. SF half-PPR leagues map to sf_ppr as the
closest approximation. The FORMAT_KEY_OVERRIDES dict lets you hard-code a
different key for a specific league_id if needed.

Available presets (from /presets endpoint):
  sf_ppr       — Superflex, full PPR
  sf_ppr_tep   — Superflex, full PPR, TE Premium
  1qb_ppr      — 1QB, full PPR
  1qb_ppr_tep  — 1QB, full PPR, TE Premium
"""

import logging
import time
from datetime import date, datetime, timezone
from sqlite3 import Connection

import requests

logger = logging.getLogger(__name__)

RA_BASE_URL = "https://rosteraudit.com/wp-json/ra/v1"
SOURCE_NAME = "rosteraudit"
REQUEST_DELAY_SECONDS = 0.05

# ---------------------------------------------------------------------------
# Per-league format key overrides.
# Add entries here if auto-detection gets the format wrong for a specific league.
# Example: FORMAT_KEY_OVERRIDES = {"1048345114799955968": "sf_ppr_tep"}
# ---------------------------------------------------------------------------
FORMAT_KEY_OVERRIDES: dict[str, str] = {}


def detect_format_key(league: dict) -> str:
    """
    Derive the RosterAudit format key from a Sleeper league object.

    Reads roster_positions and scoring_settings to determine SF/1QB and TEP.

    NOTE: RosterAudit has no half-PPR preset. SF half-PPR leagues are mapped
    to sf_ppr as the closest available approximation. This means values will
    be slightly off in absolute terms but directionally correct for grading.
    Override per-league using FORMAT_KEY_OVERRIDES if needed.
    """
    league_id = str(league.get("league_id", ""))
    if league_id in FORMAT_KEY_OVERRIDES:
        key = FORMAT_KEY_OVERRIDES[league_id]
        logger.info("League %s: using format key override '%s'", league_id, key)
        return key

    positions = league.get("roster_positions") or []
    scoring = league.get("scoring_settings") or {}

    is_sf = "SUPER_FLEX" in positions
    # TEP: Sleeper uses bonus_rec_te for TE reception premium points
    is_tep = float(scoring.get("bonus_rec_te", 0)) > 0

    if is_sf and is_tep:
        key = "sf_ppr_tep"
    elif is_sf:
        key = "sf_ppr"
    elif is_tep:
        key = "1qb_ppr_tep"
    else:
        key = "1qb_ppr"

    if is_sf and not league.get("scoring_settings", {}).get("rec", 0) == 1.0:
        logger.info(
            "League %s: half-PPR detected but RosterAudit has no half-PPR preset. "
            "Using '%s' as the closest approximation.",
            league_id,
            key,
        )

    return key


class RosterAuditClient:
    """
    Fetches current dynasty values from the RosterAudit public API.

    This client is used by snapshot_values.py to write periodic snapshots.
    It does NOT use the SQLite cache — snapshot writes are intentional fresh
    fetches. If you need cached lookups, use RosterAuditValueSource instead.
    """

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update(
            {"User-Agent": "ff-advisor/1.0 (personal tool)"}
        )

    def get_player_values(self, format_key: str) -> dict[str, dict]:
        """
        GET /rankings/values?format_key={format_key}

        Returns {sleeper_id: {"sf": int, "1qb": int}} for all tracked players.
        The "sf" and "1qb" keys are always present regardless of format_key —
        the format_key influences which Elo model's values are returned.
        """
        time.sleep(REQUEST_DELAY_SECONDS)
        url = f"{RA_BASE_URL}/rankings/values"
        resp = self._session.get(url, params={"format_key": format_key}, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        # Strip non-player keys (attribution, attribution_url, etc.)
        # Player entries are always dicts; metadata values are strings.
        return {k: v for k, v in data.items() if isinstance(v, dict)}

    def get_pick_values(self) -> list[dict]:
        """
        GET /picks

        Returns pick values for all seasons/rounds in both SF and 1QB formats.
        Response structure varies; we normalize to a list of pick dicts.
        """
        time.sleep(REQUEST_DELAY_SECONDS)
        url = f"{RA_BASE_URL}/picks"
        resp = self._session.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        # Handle both list and dict-wrapped responses
        if isinstance(data, list):
            return data
        # Some responses wrap picks in a "picks" key
        if isinstance(data, dict) and "picks" in data:
            return data["picks"]
        # Fallback: return as-is if we can iterate it
        return list(data.values()) if isinstance(data, dict) else []


def write_player_snapshots(
    conn: Connection,
    format_key: str,
    player_values: dict[str, dict],
    snapshot_date: date | None = None,
) -> int:
    """
    Write a batch of player value snapshots to the DB.

    Returns the number of rows written.

    The format_key determines which column from the bulk values response to
    store:
      - sf_*    → use the "sf" value column
      - 1qb_*   → use the "1qb" value column

    Both sf and 1qb values are returned by the /rankings/values endpoint
    regardless of the format_key used in the request. We store the value
    that matches the requested format.
    """
    if snapshot_date is None:
        snapshot_date = datetime.now(timezone.utc).date()

    value_col = "sf" if format_key.startswith("sf") else "1qb"
    rows_written = 0

    for sleeper_id, vals in player_values.items():
        raw_value = vals.get(value_col)
        if raw_value is None:
            continue
        conn.execute(
            """
            INSERT OR REPLACE INTO value_snapshots
                (player_id, source, format, snapshot_date, value)
            VALUES (?, ?, ?, ?, ?)
            """,
            (sleeper_id, SOURCE_NAME, format_key, snapshot_date.isoformat(), int(raw_value)),
        )
        rows_written += 1

    conn.commit()
    return rows_written


def write_pick_snapshots(
    conn: Connection,
    format_key: str,
    pick_data: list[dict],
    snapshot_date: date | None = None,
) -> int:
    """
    Write pick value snapshots to the DB.

    RosterAudit's /picks endpoint returns one entry per slot (early/mid/late):
    [
      {"pick_season": 2026, "pick_round": 1, "pick_slot": "early", "val_sf": 4632, "val_1qb": 4632, ...},
      {"pick_season": 2026, "pick_round": 1, "pick_slot": "mid",   "val_sf": 2644, "val_1qb": 2644, ...},
      {"pick_season": 2026, "pick_round": 1, "pick_slot": "late",  "val_sf": 1619, "val_1qb": 1619, ...},
      ...
    ]

    We group by (season, round) and pivot into one DB row with early/mid/late values.
    The value column is determined by the format_key prefix: val_sf for sf_*, val_1qb for 1qb_*.
    """
    if snapshot_date is None:
        snapshot_date = datetime.now(timezone.utc).date()

    # Determine value column from format_key prefix
    val_col = "val_sf" if format_key.startswith("sf") else "val_1qb"

    # Group entries by (season, round), keyed by slot name
    from collections import defaultdict
    grouped: dict[tuple, dict[str, int]] = defaultdict(dict)

    for pick in pick_data:
        season = pick.get("pick_season")
        round_num = pick.get("pick_round")
        slot = pick.get("pick_slot")  # "early" | "mid" | "late"
        value = pick.get(val_col)

        if season is None or round_num is None or slot is None or value is None:
            logger.debug("Skipping incomplete pick entry: %s", pick)
            continue

        grouped[(season, round_num)][slot] = int(value)

    rows_written = 0
    for (season, round_num), slots in grouped.items():
        mid = slots.get("mid")
        if mid is None:
            logger.warning(
                "No mid value for pick %d.%d in snapshot, skipping", season, round_num
            )
            continue

        conn.execute(
            """
            INSERT OR REPLACE INTO pick_value_snapshots
                (season, round, source, format, snapshot_date,
                 early_value, mid_value, late_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                season, round_num, SOURCE_NAME, format_key,
                snapshot_date.isoformat(),
                slots.get("early"),
                mid,
                slots.get("late"),
            ),
        )
        rows_written += 1

    conn.commit()
    return rows_written
