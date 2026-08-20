"""
SQLite connection and schema management.

Design principles:
- Single module owns all DB access: connection, schema creation, and a thin
  execute/fetchall wrapper.
- Schema is created idempotently (CREATE TABLE IF NOT EXISTS) — safe to call
  on every startup.
- No ORM. Callers pass SQL strings and parameters directly.
"""

import os
import sqlite3
from pathlib import Path

# Default DB path relative to the project root; overridable via DB_PATH env var.
_DEFAULT_DB_PATH = Path(__file__).parent.parent.parent / "data" / "dynasty.db"


def get_db_path() -> Path:
    raw = os.environ.get("DB_PATH", str(_DEFAULT_DB_PATH))
    return Path(raw)


def get_connection(db_path: Path | None = None) -> sqlite3.Connection:
    """
    Open and return a sqlite3 connection with row_factory set to Row so
    callers get dict-like rows. WAL mode for better concurrent read performance.
    """
    path = db_path or get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # No detect_types — timestamps are stored as ISO 8601 strings with timezone
    # info (e.g. "2026-05-10T23:32:07+00:00"), which sqlite3's built-in
    # converter can't handle. Parse them manually where needed.
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    """
    Create all tables. Idempotent — safe to call on every startup.
    Tables are created in dependency order so foreign key checks pass even
    if they're enabled during migration.
    """
    conn.executescript("""
        -- ----------------------------------------------------------------
        -- HTTP cache: every Sleeper API response is stored here.
        -- Past-week transaction responses are cached forever (they never
        -- change). Roster / current-week responses have a 1-hour TTL
        -- enforced in the Sleeper client layer, not here.
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS sleeper_cache (
            url           TEXT PRIMARY KEY,
            response_json TEXT NOT NULL,
            fetched_at    TIMESTAMP NOT NULL
        );

        -- ----------------------------------------------------------------
        -- Core entities
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS leagues (
            id                  TEXT PRIMARY KEY,
            name                TEXT,
            season              INT,
            previous_league_id  TEXT,
            -- RosterAudit format key derived from league settings.
            -- One of: sf_ppr | sf_ppr_tep | 1qb_ppr | 1qb_ppr_tep
            -- NOTE: RosterAudit has no half-PPR preset; SF half-PPR leagues
            --       are mapped to sf_ppr as the closest approximation.
            format_key          TEXT,
            settings_json       TEXT
        );

        CREATE TABLE IF NOT EXISTS managers (
            user_id      TEXT PRIMARY KEY,
            username     TEXT,
            display_name TEXT
        );

        CREATE TABLE IF NOT EXISTS league_managers (
            league_id  TEXT NOT NULL,
            user_id    TEXT NOT NULL,
            roster_id  INT  NOT NULL,
            PRIMARY KEY (league_id, user_id)
        );

        -- Full player roster from /v1/players/nfl.
        -- Refreshed at most once per week; cached forever otherwise.
        CREATE TABLE IF NOT EXISTS players (
            sleeper_id  TEXT PRIMARY KEY,
            full_name   TEXT,
            position    TEXT,
            team        TEXT,
            birth_date  DATE,
            status      TEXT,
            raw_json    TEXT
        );

        -- ----------------------------------------------------------------
        -- Trades
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS trades (
            id           TEXT PRIMARY KEY,   -- Sleeper transaction_id
            league_id    TEXT NOT NULL,
            season       INT  NOT NULL,
            week         INT  NOT NULL,
            executed_at  TIMESTAMP,
            raw_json     TEXT
        );

        -- One row per roster that participated in a trade (usually 2).
        CREATE TABLE IF NOT EXISTS trade_sides (
            trade_id   TEXT NOT NULL,
            roster_id  INT  NOT NULL,
            -- user_id resolved from league_managers at ingest time.
            -- NULL if the roster_id can't be matched (shouldn't happen).
            user_id    TEXT,
            PRIMARY KEY (trade_id, roster_id)
        );

        -- One row per asset exchanged in a trade.
        -- asset_type: 'player' | 'pick' | 'faab'
        -- Exactly one of (player_id), (pick_*), or (faab_amount) will be
        -- populated depending on asset_type.
        CREATE TABLE IF NOT EXISTS trade_assets (
            id                            INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id                      TEXT NOT NULL,
            from_roster_id                INT  NOT NULL,
            to_roster_id                  INT  NOT NULL,
            asset_type                    TEXT NOT NULL,
            -- player asset
            player_id                     TEXT,
            -- pick asset
            pick_season                   INT,
            pick_round                    INT,
            -- The roster_id of the team whose draft slot this pick belongs to.
            -- Used to look up the actual draft slot once the draft is complete.
            pick_original_owner_roster_id INT,
            -- faab asset
            faab_amount                   INT
        );

        -- ----------------------------------------------------------------
        -- Value snapshots
        -- ----------------------------------------------------------------

        -- One row per player per (source, format, date).
        -- source: 'rosteraudit'
        -- format: 'sf_ppr' | 'sf_ppr_tep' | '1qb_ppr' | '1qb_ppr_tep'
        CREATE TABLE IF NOT EXISTS value_snapshots (
            player_id     TEXT NOT NULL,
            source        TEXT NOT NULL,
            format        TEXT NOT NULL,
            snapshot_date DATE NOT NULL,
            value         INT  NOT NULL,
            PRIMARY KEY (player_id, source, format, snapshot_date)
        );

        -- Pick values from RosterAudit /picks endpoint.
        -- early/mid/late_value stored so grading can use mid (canonical)
        -- while the full spread is available for future analysis.
        CREATE TABLE IF NOT EXISTS pick_value_snapshots (
            season        INT  NOT NULL,
            round         INT  NOT NULL,
            source        TEXT NOT NULL,
            format        TEXT NOT NULL,
            snapshot_date DATE NOT NULL,
            early_value   INT,
            mid_value     INT  NOT NULL,  -- canonical value used for grading
            late_value    INT,
            PRIMARY KEY (season, round, source, format, snapshot_date)
        );

        -- ----------------------------------------------------------------
        -- Current roster composition per manager.
        -- Populated from the Sleeper /rosters endpoint during ingestion.
        -- is_starter: 1 if the player was in the starting lineup slot on
        -- the last-ingested roster snapshot (informational; not used for
        -- positional need calculations, which use full roster value).
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS roster_players (
            league_id  TEXT NOT NULL,
            user_id    TEXT NOT NULL,
            player_id  TEXT NOT NULL,
            is_starter INT  NOT NULL DEFAULT 0,
            PRIMARY KEY (league_id, user_id, player_id)
        );

        -- ----------------------------------------------------------------
        -- Phase 4: user posture overrides
        -- Lets the user tag their posture per league manually, overriding
        -- the auto-detected value from trade patterns.
        -- posture: 'rebuild' | 'contend' | 'middling'
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS user_posture_overrides (
            user_id   TEXT NOT NULL,
            league_id TEXT NOT NULL,
            posture   TEXT NOT NULL,
            PRIMARY KEY (user_id, league_id)
        );

        -- ----------------------------------------------------------------
        -- Phase 3: scouting report cache
        -- Keyed by (user_id, league_id, profile_hash) so the cached report
        -- is invalidated whenever the profile data changes (new trades added).
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS scouting_reports (
            user_id      TEXT NOT NULL,
            league_id    TEXT NOT NULL,
            profile_hash TEXT NOT NULL,
            report_text  TEXT NOT NULL,
            generated_at TIMESTAMP NOT NULL,
            PRIMARY KEY (user_id, league_id)
        );

        -- ----------------------------------------------------------------
        -- Grading (populated in Phase 2; defined here so the schema is
        -- complete from the start)
        -- ----------------------------------------------------------------

        -- ----------------------------------------------------------------
        -- Multi-user: app accounts (claim-based — Sleeper username, no
        -- password; fine for a small trusted circle), sessions, and which
        -- leagues each user chose to import.
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS app_users (
            sleeper_user_id TEXT PRIMARY KEY,
            username        TEXT,
            display_name    TEXT,
            created_at      TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token           TEXT PRIMARY KEY,
            sleeper_user_id TEXT NOT NULL,
            created_at      TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_leagues (
            sleeper_user_id TEXT NOT NULL,
            league_id       TEXT NOT NULL,
            PRIMARY KEY (sleeper_user_id, league_id)
        );

        -- grade_type: 'decision' | 'outcome'
        -- decision = values at time of trade
        -- outcome  = current values
        CREATE TABLE IF NOT EXISTS trade_grades (
            trade_id              TEXT NOT NULL,
            side_roster_id        INT  NOT NULL,
            grade_type            TEXT NOT NULL,
            total_value_received  INT,
            total_value_given     INT,
            differential          INT,
            letter_grade          TEXT,
            -- Flag set when decision grade falls back to current/oldest values
            -- because no historical snapshot exists for the trade date.
            used_value_fallback   INT  NOT NULL DEFAULT 0,  -- boolean
            PRIMARY KEY (trade_id, side_roster_id, grade_type)
        );
    """)
    conn.commit()
