"""
Tests for the league chain walking and ingestion pipeline.

Covers:
- walk_league_chain follows previous_league_id backward and returns all seasons
- walk_league_chain returns leagues in chronological order (oldest first)
- walk_league_chain stops when previous_league_id is None/missing
- Cycle detection: walk_league_chain stops if it encounters an already-seen ID
- ingest_league_metadata stores correct format_key and season
- ingest_trades correctly parses Sleeper transaction structure and skips non-trades
- ingest_trades is idempotent (re-running doesn't create duplicates)
"""

import json
import sqlite3
from unittest.mock import MagicMock, patch

import pytest
import responses as resp_lib

from app.db import init_schema
from app.ingestion.sleeper import SleeperClient
from scripts.ingest_leagues import (
    ingest_league_metadata,
    ingest_trades,
    walk_league_chain,
)


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    yield c
    c.close()


@pytest.fixture
def client(conn):
    return SleeperClient(conn)


# ---------------------------------------------------------------------------
# Helpers to build mock Sleeper responses
# ---------------------------------------------------------------------------

def make_league(league_id: str, season: int, previous_id: str | None = None) -> dict:
    return {
        "league_id": league_id,
        "name": f"Test League {season}",
        "season": season,
        "previous_league_id": previous_id,
        "roster_positions": ["QB", "RB", "WR", "TE", "SUPER_FLEX"],
        "scoring_settings": {"rec": 0.5, "bonus_rec_te": 0.0},
    }


def make_trade_tx(tx_id: str, roster_ids: list[int]) -> dict:
    return {
        "transaction_id": tx_id,
        "type": "trade",
        "status": "complete",
        "status_updated": 1700000000000,  # Unix ms
        "roster_ids": roster_ids,
        "adds": {"PLAYER1": roster_ids[1], "PLAYER2": roster_ids[0]},
        "drops": {"PLAYER1": roster_ids[0], "PLAYER2": roster_ids[1]},
        "draft_picks": [],
        "waiver_budget": [],
    }


# ---------------------------------------------------------------------------
# walk_league_chain
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_chain_walks_backward_three_seasons(conn, client):
    """Chain: 2024 → 2023 → 2022 → None"""
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/LEAGUE_2024",
        json=make_league("LEAGUE_2024", 2024, "LEAGUE_2023"),
    )
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/LEAGUE_2023",
        json=make_league("LEAGUE_2023", 2023, "LEAGUE_2022"),
    )
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/LEAGUE_2022",
        json=make_league("LEAGUE_2022", 2022, None),
    )

    chain = walk_league_chain(client, "LEAGUE_2024")

    assert len(chain) == 3
    # Chronological order: oldest first
    seasons = [lg["season"] for lg in chain]
    assert seasons == [2022, 2023, 2024]


@resp_lib.activate
def test_chain_single_season(conn, client):
    """League with no previous_league_id — returns just the one season."""
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/SOLO",
        json=make_league("SOLO", 2024, None),
    )

    chain = walk_league_chain(client, "SOLO")
    assert len(chain) == 1
    assert chain[0]["league_id"] == "SOLO"


@resp_lib.activate
def test_chain_cycle_detection(conn, client):
    """Cycle A → B → A should not loop forever."""
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/CYCLE_A",
        json=make_league("CYCLE_A", 2024, "CYCLE_B"),
    )
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/CYCLE_B",
        json=make_league("CYCLE_B", 2023, "CYCLE_A"),  # points back — cycle!
    )

    chain = walk_league_chain(client, "CYCLE_A")
    # Should get both leagues but stop before looping
    assert len(chain) == 2
    ids = {lg["league_id"] for lg in chain}
    assert ids == {"CYCLE_A", "CYCLE_B"}


@resp_lib.activate
def test_chain_empty_previous_league_id_string(conn, client):
    """Some Sleeper responses have previous_league_id as '' — treat as None."""
    league = make_league("EMPTY_PREV", 2024, "")
    league["previous_league_id"] = ""
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/EMPTY_PREV",
        json=league,
    )

    chain = walk_league_chain(client, "EMPTY_PREV")
    assert len(chain) == 1


# ---------------------------------------------------------------------------
# ingest_league_metadata
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_ingest_league_metadata_stores_format_key(conn):
    league = make_league("META_TEST", 2024, None)
    ingest_league_metadata(conn, league)

    row = conn.execute(
        "SELECT format_key, season, name FROM leagues WHERE id = ?", ("META_TEST",)
    ).fetchone()
    assert row is not None
    assert row["format_key"] == "sf_ppr"
    assert row["season"] == 2024
    assert row["name"] == "Test League 2024"


def test_ingest_league_metadata_idempotent(conn):
    league = make_league("IDEM_TEST", 2024, None)
    ingest_league_metadata(conn, league)
    ingest_league_metadata(conn, league)  # second run should not fail

    count = conn.execute(
        "SELECT COUNT(*) FROM leagues WHERE id = ?", ("IDEM_TEST",)
    ).fetchone()[0]
    assert count == 1


# ---------------------------------------------------------------------------
# ingest_trades
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_ingest_trades_stores_trades(conn, client):
    tx = make_trade_tx("TX_001", [1, 2])
    # Register week 1 response with our trade; all other weeks return empty
    for week in range(1, 19):
        txs = [tx] if week == 1 else []
        resp_lib.add(
            resp_lib.GET,
            f"https://api.sleeper.app/v1/league/TRADE_LEAGUE/transactions/{week}",
            json=txs,
        )

    roster_to_user = {1: "USER_A", 2: "USER_B"}
    trades_stored = ingest_trades(conn, client, "TRADE_LEAGUE", 2024, roster_to_user)

    assert trades_stored == 1
    row = conn.execute("SELECT * FROM trades WHERE id = ?", ("TX_001",)).fetchone()
    assert row is not None
    assert row["league_id"] == "TRADE_LEAGUE"
    assert row["week"] == 1


@resp_lib.activate
def test_ingest_trades_skips_non_trades(conn, client):
    waiver = {
        "transaction_id": "WAIVER_001",
        "type": "waiver",
        "roster_ids": [1],
    }
    for week in range(1, 19):
        txs = [waiver] if week == 1 else []
        resp_lib.add(
            resp_lib.GET,
            f"https://api.sleeper.app/v1/league/WAIVER_LEAGUE/transactions/{week}",
            json=txs,
        )

    trades_stored = ingest_trades(conn, client, "WAIVER_LEAGUE", 2024, {})
    assert trades_stored == 0


@resp_lib.activate
def test_ingest_trades_idempotent(conn, client):
    tx = make_trade_tx("TX_IDEM", [1, 2])
    for week in range(1, 19):
        txs = [tx] if week == 1 else []
        resp_lib.add(
            resp_lib.GET,
            f"https://api.sleeper.app/v1/league/IDEM_LEAGUE/transactions/{week}",
            json=txs,
        )

    roster_to_user = {1: "USER_A", 2: "USER_B"}
    # Sleeper client caches transactions, so we need to call twice
    # but the second ingest_trades call should find the cached TX and skip it
    first_run = ingest_trades(conn, client, "IDEM_LEAGUE", 2024, roster_to_user)

    # For second run, re-register the same responses (cache will handle it)
    for week in range(1, 19):
        txs = [tx] if week == 1 else []
        resp_lib.add(
            resp_lib.GET,
            f"https://api.sleeper.app/v1/league/IDEM_LEAGUE/transactions/{week}",
            json=txs,
        )
    second_run = ingest_trades(conn, client, "IDEM_LEAGUE", 2024, roster_to_user)

    assert first_run == 1
    assert second_run == 0  # already in DB, nothing new stored

    count = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    assert count == 1


@resp_lib.activate
def test_ingest_trades_creates_trade_sides(conn, client):
    tx = make_trade_tx("TX_SIDES", [3, 5])
    for week in range(1, 19):
        txs = [tx] if week == 1 else []
        resp_lib.add(
            resp_lib.GET,
            f"https://api.sleeper.app/v1/league/SIDES_LEAGUE/transactions/{week}",
            json=txs,
        )

    roster_to_user = {3: "USER_C", 5: "USER_E"}
    ingest_trades(conn, client, "SIDES_LEAGUE", 2024, roster_to_user)

    sides = conn.execute(
        "SELECT roster_id, user_id FROM trade_sides WHERE trade_id = ? ORDER BY roster_id",
        ("TX_SIDES",),
    ).fetchall()
    assert len(sides) == 2
    assert sides[0]["user_id"] == "USER_C"
    assert sides[1]["user_id"] == "USER_E"


@resp_lib.activate
def test_ingest_trades_creates_player_assets(conn, client):
    tx = make_trade_tx("TX_ASSETS", [1, 2])
    for week in range(1, 19):
        txs = [tx] if week == 1 else []
        resp_lib.add(
            resp_lib.GET,
            f"https://api.sleeper.app/v1/league/ASSETS_LEAGUE/transactions/{week}",
            json=txs,
        )

    ingest_trades(conn, client, "ASSETS_LEAGUE", 2024, {1: "U1", 2: "U2"})

    assets = conn.execute(
        "SELECT asset_type, player_id FROM trade_assets WHERE trade_id = ? ORDER BY player_id",
        ("TX_ASSETS",),
    ).fetchall()
    assert len(assets) == 2
    assert all(a["asset_type"] == "player" for a in assets)
    player_ids = {a["player_id"] for a in assets}
    assert player_ids == {"PLAYER1", "PLAYER2"}
