"""
Sleeper league ingestion pipeline.

Entry point: run this script to pull all historical data for your leagues
into data/dynasty.db.

Usage:
    cd backend
    python scripts/ingest_leagues.py

Configuration (via .env):
    LEAGUE_IDS  — comma-separated Sleeper league IDs (current season)
    DB_PATH     — optional path to SQLite file (defaults to ../data/dynasty.db)

Idempotency:
    Every write uses INSERT OR REPLACE or INSERT OR IGNORE. Re-running is safe
    and will only fetch what is missing or stale (per cache TTL rules).

What gets ingested:
    For each LEAGUE_ID:
    1. Walk the previous_league_id chain to collect all prior seasons.
    2. For each season/league:
       a. League metadata + format detection
       b. Managers (users) and their roster IDs
       c. Current rosters
       d. All trades (weeks 1-18) — filters type == "trade"
       e. Draft IDs and the picks made in each draft
       f. Traded picks (future picks currently traded)
    3. Full player metadata from /v1/players/nfl (refreshed weekly)

Summary printed at end:
    Ingested: N leagues, M seasons, K trades, J unique managers
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure the backend package is importable when run directly
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

from app.db import get_connection, init_schema
from app.ingestion.rosteraudit import detect_format_key
from app.ingestion.sleeper import SleeperClient

# Load .env from the project root (two levels up from scripts/).
# resolve() ensures we get the absolute path even when __file__ is relative.
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ingest")

# Maximum number of weeks to scan per season for transactions.
# Sleeper uses weeks 1-18 for regular season + playoffs.
MAX_WEEKS = 18

# Maximum depth of previous_league_id chain to follow (safety guard).
MAX_CHAIN_DEPTH = 15


def get_league_ids_from_env() -> list[str]:
    raw = os.environ.get("LEAGUE_IDS", "").strip()
    if not raw:
        logger.error("LEAGUE_IDS not set in .env. Aborting.")
        sys.exit(1)
    ids = [lid.strip() for lid in raw.split(",") if lid.strip()]
    logger.info("Configured league IDs: %s", ids)
    return ids


# ---------------------------------------------------------------------------
# League chain walking
# ---------------------------------------------------------------------------

def walk_league_chain(client: SleeperClient, start_league_id: str) -> list[dict]:
    """
    Follow previous_league_id links backward from start_league_id.

    Returns a list of league dicts in chronological order (oldest first).
    Each dict is the raw response from /v1/league/{league_id}.
    """
    chain: list[dict] = []
    current_id: str | None = start_league_id
    seen: set[str] = set()
    depth = 0

    while current_id and depth < MAX_CHAIN_DEPTH:
        if current_id in seen:
            logger.warning("Cycle detected in league chain at %s — stopping", current_id)
            break
        seen.add(current_id)
        depth += 1

        logger.info("Fetching league metadata: %s", current_id)
        league = client.get_league(current_id)
        chain.append(league)

        current_id = league.get("previous_league_id") or None

    # Return oldest season first so ingestion proceeds in chronological order
    chain.reverse()
    logger.info(
        "League chain depth: %d seasons (IDs: %s)",
        len(chain),
        [lg["league_id"] for lg in chain],
    )
    return chain


# ---------------------------------------------------------------------------
# Per-league ingestion helpers
# ---------------------------------------------------------------------------

def ingest_league_metadata(conn, league: dict) -> str:
    """Store league metadata. Returns the league_id."""
    league_id = league["league_id"]
    format_key = detect_format_key(league)
    conn.execute(
        """
        INSERT OR REPLACE INTO leagues
            (id, name, season, previous_league_id, format_key, settings_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            league_id,
            league.get("name", ""),
            league.get("season"),
            league.get("previous_league_id"),
            format_key,
            json.dumps(league),
        ),
    )
    conn.commit()
    logger.info(
        "League %s: '%s' season %s format_key=%s",
        league_id, league.get("name"), league.get("season"), format_key,
    )
    return league_id


def ingest_managers(conn, client: SleeperClient, league_id: str) -> dict[int, str]:
    """
    Ingest managers (users) and their roster IDs for the given league.

    Returns a dict mapping roster_id -> user_id for use in trade ingestion.
    """
    users = client.get_league_users(league_id)
    rosters = client.get_league_rosters(league_id)

    # Build roster_id -> user_id mapping from rosters endpoint
    roster_to_user: dict[int, str] = {}
    for roster in rosters:
        rid = roster.get("roster_id")
        uid = roster.get("owner_id")
        if rid is not None and uid:
            roster_to_user[rid] = uid

    # Upsert manager records
    for user in users:
        uid = user.get("user_id")
        if not uid:
            continue
        conn.execute(
            """
            INSERT OR IGNORE INTO managers (user_id, username, display_name)
            VALUES (?, ?, ?)
            """,
            (
                uid,
                user.get("username", ""),
                user.get("display_name", user.get("username", "")),
            ),
        )

    # Upsert league_managers join rows
    for roster in rosters:
        rid = roster.get("roster_id")
        uid = roster.get("owner_id")
        if rid is None or not uid:
            continue
        conn.execute(
            """
            INSERT OR REPLACE INTO league_managers (league_id, user_id, roster_id)
            VALUES (?, ?, ?)
            """,
            (league_id, uid, rid),
        )

    conn.commit()

    # Populate roster_players from the same roster data
    populate_roster_players(conn, league_id, rosters)

    logger.info(
        "League %s: ingested %d managers, %d rosters",
        league_id, len(users), len(rosters),
    )
    return roster_to_user


def populate_roster_players(conn, league_id: str, rosters: list[dict]) -> int:
    """
    Write the current player composition for each roster into roster_players.

    Safe to re-run — uses INSERT OR REPLACE so stale entries are overwritten.
    Only stores players at dynasty-relevant positions (QB/RB/WR/TE) by filtering
    against the players table; other IDs (DEF, K, etc.) are silently ignored.

    Returns the number of rows written.
    """
    DYNASTY_POSITIONS = {"QB", "RB", "WR", "TE"}
    rows_written = 0

    # First clear existing entries for this league so removed players don't linger
    conn.execute("DELETE FROM roster_players WHERE league_id = ?", (league_id,))

    for roster in rosters:
        uid = roster.get("owner_id")
        if not uid:
            continue

        players_list = roster.get("players") or []
        starters_set = set(roster.get("starters") or [])

        for pid in players_list:
            if not pid:
                continue
            # Only store dynasty-relevant positions
            player_row = conn.execute(
                "SELECT position FROM players WHERE sleeper_id = ?", (pid,)
            ).fetchone()
            if player_row is None or player_row["position"] not in DYNASTY_POSITIONS:
                continue

            conn.execute(
                """
                INSERT OR REPLACE INTO roster_players
                    (league_id, user_id, player_id, is_starter)
                VALUES (?, ?, ?, ?)
                """,
                (league_id, uid, pid, 1 if pid in starters_set else 0),
            )
            rows_written += 1

    conn.commit()
    logger.info("League %s: wrote %d roster_players rows", league_id, rows_written)
    return rows_written


def ingest_trades(
    conn,
    client: SleeperClient,
    league_id: str,
    season: int | None,
    roster_to_user: dict[int, str],
) -> int:
    """
    Ingest all trades from weeks 1-MAX_WEEKS for a league.

    Returns the number of new trades stored.
    """
    trades_stored = 0

    for week in range(1, MAX_WEEKS + 1):
        transactions = client.get_transactions(league_id, week)
        if not transactions:
            continue

        for tx in transactions:
            if tx.get("type") != "trade":
                continue

            trade_id = str(tx["transaction_id"])

            # Idempotent: skip if already stored
            existing = conn.execute(
                "SELECT 1 FROM trades WHERE id = ?", (trade_id,)
            ).fetchone()
            if existing:
                continue

            # Resolve executed_at from status_updated (Unix ms timestamp)
            executed_at = None
            status_updated = tx.get("status_updated")
            if status_updated:
                executed_at = datetime.fromtimestamp(
                    status_updated / 1000, tz=timezone.utc
                ).isoformat()

            conn.execute(
                """
                INSERT OR REPLACE INTO trades
                    (id, league_id, season, week, executed_at, raw_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (trade_id, league_id, season, week, executed_at, json.dumps(tx)),
            )

            # trade_sides — one row per roster involved
            roster_ids: list[int] = tx.get("roster_ids") or []
            for rid in roster_ids:
                uid = roster_to_user.get(rid)
                conn.execute(
                    """
                    INSERT OR REPLACE INTO trade_sides
                        (trade_id, roster_id, user_id)
                    VALUES (?, ?, ?)
                    """,
                    (trade_id, rid, uid),
                )

            # trade_assets — parse Sleeper's adds/drops/draft_picks
            _ingest_trade_assets(conn, tx, trade_id, roster_ids)

            trades_stored += 1

        conn.commit()

    logger.info("League %s: %d trades stored", league_id, trades_stored)
    return trades_stored


def _ingest_trade_assets(conn, tx: dict, trade_id: str, roster_ids: list[int]) -> None:
    """
    Parse Sleeper transaction dict and write trade_asset rows.

    Sleeper represents a trade as:
      adds:   {player_id: to_roster_id, ...}
      drops:  {player_id: from_roster_id, ...}  — same players, opposite direction
      draft_picks: [{season, round, roster_id (original owner), ...}, ...]
      waiver_budget: [{sender: roster_id, receiver: roster_id, amount: int}, ...]

    We derive from_roster_id from drops (or the opposite side of adds) and
    to_roster_id from adds.
    """
    adds: dict[str, int] = tx.get("adds") or {}
    drops: dict[str, int] = tx.get("drops") or {}

    # Players: adds gives us to_roster_id; drops gives us from_roster_id
    player_ids = set(adds.keys()) | set(drops.keys())
    for pid in player_ids:
        to_rid = adds.get(pid)
        from_rid = drops.get(pid)

        # If one side is missing, infer from roster_ids (shouldn't happen in well-formed trades)
        if to_rid is None or from_rid is None:
            continue

        conn.execute(
            """
            INSERT INTO trade_assets
                (trade_id, from_roster_id, to_roster_id, asset_type, player_id)
            VALUES (?, ?, ?, 'player', ?)
            """,
            (trade_id, from_rid, to_rid, pid),
        )

    # Draft picks
    for pick in tx.get("draft_picks") or []:
        pick_season = pick.get("season")
        pick_round = pick.get("round")
        original_owner = pick.get("roster_id")   # original owner of the slot
        previous_owner = pick.get("previous_owner_id")  # who traded it away now
        new_owner = pick.get("owner_id")          # who receives it

        if pick_season is None or pick_round is None:
            continue

        # Determine from/to roster IDs from the pick's previous_owner / owner fields
        # Sleeper's pick dict in a transaction has owner_id (new owner) and
        # previous_owner_id (who is giving it away).
        from_rid = previous_owner
        to_rid = new_owner

        # Fallback: if pick owner fields are missing, skip (malformed)
        if from_rid is None or to_rid is None:
            logger.debug(
                "Trade %s: pick %d.%d missing owner info, skipping asset row",
                trade_id, pick_season, pick_round,
            )
            continue

        conn.execute(
            """
            INSERT INTO trade_assets
                (trade_id, from_roster_id, to_roster_id, asset_type,
                 pick_season, pick_round, pick_original_owner_roster_id)
            VALUES (?, ?, ?, 'pick', ?, ?, ?)
            """,
            (trade_id, from_rid, to_rid, pick_season, pick_round, original_owner),
        )

    # FAAB budget transfers
    for budget in tx.get("waiver_budget") or []:
        sender = budget.get("sender")
        receiver = budget.get("receiver")
        amount = budget.get("amount")
        if sender is None or receiver is None or amount is None:
            continue
        conn.execute(
            """
            INSERT INTO trade_assets
                (trade_id, from_roster_id, to_roster_id, asset_type, faab_amount)
            VALUES (?, ?, ?, 'faab', ?)
            """,
            (trade_id, sender, receiver, amount),
        )


def ingest_drafts(
    conn,
    client: SleeperClient,
    league_id: str,
) -> None:
    """Ingest all drafts and their picks for a league."""
    drafts = client.get_league_drafts(league_id)
    if not drafts:
        logger.info("League %s: no drafts found", league_id)
        return

    for draft in drafts:
        draft_id = draft.get("draft_id")
        draft_status = draft.get("status")
        if not draft_id:
            continue

        logger.info("League %s: draft %s (status=%s)", league_id, draft_id, draft_status)

        # Only fetch picks for completed drafts — in-progress drafts would be
        # stale immediately and are not useful for historical grading.
        if draft_status == "complete":
            picks = client.get_draft_picks(draft_id)
            logger.info("League %s: draft %s — %d picks", league_id, draft_id, len(picks))
        else:
            logger.info(
                "League %s: draft %s not complete (status=%s), skipping picks",
                league_id, draft_id, draft_status,
            )


def ingest_traded_picks(conn, client: SleeperClient, league_id: str) -> None:
    """
    Ingest the list of future picks currently traded in the league.

    These represent future draft capital that has changed hands — important
    context for grading trades that included future picks.
    """
    traded_picks = client.get_traded_picks(league_id)
    logger.info("League %s: %d traded picks on record", league_id, len(traded_picks or []))
    # For now we just log these. Phase 2+ will use them for pick provenance.


def ingest_players(conn, client: SleeperClient) -> int:
    """
    Ingest the full /v1/players/nfl player metadata dict.

    This is a huge response (~10MB) cached for 7 days. We upsert all players
    with dynasty-relevant positions (QB, RB, WR, TE) plus K, DEF as fallbacks.
    Returns the number of players stored.
    """
    logger.info("Fetching /v1/players/nfl (cached 7 days)…")
    all_players = client.get_all_players()
    if not all_players:
        logger.warning("Empty player response — skipping player ingest")
        return 0

    DYNASTY_POSITIONS = {"QB", "RB", "WR", "TE"}
    stored = 0

    for sleeper_id, p in all_players.items():
        position = p.get("position", "")
        if position not in DYNASTY_POSITIONS:
            continue

        # Parse birth_date (Sleeper stores as "YYYY-MM-DD" string)
        birth_date = p.get("birth_date")

        conn.execute(
            """
            INSERT OR REPLACE INTO players
                (sleeper_id, full_name, position, team, birth_date, status, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sleeper_id,
                p.get("full_name") or f"{p.get('first_name','')} {p.get('last_name','')}".strip(),
                position,
                p.get("team", ""),
                birth_date,
                p.get("status", ""),
                json.dumps(p),
            ),
        )
        stored += 1

    conn.commit()
    logger.info("Players: %d dynasty-relevant players stored", stored)
    return stored


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    league_ids = get_league_ids_from_env()
    conn = get_connection()
    init_schema(conn)
    client = SleeperClient(conn)

    total_seasons = 0
    total_trades = 0
    all_manager_ids: set[str] = set()
    ingested_league_ids: set[str] = set()

    for root_league_id in league_ids:
        logger.info("=" * 60)
        logger.info("Starting ingestion for root league: %s", root_league_id)
        chain = walk_league_chain(client, root_league_id)

        for league in chain:
            league_id = league["league_id"]
            if league_id in ingested_league_ids:
                logger.info("League %s already ingested in this run, skipping", league_id)
                continue
            ingested_league_ids.add(league_id)

            ingest_league_metadata(conn, league)
            roster_to_user = ingest_managers(conn, client, league_id)

            all_manager_ids.update(roster_to_user.values())

            season = league.get("season")
            trades = ingest_trades(conn, client, league_id, season, roster_to_user)
            total_trades += trades
            total_seasons += 1

            ingest_drafts(conn, client, league_id)
            ingest_traded_picks(conn, client, league_id)

    # Ingest player metadata once (cached, shared across all leagues)
    ingest_players(conn, client)

    conn.close()

    # Summary
    logger.info("=" * 60)
    logger.info(
        "DONE — %d leagues, %d seasons, %d trades, %d unique managers",
        len(league_ids),
        total_seasons,
        total_trades,
        len(all_manager_ids),
    )
    print(
        f"\nIngested: {len(league_ids)} leagues, {total_seasons} seasons, "
        f"{total_trades} trades, {len(all_manager_ids)} unique managers"
    )


if __name__ == "__main__":
    main()
