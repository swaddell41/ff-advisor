"""
Tests for the manager profile engine.

Covers:
- compute_differential_stats: correct aggregation of wins/losses/neutrals
- compute_position_biases: correct bucketing of trade differentials by position
- compute_age_biases: correct age-at-trade-time calculation and bucketing
- compute_posture_patterns: correct classification of rebuild/contend/neutral trades
- compute_profile: end-to-end with hand-crafted fixtures; idempotent on re-run
"""

import sqlite3
from datetime import date

import pytest

from app.db import init_schema
from app.grading.engine import grade_trade
from app.profiles.engine import (
    compute_age_biases,
    compute_differential_stats,
    compute_position_biases,
    compute_posture_patterns,
    compute_profile,
)
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
# Helpers
# ---------------------------------------------------------------------------

def insert_league(conn, league_id="LG1", fmt="sf_ppr"):
    conn.execute(
        "INSERT OR REPLACE INTO leagues (id, name, season, format_key) VALUES (?, ?, 2024, ?)",
        (league_id, "Test", fmt),
    )
    conn.commit()


def insert_manager(conn, user_id, name="Manager"):
    conn.execute(
        "INSERT OR IGNORE INTO managers (user_id, username, display_name) VALUES (?, ?, ?)",
        (user_id, name, name),
    )
    conn.execute(
        "INSERT OR IGNORE INTO league_managers (league_id, user_id, roster_id) VALUES ('LG1', ?, ?)",
        (user_id, hash(user_id) % 100),
    )
    conn.commit()


def insert_player(conn, sleeper_id, position, birth_date=None):
    conn.execute(
        "INSERT OR REPLACE INTO players (sleeper_id, full_name, position, birth_date) VALUES (?, ?, ?, ?)",
        (sleeper_id, f"Player {sleeper_id}", position, birth_date),
    )
    conn.commit()


def insert_trade(conn, trade_id, league_id="LG1", executed_at="2024-10-01T12:00:00+00:00"):
    conn.execute(
        "INSERT OR REPLACE INTO trades (id, league_id, season, week, executed_at, raw_json) VALUES (?, ?, 2024, 5, ?, '{}')",
        (trade_id, league_id, executed_at),
    )
    conn.commit()


def insert_side(conn, trade_id, roster_id, user_id):
    conn.execute(
        "INSERT OR REPLACE INTO trade_sides (trade_id, roster_id, user_id) VALUES (?, ?, ?)",
        (trade_id, roster_id, user_id),
    )
    conn.commit()


def insert_player_asset(conn, trade_id, player_id, from_rid, to_rid):
    conn.execute(
        "INSERT INTO trade_assets (trade_id, from_roster_id, to_roster_id, asset_type, player_id) VALUES (?, ?, ?, 'player', ?)",
        (trade_id, from_rid, to_rid, player_id),
    )
    conn.commit()


def insert_pick_asset(conn, trade_id, season, round_num, from_rid, to_rid):
    conn.execute(
        "INSERT INTO trade_assets (trade_id, from_roster_id, to_roster_id, asset_type, pick_season, pick_round, pick_original_owner_roster_id) VALUES (?, ?, ?, 'pick', ?, ?, ?)",
        (trade_id, from_rid, to_rid, season, round_num, from_rid),
    )
    conn.commit()


def insert_snapshot(conn, player_id, fmt, value, snap_date=date(2024, 10, 1)):
    conn.execute(
        "INSERT OR REPLACE INTO value_snapshots (player_id, source, format, snapshot_date, value) VALUES (?, ?, ?, ?, ?)",
        (player_id, SOURCE, fmt, snap_date.isoformat(), value),
    )
    conn.commit()


def insert_pick_snapshot(conn, season, round_num, fmt, mid, snap_date=date(2024, 10, 1)):
    conn.execute(
        "INSERT OR REPLACE INTO pick_value_snapshots (season, round, source, format, snapshot_date, early_value, mid_value, late_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (season, round_num, SOURCE, fmt, snap_date.isoformat(), mid + 500, mid, mid - 300),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# compute_differential_stats
# ---------------------------------------------------------------------------

def make_trade_record(d_diff, d_received, d_given, trade_id="T1", d_grade="B"):
    return {
        "trade_id": trade_id,
        "season": 2024, "week": 5,
        "executed_at": "2024-10-01T00:00:00+00:00",
        "roster_id": 1,
        "d_received": d_received, "d_given": d_given,
        "d_diff": d_diff, "d_grade": d_grade,
        "o_received": d_received, "o_given": d_given,
        "o_diff": d_diff, "o_grade": d_grade,
        "assets_received": [], "assets_given": [],
    }


def test_differential_stats_empty():
    stats = compute_differential_stats([])
    assert stats["total_trades"] == 0
    assert stats["win_rate"] is None


def test_differential_stats_win_loss_neutral():
    trades = [
        make_trade_record(2000, 14000, 10000, "T1", "A+"),   # pct = 2000/14000 = 14.3% → win
        make_trade_record(-3000, 7000, 10000, "T2", "F"),     # pct = -3000/10000 = -30% → loss
        make_trade_record(100, 10100, 10000, "T3", "B"),      # pct = 100/10100 = 1% → neutral
    ]
    stats = compute_differential_stats(trades)
    assert stats["total_trades"] == 3
    assert stats["wins"] == 1
    assert stats["losses"] == 1
    assert stats["neutrals"] == 1
    assert stats["best_decision_trade"]["trade_id"] == "T1"
    assert stats["worst_decision_trade"]["trade_id"] == "T2"


def test_differential_stats_ungraded_excluded():
    trades = [
        make_trade_record(5000, 15000, 10000, "T1", "A+"),
        {**make_trade_record(0, 0, 0, "T2"), "d_grade": None},  # ungraded
    ]
    stats = compute_differential_stats(trades)
    assert stats["total_trades"] == 2
    assert stats["graded_trades"] == 1
    assert stats["wins"] == 1


# ---------------------------------------------------------------------------
# compute_position_biases
# ---------------------------------------------------------------------------

def make_trade_with_assets(d_diff, d_received, d_given, received_positions, given_positions, trade_id="T1"):
    received = [{"asset_type": "player", "position": p, "birth_date": None} for p in received_positions]
    given = [{"asset_type": "player", "position": p, "birth_date": None} for p in given_positions]
    t = make_trade_record(d_diff, d_received, d_given, trade_id)
    t["assets_received"] = received
    t["assets_given"] = given
    return t


def test_position_bias_acquiring_rb():
    """
    Two trades where manager acquires RBs — both at a loss.
    Should show negative avg_differential for acquiring RBs.
    """
    trades = [
        make_trade_with_assets(-2000, 8000, 10000, ["RB"], ["WR"], "T1"),  # pct=-20%
        make_trade_with_assets(-1500, 8500, 10000, ["RB"], ["QB"], "T2"),  # pct=-15%
    ]
    biases = compute_position_biases(trades)
    rb = biases["RB"]["acquiring"]
    assert rb["count"] == 2
    assert rb["avg_differential"] < 0  # consistently overpays for RBs
    assert biases["WR"]["shedding"]["count"] == 1


def test_position_bias_trade_counted_once_per_position():
    """
    A trade with 2 RBs received should only count once toward 'acquiring RBs'.
    """
    trades = [
        make_trade_with_assets(1000, 11000, 10000, ["RB", "RB"], ["WR"], "T1"),
    ]
    biases = compute_position_biases(trades)
    assert biases["RB"]["acquiring"]["count"] == 1


def test_position_bias_no_trades():
    biases = compute_position_biases([])
    assert biases["RB"]["acquiring"]["count"] == 0


# ---------------------------------------------------------------------------
# compute_age_biases
# ---------------------------------------------------------------------------

def make_trade_with_player_ages(d_diff, d_received, d_given, received_births, given_births, trade_id="T1"):
    received = [{"asset_type": "player", "birth_date": bd, "position": "WR"} for bd in received_births]
    given = [{"asset_type": "player", "birth_date": bd, "position": "RB"} for bd in given_births]
    t = make_trade_record(d_diff, d_received, d_given, trade_id)
    t["assets_received"] = received
    t["assets_given"] = given
    return t


def test_age_bias_veteran_acquisition():
    """
    Manager consistently acquires veterans (born 1993 → age ~31 in 2024) at a loss.
    """
    trades = [
        make_trade_with_player_ages(-2000, 8000, 10000, ["1993-01-01"], [], "T1"),
        make_trade_with_player_ages(-1500, 8500, 10000, ["1994-06-01"], [], "T2"),
    ]
    biases = compute_age_biases(trades)
    vet = biases["veteran"]["acquiring"]
    assert vet["count"] == 2
    assert vet["avg_differential"] is not None
    assert vet["avg_differential"] < 0


def test_age_bias_young_player_bucketed_correctly():
    """
    Player born 2002-01-01, trade in 2024 → age ~22 → 'young' bucket.
    """
    trades = [
        make_trade_with_player_ages(2000, 14000, 10000, ["2002-01-01"], [], "T1"),
    ]
    biases = compute_age_biases(trades)
    assert biases["young"]["acquiring"]["count"] == 1
    assert biases["prime"]["acquiring"]["count"] == 0
    assert biases["veteran"]["acquiring"]["count"] == 0


def test_age_bias_unknown_birth_date_skipped():
    """Players with no birth date should be excluded from age bias."""
    trades = [
        make_trade_with_player_ages(0, 10000, 10000, [None], [], "T1"),
    ]
    biases = compute_age_biases(trades)
    assert biases["young"]["acquiring"]["count"] == 0
    assert biases["prime"]["acquiring"]["count"] == 0
    assert biases["veteran"]["acquiring"]["count"] == 0


# ---------------------------------------------------------------------------
# compute_posture_patterns
# ---------------------------------------------------------------------------

def make_posture_trade(received_types: list[str], given_types: list[str], d_diff, d_received, d_given, trade_id="T1"):
    received = [{"asset_type": t, "birth_date": "1998-01-01", "position": "WR"} for t in received_types]
    given = [{"asset_type": t, "birth_date": "1993-01-01", "position": "RB"} for t in given_types]
    t = make_trade_record(d_diff, d_received, d_given, trade_id)
    t["assets_received"] = received
    t["assets_given"] = given
    return t


def test_posture_rebuild_classification():
    """Trade where manager receives only picks → rebuild classification."""
    trades = [make_posture_trade(["pick"], ["player"], 1000, 11000, 10000)]
    patterns = compute_posture_patterns(trades)
    assert patterns["rebuild"]["count"] == 1
    assert patterns["contend"]["count"] == 0


def test_posture_contend_classification():
    """Trade where manager receives only players → contend classification."""
    trades = [make_posture_trade(["player"], ["pick"], 1000, 11000, 10000)]
    patterns = compute_posture_patterns(trades)
    assert patterns["contend"]["count"] == 1
    assert patterns["rebuild"]["count"] == 0


def test_posture_neutral_classification():
    """Trade with mixed assets → neutral."""
    trades = [make_posture_trade(["player", "pick"], ["player"], 1000, 11000, 10000)]
    patterns = compute_posture_patterns(trades)
    assert patterns["neutral"]["count"] == 1


# ---------------------------------------------------------------------------
# compute_profile — end-to-end + idempotency
# ---------------------------------------------------------------------------

def test_compute_profile_end_to_end(conn):
    """Full profile computation with real DB fixtures."""
    insert_league(conn)
    insert_manager(conn, "U1", "Alice")
    insert_manager(conn, "U2", "Bob")
    insert_player(conn, "P1", "RB", "1998-05-01")
    insert_player(conn, "P2", "WR", "2001-03-15")
    insert_snapshot(conn, "P1", "sf_ppr", 9000)
    insert_snapshot(conn, "P2", "sf_ppr", 7000)

    insert_trade(conn, "T1")
    insert_side(conn, "T1", 1, "U1")
    insert_side(conn, "T1", 2, "U2")
    insert_player_asset(conn, "T1", "P1", from_rid=1, to_rid=2)
    insert_player_asset(conn, "T1", "P2", from_rid=2, to_rid=1)

    source = RosterAuditValueSource(conn)
    grade_trade(conn, "T1", source, current_date=date(2024, 10, 1))

    profile = compute_profile(conn, "U1", "LG1")
    assert profile is not None
    assert profile["user_id"] == "U1"
    assert profile["manager_name"] == "Alice"
    assert profile["differential_stats"]["total_trades"] == 1
    # U1 gave P1 (9000) and received P2 (7000) → negative differential
    assert profile["differential_stats"]["losses"] == 1


def test_compute_profile_idempotent(conn):
    """Calling compute_profile twice returns consistent results."""
    insert_league(conn)
    insert_manager(conn, "U1")
    insert_manager(conn, "U2")
    insert_player(conn, "P1", "QB")
    insert_player(conn, "P2", "TE")
    insert_snapshot(conn, "P1", "sf_ppr", 8000)
    insert_snapshot(conn, "sf_ppr", "sf_ppr", 0)  # harmless noise
    insert_snapshot(conn, "P2", "sf_ppr", 6000)

    insert_trade(conn, "T1")
    insert_side(conn, "T1", 1, "U1")
    insert_side(conn, "T1", 2, "U2")
    insert_player_asset(conn, "T1", "P1", 1, 2)
    insert_player_asset(conn, "T1", "P2", 2, 1)

    source = RosterAuditValueSource(conn)
    grade_trade(conn, "T1", source, current_date=date(2024, 10, 1))

    p1 = compute_profile(conn, "U1", "LG1")
    p2 = compute_profile(conn, "U1", "LG1")
    assert p1["differential_stats"]["total_trades"] == p2["differential_stats"]["total_trades"]
    assert p1["differential_stats"]["wins"] == p2["differential_stats"]["wins"]


def test_compute_profile_returns_none_for_no_trades(conn):
    insert_league(conn)
    insert_manager(conn, "U_NOTRADES")
    profile = compute_profile(conn, "U_NOTRADES", "LG1")
    assert profile is None
