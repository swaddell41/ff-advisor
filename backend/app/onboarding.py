"""
League onboarding: resolve a Sleeper user, list their leagues, and import
selected league families.

Imports run SYNCHRONOUSLY inside one request per league (~30-60s for a
3-4 season family) — the frontend drives leagues sequentially and shows
progress per league. This shape works identically on a laptop and on
serverless (Vercel functions can't outlive their request, so background
threads are out). Each import:
  1. walks the previous_league_id chain and ingests every season
     (metadata, managers/rosters, trades, drafts, traded picks)
  2. refreshes the shared player table (7-day cache makes this a no-op
     most of the time)
  3. makes sure value snapshots exist for the league's format key — a new
     user may bring a format (e.g. 1qb_ppr) we've never priced
  4. grades any never-graded trades
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from sqlite3 import Connection

import requests

from app.db import get_connection
from app.grading.engine import grade_trade
from app.ingestion.sleeper import SleeperClient
from app.value_sources import RosterAuditValueSource

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sleeper user helpers (direct, uncached — tiny responses)
# ---------------------------------------------------------------------------

def lookup_sleeper_user(username: str) -> dict | None:
    resp = requests.get(f"https://api.sleeper.app/v1/user/{username}", timeout=15)
    if resp.status_code != 200 or resp.json() is None:
        return None
    return resp.json()


def list_user_leagues(sleeper_user_id: str) -> list[dict]:
    """Current-season dynasty-relevant leagues for a user (falls back one season)."""
    year = datetime.now(timezone.utc).year
    leagues: list[dict] = []
    for season in (year, year - 1):
        resp = requests.get(
            f"https://api.sleeper.app/v1/user/{sleeper_user_id}/leagues/nfl/{season}",
            timeout=15,
        )
        if resp.status_code == 200 and resp.json():
            leagues.extend(resp.json())
        if leagues:
            break
    return [
        {
            "league_id": l.get("league_id"),
            "name": l.get("name"),
            "season": l.get("season"),
            "total_rosters": l.get("total_rosters"),
        }
        for l in leagues
    ]


# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------

def get_job_statuses(league_ids: list[str], conn: Connection) -> dict[str, dict]:
    """Imported = the league row exists. (Imports are synchronous now.)"""
    out = {}
    for lid in league_ids:
        row = conn.execute("SELECT 1 FROM leagues WHERE id = ?", (lid,)).fetchone()
        out[lid] = {"status": "done" if row else "not_started", "detail": None}
    return out


def run_import_sync(root_league_id: str) -> dict:
    """
    Import a league family synchronously. Returns {"status", "detail"}.
    Opens its own connection so it can be called from any context.
    """
    from scripts.ingest_leagues import (
        ingest_drafts,
        ingest_league_metadata,
        ingest_managers,
        ingest_players,
        ingest_traded_picks,
        ingest_trades,
        walk_league_chain,
    )

    conn = get_connection()
    try:
        client = SleeperClient(conn)
        chain = walk_league_chain(client, root_league_id)

        for league in chain:
            league_id = league["league_id"]
            season = league.get("season")
            ingest_league_metadata(conn, league)
            roster_to_user = ingest_managers(conn, client, league_id)
            ingest_trades(
                conn, client, league_id, season, roster_to_user,
                mutable=(league_id == root_league_id),
            )
            ingest_drafts(conn, client, league_id)
            ingest_traded_picks(conn, client, league_id)

        ingest_players(conn, client)
        _ensure_format_snapshots(conn, root_league_id)

        family_ids = [l["league_id"] for l in chain]
        ph = ",".join("?" * len(family_ids))
        ungraded = conn.execute(
            f"SELECT t.id FROM trades t LEFT JOIN trade_grades tg ON tg.trade_id = t.id "
            f"WHERE tg.trade_id IS NULL AND t.league_id IN ({ph})",
            family_ids,
        ).fetchall()
        source = RosterAuditValueSource(conn)
        for row in ungraded:
            grade_trade(conn, row["id"], source)

        detail = f"{len(chain)} seasons, {len(ungraded)} trades graded"
        logger.info("Import complete: %s (%s)", root_league_id, detail)
        return {"status": "done", "detail": detail}
    except Exception as e:
        logger.exception("Import failed for %s", root_league_id)
        return {"status": "error", "detail": str(e)}
    finally:
        conn.close()


def _ensure_format_snapshots(conn: Connection, league_id: str) -> None:
    """A new league may use a format we've never priced — snapshot it now."""
    row = conn.execute("SELECT format_key FROM leagues WHERE id = ?", (league_id,)).fetchone()
    fmt = (row["format_key"] if row else None) or "sf_ppr"
    existing = conn.execute(
        "SELECT 1 FROM value_snapshots WHERE source='rosteraudit' AND format=? LIMIT 1", (fmt,)
    ).fetchone()
    if existing:
        return

    logger.info("New format %s — fetching value snapshots", fmt)
    today = datetime.now(timezone.utc).date()
    from app.ingestion.dynastyprocess import write_dynastyprocess_snapshots
    from app.ingestion.fantasycalc import write_fantasycalc_snapshots
    from app.ingestion.rosteraudit import (
        RosterAuditClient,
        write_pick_snapshots,
        write_player_snapshots,
    )

    ra = RosterAuditClient()
    write_player_snapshots(conn, fmt, ra.get_player_values(fmt), today)
    write_pick_snapshots(conn, fmt, ra.get_pick_values(), today)
    for writer in (write_fantasycalc_snapshots, write_dynastyprocess_snapshots):
        try:
            writer(conn, [fmt], today)
        except Exception as e:
            logger.warning("Reference-source snapshot failed for %s (non-fatal): %s", fmt, e)
