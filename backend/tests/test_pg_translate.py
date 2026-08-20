"""Tests for the sqlite→Postgres statement translator in app.db."""

from datetime import date, datetime

from app.db import _adapt_param, _pg_translate, _pg_translate_ddl, _split_statements


def test_or_replace_becomes_on_conflict_update():
    sql = (
        "INSERT OR REPLACE INTO value_snapshots "
        "(player_id, source, format, snapshot_date, value) VALUES (?, ?, ?, ?, ?)"
    )
    out = _pg_translate(sql, has_params=True)
    assert out.startswith(
        "INSERT INTO value_snapshots (player_id, source, format, snapshot_date, value)"
    )
    assert "ON CONFLICT (player_id, source, format, snapshot_date) DO UPDATE SET value = EXCLUDED.value" in out
    assert "?" not in out
    assert out.count("%s") == 5


def test_or_replace_all_pk_columns_becomes_do_nothing():
    sql = "INSERT OR REPLACE INTO user_leagues (sleeper_user_id, league_id) VALUES (?, ?)"
    out = _pg_translate(sql, has_params=True)
    assert "ON CONFLICT (sleeper_user_id, league_id) DO NOTHING" in out


def test_or_ignore_becomes_do_nothing():
    sql = "INSERT OR IGNORE INTO user_leagues (sleeper_user_id, league_id) VALUES (?, ?)"
    out = _pg_translate(sql, has_params=True)
    assert out.startswith("INSERT INTO user_leagues")
    assert out.rstrip().endswith("ON CONFLICT DO NOTHING")


def test_pragma_is_skipped():
    assert _pg_translate("PRAGMA journal_mode=WAL", has_params=False) is None


def test_percent_escaped_only_with_params():
    with_params = _pg_translate(
        "SELECT * FROM sleeper_cache WHERE url LIKE '%/rosters' AND url = ?", has_params=True
    )
    assert "'%%/rosters'" in with_params and "%s" in with_params

    without = _pg_translate(
        "SELECT MAX(fetched_at) FROM sleeper_cache WHERE url LIKE '%/rosters'", has_params=False
    )
    assert "'%/rosters'" in without


def test_plain_select_placeholders():
    out = _pg_translate("SELECT * FROM trades WHERE league_id IN (?,?,?)", has_params=True)
    assert out == "SELECT * FROM trades WHERE league_id IN (%s,%s,%s)"


def test_on_conflict_passthrough():
    # Hand-written upserts (valid in both dialects) must survive untouched.
    sql = (
        "INSERT INTO app_users (sleeper_user_id, username) VALUES (?, ?) "
        "ON CONFLICT(sleeper_user_id) DO UPDATE SET username=excluded.username"
    )
    out = _pg_translate(sql, has_params=True)
    assert "ON CONFLICT(sleeper_user_id) DO UPDATE" in out
    assert out.count("%s") == 2


def test_ddl_translation():
    ddl = (
        "CREATE TABLE IF NOT EXISTS trade_assets ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, pick_season INT, "
        "executed_at TIMESTAMP, snapshot_date DATE NOT NULL);"
    )
    out = _pg_translate_ddl(ddl)
    assert "BIGSERIAL PRIMARY KEY" in out
    assert "TIMESTAMP" not in out
    assert " DATE " not in out
    stmts = _split_statements(out)
    assert len(stmts) == 1


def test_param_adaptation():
    assert _adapt_param(date(2026, 8, 19)) == "2026-08-19"
    assert _adapt_param(datetime(2026, 8, 19, 12, 0)) == "2026-08-19T12:00:00"
    assert _adapt_param(5) == 5
    assert _adapt_param("x") == "x"
