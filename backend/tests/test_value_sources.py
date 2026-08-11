"""
Tests for the value source layer.

Covers:
- RosterAuditValueSource.get_player_value:
    - Returns correct value when exact snapshot date exists
    - Returns most-recent prior snapshot when exact date has no snapshot
    - Sets used_fallback=True when falling back to an older snapshot
    - Falls back to oldest snapshot when trade predates all snapshots
    - Returns (None, False) when no snapshots exist at all
- RosterAuditValueSource.get_pick_value:
    - Returns mid_value for matching (season, round)
    - Falls back to oldest available pick snapshot
- detect_format_key: maps Sleeper league objects to correct RA format keys
"""

import sqlite3
from datetime import date

import pytest

from app.db import init_schema
from app.ingestion.rosteraudit import detect_format_key
from app.value_sources import RosterAuditValueSource

# Shorthand for the source name used in all DB rows
SOURCE = "rosteraudit"


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    yield c
    c.close()


@pytest.fixture
def source(conn):
    return RosterAuditValueSource(conn)


def insert_player_snapshot(conn, player_id, fmt, snap_date, value):
    conn.execute(
        """
        INSERT OR REPLACE INTO value_snapshots
            (player_id, source, format, snapshot_date, value)
        VALUES (?, ?, ?, ?, ?)
        """,
        (player_id, SOURCE, fmt, snap_date.isoformat(), value),
    )
    conn.commit()


def insert_pick_snapshot(conn, season, round_num, fmt, snap_date, mid):
    conn.execute(
        """
        INSERT OR REPLACE INTO pick_value_snapshots
            (season, round, source, format, snapshot_date,
             early_value, mid_value, late_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (season, round_num, SOURCE, fmt, snap_date.isoformat(), mid + 500, mid, mid - 500),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Player value lookups
# ---------------------------------------------------------------------------

def test_exact_snapshot_date_returns_value(conn, source):
    insert_player_snapshot(conn, "7564", "sf_ppr", date(2024, 10, 1), 9200)

    value, used_fallback = source.get_player_value("7564", "sf_ppr", date(2024, 10, 1))
    assert value == 9200
    assert used_fallback is False


def test_most_recent_prior_snapshot(conn, source):
    insert_player_snapshot(conn, "7564", "sf_ppr", date(2024, 9, 1), 8800)
    insert_player_snapshot(conn, "7564", "sf_ppr", date(2024, 10, 1), 9200)

    # Trade date falls between the two snapshots — should return the Sep snapshot
    value, used_fallback = source.get_player_value("7564", "sf_ppr", date(2024, 9, 15))
    assert value == 8800
    # Sep 1 < Sep 15 so it's technically the "most recent prior" but not exact
    assert used_fallback is True


def test_exact_snapshot_not_fallback(conn, source):
    insert_player_snapshot(conn, "7564", "sf_ppr", date(2024, 9, 1), 8800)

    # Asking for exactly Sep 1 — no fallback
    value, used_fallback = source.get_player_value("7564", "sf_ppr", date(2024, 9, 1))
    assert value == 8800
    assert used_fallback is False


def test_falls_back_to_oldest_when_trade_predates_all_snapshots(conn, source):
    # Only has a 2025 snapshot, but trade was in 2023
    insert_player_snapshot(conn, "7564", "sf_ppr", date(2025, 1, 1), 9500)

    value, used_fallback = source.get_player_value("7564", "sf_ppr", date(2023, 9, 1))
    assert value == 9500
    assert used_fallback is True


def test_no_snapshots_returns_none(conn, source):
    value, used_fallback = source.get_player_value("NONEXISTENT", "sf_ppr", date(2024, 1, 1))
    assert value is None
    assert used_fallback is False


def test_format_isolation(conn, source):
    """Values for sf_ppr and 1qb_ppr should be stored and retrieved independently."""
    insert_player_snapshot(conn, "6794", "sf_ppr", date(2024, 10, 1), 8800)
    insert_player_snapshot(conn, "6794", "1qb_ppr", date(2024, 10, 1), 6200)

    sf_val, _ = source.get_player_value("6794", "sf_ppr", date(2024, 10, 1))
    qb_val, _ = source.get_player_value("6794", "1qb_ppr", date(2024, 10, 1))
    assert sf_val == 8800
    assert qb_val == 6200


# ---------------------------------------------------------------------------
# Pick value lookups
# ---------------------------------------------------------------------------

def test_pick_value_returns_mid_value(conn, source):
    insert_pick_snapshot(conn, 2024, 1, "sf_ppr", date(2024, 10, 1), 4000)

    value, used_fallback = source.get_pick_value(2024, 1, "sf_ppr", date(2024, 10, 1))
    assert value == 4000
    assert used_fallback is False


def test_pick_falls_back_to_oldest(conn, source):
    # Only 2025 snapshot, but asking for 2023 date
    insert_pick_snapshot(conn, 2024, 1, "sf_ppr", date(2025, 1, 1), 3500)

    value, used_fallback = source.get_pick_value(2024, 1, "sf_ppr", date(2023, 6, 1))
    assert value == 3500
    assert used_fallback is True


def test_pick_no_snapshot_returns_none(conn, source):
    value, used_fallback = source.get_pick_value(2030, 1, "sf_ppr", date(2024, 1, 1))
    assert value is None
    assert used_fallback is False


def test_pick_round_isolation(conn, source):
    insert_pick_snapshot(conn, 2024, 1, "sf_ppr", date(2024, 10, 1), 4000)
    insert_pick_snapshot(conn, 2024, 2, "sf_ppr", date(2024, 10, 1), 1800)

    r1_val, _ = source.get_pick_value(2024, 1, "sf_ppr", date(2024, 10, 1))
    r2_val, _ = source.get_pick_value(2024, 2, "sf_ppr", date(2024, 10, 1))
    assert r1_val == 4000
    assert r2_val == 1800


# ---------------------------------------------------------------------------
# detect_format_key
# ---------------------------------------------------------------------------

def make_league(positions: list[str], bonus_rec_te: float = 0.0) -> dict:
    return {
        "league_id": "TEST",
        "roster_positions": positions,
        "scoring_settings": {"bonus_rec_te": bonus_rec_te},
    }


def test_detect_sf_ppr():
    league = make_league(["QB", "RB", "WR", "TE", "SUPER_FLEX"])
    assert detect_format_key(league) == "sf_ppr"


def test_detect_sf_ppr_tep():
    league = make_league(["QB", "RB", "WR", "TE", "SUPER_FLEX"], bonus_rec_te=0.5)
    assert detect_format_key(league) == "sf_ppr_tep"


def test_detect_1qb_ppr():
    league = make_league(["QB", "RB", "WR", "TE", "FLEX"])
    assert detect_format_key(league) == "1qb_ppr"


def test_detect_1qb_ppr_tep():
    league = make_league(["QB", "RB", "WR", "TE", "FLEX"], bonus_rec_te=0.5)
    assert detect_format_key(league) == "1qb_ppr_tep"


def test_detect_format_key_override(monkeypatch):
    import app.ingestion.rosteraudit as ra
    monkeypatch.setitem(ra.FORMAT_KEY_OVERRIDES, "OVERRIDE_LEAGUE", "sf_ppr_tep")
    league = make_league(["QB", "RB", "WR", "TE", "FLEX"])  # would normally be 1qb_ppr
    league["league_id"] = "OVERRIDE_LEAGUE"
    assert detect_format_key(league) == "sf_ppr_tep"
