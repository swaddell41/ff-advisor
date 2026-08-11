"""
Tests for the trade grading engine.

Covers:
- assign_letter_grade: parametrized across all grade buckets
- grade_trade: end-to-end with a hand-constructed trade dict
  - correct differential and letter grade
  - idempotency (re-run produces the same result, not duplicates)
  - used_value_fallback flag set correctly
- grade_trade with picks: correct pick value lookup
- grade_trade with zero-value assets: neutral grade
"""

import sqlite3
from datetime import date

import pytest

from app.db import init_schema
from app.grading.engine import assign_letter_grade, grade_trade
from app.value_sources import RosterAuditValueSource

SOURCE = "rosteraudit"


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    yield c
    c.close()


# ---------------------------------------------------------------------------
# Helpers for building fixture data
# ---------------------------------------------------------------------------

def insert_league(conn, league_id="LG1", fmt="sf_ppr"):
    conn.execute(
        "INSERT OR REPLACE INTO leagues (id, name, season, format_key) VALUES (?, ?, ?, ?)",
        (league_id, "Test League", 2024, fmt),
    )
    conn.commit()


def insert_manager(conn, user_id, name="Manager"):
    conn.execute(
        "INSERT OR IGNORE INTO managers (user_id, username, display_name) VALUES (?, ?, ?)",
        (user_id, name, name),
    )
    conn.commit()


def insert_trade(conn, trade_id, league_id="LG1", week=5, executed_at="2024-10-01T12:00:00+00:00"):
    conn.execute(
        "INSERT OR REPLACE INTO trades (id, league_id, season, week, executed_at, raw_json) "
        "VALUES (?, ?, 2024, ?, ?, '{}')",
        (trade_id, league_id, week, executed_at),
    )
    conn.commit()


def insert_trade_side(conn, trade_id, roster_id, user_id):
    conn.execute(
        "INSERT OR REPLACE INTO trade_sides (trade_id, roster_id, user_id) VALUES (?, ?, ?)",
        (trade_id, roster_id, user_id),
    )
    conn.commit()


def insert_player_asset(conn, trade_id, player_id, from_rid, to_rid):
    conn.execute(
        "INSERT INTO trade_assets (trade_id, from_roster_id, to_roster_id, asset_type, player_id) "
        "VALUES (?, ?, ?, 'player', ?)",
        (trade_id, from_rid, to_rid, player_id),
    )
    conn.commit()


def insert_pick_asset(conn, trade_id, season, round_num, from_rid, to_rid):
    conn.execute(
        "INSERT INTO trade_assets "
        "(trade_id, from_roster_id, to_roster_id, asset_type, pick_season, pick_round, "
        "pick_original_owner_roster_id) VALUES (?, ?, ?, 'pick', ?, ?, ?)",
        (trade_id, from_rid, to_rid, season, round_num, from_rid),
    )
    conn.commit()


def insert_player_snapshot(conn, player_id, fmt, snap_date, value):
    conn.execute(
        "INSERT OR REPLACE INTO value_snapshots (player_id, source, format, snapshot_date, value) "
        "VALUES (?, ?, ?, ?, ?)",
        (player_id, SOURCE, fmt, snap_date.isoformat(), value),
    )
    conn.commit()


def insert_pick_snapshot(conn, season, round_num, fmt, snap_date, mid):
    conn.execute(
        "INSERT OR REPLACE INTO pick_value_snapshots "
        "(season, round, source, format, snapshot_date, early_value, mid_value, late_value) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (season, round_num, SOURCE, fmt, snap_date.isoformat(), mid + 500, mid, mid - 300),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# assign_letter_grade — parametrized
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("received,given,expected_grade", [
    # pct = differential / max(received, given)
    # A+ : pct >= 25%  → when received>given: (R-G)/R >= 0.25 → R >= G*(4/3)
    (14000, 10000, "A+"),   # (14000-10000)/14000 = 28.6%
    (20000, 10000, "A+"),   # (20000-10000)/20000 = 50%
    # A : 15% to 25%
    (12000, 10000, "A"),    # (12000-10000)/12000 = 16.7%
    (13000, 10000, "A"),    # (13000-10000)/13000 = 23.1%
    # A- : 8% to 15%
    (10900, 10000, "A-"),   # (10900-10000)/10900 = 8.26%
    (11600, 10000, "A-"),   # (11600-10000)/11600 = 13.8%
    # B+ : 3% to 8%
    (10400, 10000, "B+"),   # (10400-10000)/10400 = 3.85%
    (10750, 10000, "B+"),   # (10750-10000)/10750 = 6.98%
    # B : -3% to +3%
    (10000, 10000, "B"),    # 0%
    (9700, 10000, "B"),     # (9700-10000)/10000 = -3% exactly → B (>= -0.03)
    (10200, 10000, "B"),    # (10200-10000)/10200 = 1.96%
    # B- : -3% to -8%
    (9600, 10000, "B-"),    # -400/10000 = -4%
    (9200, 10000, "B-"),    # -800/10000 = -8% exactly → B- (>= -0.08)
    # C : -8% to -15%
    (9100, 10000, "C"),     # -900/10000 = -9%
    (8600, 10000, "C"),     # -1400/10000 = -14%
    # D : -15% to -25%
    (8490, 10000, "D"),     # -1510/10000 = -15.1%
    (7600, 10000, "D"),     # -2400/10000 = -24%
    # F : <= -25%
    (7490, 10000, "F"),     # -2510/10000 = -25.1%
    (5000, 10000, "F"),     # -5000/10000 = -50%
    # Edge case: both sides zero
    (0, 0, "B"),
])
def test_assign_letter_grade(received, given, expected_grade):
    differential = received - given
    assert assign_letter_grade(differential, received, given) == expected_grade


# ---------------------------------------------------------------------------
# End-to-end: grade a hand-constructed trade with players
# ---------------------------------------------------------------------------

def test_grade_trade_player_differential(conn):
    """
    Side 1 (roster 1) gives P1 (value 8000), receives P2 (value 14000).
    pct = (14000-8000)/14000 = 6000/14000 = 42.9% → A+
    Side 2 (roster 2): gives 14000, receives 8000 → pct = -6000/14000 = -42.9% → F
    """
    insert_league(conn)
    insert_trade(conn, "T1")
    insert_trade_side(conn, "T1", 1, "U1")
    insert_trade_side(conn, "T1", 2, "U2")
    insert_player_asset(conn, "T1", "P1", from_rid=1, to_rid=2)
    insert_player_asset(conn, "T1", "P2", from_rid=2, to_rid=1)

    snap_date = date(2024, 10, 1)
    insert_player_snapshot(conn, "P1", "sf_ppr", snap_date, 8000)
    insert_player_snapshot(conn, "P2", "sf_ppr", snap_date, 14000)

    source = RosterAuditValueSource(conn)
    rows = grade_trade(conn, "T1", source, current_date=snap_date)
    assert rows == 4  # 2 sides × 2 grade types

    r1_decision = conn.execute(
        "SELECT * FROM trade_grades WHERE trade_id='T1' AND side_roster_id=1 AND grade_type='decision'"
    ).fetchone()
    assert r1_decision["total_value_received"] == 14000
    assert r1_decision["total_value_given"] == 8000
    assert r1_decision["differential"] == 6000
    assert r1_decision["letter_grade"] == "A+"

    r2_decision = conn.execute(
        "SELECT * FROM trade_grades WHERE trade_id='T1' AND side_roster_id=2 AND grade_type='decision'"
    ).fetchone()
    assert r2_decision["differential"] == -6000
    assert r2_decision["letter_grade"] == "F"


def test_grade_trade_with_pick(conn):
    """
    Side 1 gives player P1 (8000), receives a 2025 1st (mid value 5000).
    differential = 5000 - 8000 = -3000, pct = -37.5% → F
    """
    insert_league(conn)
    insert_trade(conn, "T2")
    insert_trade_side(conn, "T2", 1, "U1")
    insert_trade_side(conn, "T2", 2, "U2")
    insert_player_asset(conn, "T2", "P1", from_rid=1, to_rid=2)
    insert_pick_asset(conn, "T2", 2025, 1, from_rid=2, to_rid=1)

    snap_date = date(2024, 10, 1)
    insert_player_snapshot(conn, "P1", "sf_ppr", snap_date, 8000)
    insert_pick_snapshot(conn, 2025, 1, "sf_ppr", snap_date, 5000)

    source = RosterAuditValueSource(conn)
    grade_trade(conn, "T2", source, current_date=snap_date)

    r1 = conn.execute(
        "SELECT * FROM trade_grades WHERE trade_id='T2' AND side_roster_id=1 AND grade_type='decision'"
    ).fetchone()
    assert r1["total_value_received"] == 5000
    assert r1["total_value_given"] == 8000
    assert r1["differential"] == -3000
    assert r1["letter_grade"] == "F"


def test_grade_trade_idempotent(conn):
    """Running grade_trade twice should produce the same rows, not double them."""
    insert_league(conn)
    insert_trade(conn, "T3")
    insert_trade_side(conn, "T3", 1, "U1")
    insert_trade_side(conn, "T3", 2, "U2")
    insert_player_asset(conn, "T3", "P1", from_rid=1, to_rid=2)
    insert_player_asset(conn, "T3", "P2", from_rid=2, to_rid=1)

    snap_date = date(2024, 9, 1)
    insert_player_snapshot(conn, "P1", "sf_ppr", snap_date, 7000)
    insert_player_snapshot(conn, "P2", "sf_ppr", snap_date, 7000)

    source = RosterAuditValueSource(conn)
    grade_trade(conn, "T3", source, current_date=snap_date)
    grade_trade(conn, "T3", source, current_date=snap_date)

    count = conn.execute(
        "SELECT COUNT(*) FROM trade_grades WHERE trade_id='T3'"
    ).fetchone()[0]
    assert count == 4  # 2 sides × 2 grade types, NOT 8


def test_grade_trade_fallback_flag(conn):
    """
    Trade date is 2022, but only a 2024 snapshot exists.
    used_value_fallback should be True for the decision grade.
    """
    insert_league(conn)
    insert_trade(conn, "T4", executed_at="2022-09-01T12:00:00+00:00")
    insert_trade_side(conn, "T4", 1, "U1")
    insert_trade_side(conn, "T4", 2, "U2")
    insert_player_asset(conn, "T4", "P1", from_rid=1, to_rid=2)
    insert_player_asset(conn, "T4", "P2", from_rid=2, to_rid=1)

    # Only future snapshots exist — will trigger fallback
    snap_date = date(2024, 1, 1)
    insert_player_snapshot(conn, "P1", "sf_ppr", snap_date, 9000)
    insert_player_snapshot(conn, "P2", "sf_ppr", snap_date, 9000)

    source = RosterAuditValueSource(conn)
    grade_trade(conn, "T4", source, current_date=snap_date)

    decision = conn.execute(
        "SELECT used_value_fallback FROM trade_grades "
        "WHERE trade_id='T4' AND side_roster_id=1 AND grade_type='decision'"
    ).fetchone()
    assert decision["used_value_fallback"] == 1  # SQLite stores bool as int

    outcome = conn.execute(
        "SELECT used_value_fallback FROM trade_grades "
        "WHERE trade_id='T4' AND side_roster_id=1 AND grade_type='outcome'"
    ).fetchone()
    assert outcome["used_value_fallback"] == 0  # outcome is always current


def test_grade_trade_neutral_zero_value(conn):
    """
    Both sides are 0 (no matching snapshots for any assets) → B (neutral).
    """
    insert_league(conn)
    insert_trade(conn, "T5")
    insert_trade_side(conn, "T5", 1, "U1")
    insert_trade_side(conn, "T5", 2, "U2")
    insert_player_asset(conn, "T5", "UNKNOWN1", from_rid=1, to_rid=2)
    insert_player_asset(conn, "T5", "UNKNOWN2", from_rid=2, to_rid=1)

    # No snapshots — values will be None, total = 0
    source = RosterAuditValueSource(conn)
    grade_trade(conn, "T5", source, current_date=date(2024, 1, 1))

    grade = conn.execute(
        "SELECT letter_grade FROM trade_grades WHERE trade_id='T5' AND grade_type='decision'"
    ).fetchone()
    assert grade["letter_grade"] == "B"


def test_grade_trade_format_key_used(conn):
    """
    Grade should use the league's format_key (sf_ppr_tep vs sf_ppr).
    Different format values should produce different results.
    """
    insert_league(conn, "LG_TEP", fmt="sf_ppr_tep")
    insert_trade(conn, "T6", league_id="LG_TEP")
    insert_trade_side(conn, "T6", 1, "U1")
    insert_trade_side(conn, "T6", 2, "U2")
    insert_player_asset(conn, "T6", "TE_PLAYER", from_rid=1, to_rid=2)
    insert_player_asset(conn, "T6", "WR_PLAYER", from_rid=2, to_rid=1)

    snap_date = date(2024, 10, 1)
    # TEP values — TE worth more in TEP
    insert_player_snapshot(conn, "TE_PLAYER", "sf_ppr_tep", snap_date, 9000)
    insert_player_snapshot(conn, "WR_PLAYER", "sf_ppr_tep", snap_date, 7000)

    source = RosterAuditValueSource(conn)
    grade_trade(conn, "T6", source, current_date=snap_date)

    r1 = conn.execute(
        "SELECT * FROM trade_grades WHERE trade_id='T6' AND side_roster_id=1 AND grade_type='decision'"
    ).fetchone()
    # Roster 1 gave TE (9000) and received WR (7000) — should be negative
    assert r1["differential"] < 0
