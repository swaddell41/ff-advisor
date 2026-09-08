"""
Database connection and schema management — dual backend.

- SQLite (default): local dev, tests, the original single-user setup.
- Postgres (when DATABASE_URL is set): production on Vercel + Neon.

The Postgres path is a thin facade that keeps the sqlite3 calling
convention every module already uses — conn.execute("... ?", params),
row["col"] and row[0], executescript, commit/close — and translates
dialect differences at execute time:

  ?                    → %s          (with % escaped when params exist)
  INSERT OR REPLACE    → INSERT ... ON CONFLICT (pk) DO UPDATE (via PK map)
  INSERT OR IGNORE     → INSERT ... ON CONFLICT DO NOTHING
  PRAGMA ...           → no-op
  AUTOINCREMENT / DATE / TIMESTAMP  → BIGSERIAL / TEXT / TEXT (DDL only)

Dates and datetimes in params are stringified to ISO so Postgres TEXT
columns behave byte-identically to SQLite's storage. No other module
should ever know which backend is live.
"""

import os
import re
import sqlite3
from datetime import date, datetime
from pathlib import Path

# Default DB path relative to the project root; overridable via DB_PATH env var.
_DEFAULT_DB_PATH = Path(__file__).parent.parent.parent / "data" / "dynasty.db"

# Primary keys per table — used to translate INSERT OR REPLACE into
# Postgres ON CONFLICT upserts. Keep in sync with the schema below.
TABLE_PKS: dict[str, list[str]] = {
    "sleeper_cache": ["url"],
    "leagues": ["id"],
    "managers": ["user_id"],
    "league_managers": ["league_id", "user_id"],
    "players": ["sleeper_id"],
    "trades": ["id"],
    "trade_sides": ["trade_id", "roster_id"],
    "trade_assets": ["id"],
    "value_snapshots": ["player_id", "source", "format", "snapshot_date"],
    "pick_value_snapshots": ["season", "round", "source", "format", "snapshot_date"],
    "roster_players": ["league_id", "user_id", "player_id"],
    "user_posture_overrides": ["user_id", "league_id"],
    "scouting_reports": ["user_id", "league_id"],
    "trade_grades": ["trade_id", "side_roster_id", "grade_type"],
    "app_users": ["sleeper_user_id"],
    "sessions": ["token"],
    "user_leagues": ["sleeper_user_id", "league_id"],
    "saved_leagues": ["sleeper_user_id", "platform", "league_id"],
    "adp_snapshots": ["player_id", "source", "format", "snapshot_date"],
    "player_ids": ["sleeper_id"],
}


def get_db_path() -> Path:
    raw = os.environ.get("DB_PATH", str(_DEFAULT_DB_PATH))
    return Path(raw)


def using_postgres() -> bool:
    return bool(os.environ.get("DATABASE_URL"))


# ---------------------------------------------------------------------------
# Postgres facade
# ---------------------------------------------------------------------------

_OR_REPLACE_RE = re.compile(
    r"INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]*)\)", re.IGNORECASE
)
_OR_IGNORE_RE = re.compile(r"INSERT\s+OR\s+IGNORE\s+INTO", re.IGNORECASE)


def _pg_translate(sql: str, has_params: bool) -> str | None:
    """Translate one sqlite-dialect statement to Postgres. None = skip."""
    stripped = sql.lstrip()
    if stripped.upper().startswith("PRAGMA"):
        return None

    m = _OR_REPLACE_RE.search(sql)
    if m:
        table = m.group(1)
        cols = [c.strip() for c in m.group(2).split(",")]
        pks = TABLE_PKS.get(table)
        if pks is None:
            raise ValueError(f"INSERT OR REPLACE into unknown table {table}")
        non_pk = [c for c in cols if c not in pks]
        sql = _OR_REPLACE_RE.sub(f"INSERT INTO {table} ({', '.join(cols)})", sql, count=1)
        if non_pk:
            conflict = (
                f" ON CONFLICT ({', '.join(pks)}) DO UPDATE SET "
                + ", ".join(f"{c} = EXCLUDED.{c}" for c in non_pk)
            )
        else:
            conflict = f" ON CONFLICT ({', '.join(pks)}) DO NOTHING"
        sql = sql.rstrip().rstrip(";") + conflict

    if _OR_IGNORE_RE.search(sql):
        sql = _OR_IGNORE_RE.sub("INSERT INTO", sql)
        sql = sql.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"

    if has_params:
        sql = sql.replace("%", "%%").replace("?", "%s")
    return sql


class PgConnection:
    """sqlite3.Connection-shaped facade over psycopg2."""

    def __init__(self, dsn: str) -> None:
        import psycopg2
        import psycopg2.extras

        self._conn = psycopg2.connect(dsn, cursor_factory=psycopg2.extras.DictCursor)
        self.row_factory = None  # compat no-op; assignments are ignored

    def execute(self, sql: str, params: tuple | list = ()):
        translated = _pg_translate(sql, has_params=bool(params))
        if translated is None:  # PRAGMA etc.
            return _NullCursor()
        cur = self._conn.cursor()
        # psycopg2 interprets % formatting whenever vars is not None — even
        # an empty list — so only pass params when there are some.
        cur.execute(translated, [_adapt_param(p) for p in params] if params else None)
        return cur

    def executescript(self, script: str):
        cur = self._conn.cursor()
        for stmt in _split_statements(_pg_translate_ddl(script)):
            cur.execute(stmt)
        self._conn.commit()

    def commit(self) -> None:
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


class _NullCursor:
    def fetchone(self):
        return None

    def fetchall(self):
        return []


def _adapt_param(p):
    if isinstance(p, (date, datetime)):
        return p.isoformat()
    return p


def _split_statements(script: str) -> list[str]:
    # Strip -- comments first: they can legally contain semicolons, which
    # would break the naive split. Our DDL has no string literals with '--'.
    uncommented = "\n".join(line.split("--", 1)[0] for line in script.splitlines())
    return [s.strip() for s in uncommented.split(";") if s.strip()]


def _pg_translate_ddl(script: str) -> str:
    script = script.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
    # Store dates/timestamps as TEXT so behavior matches SQLite exactly —
    # the app parses ISO strings in Python everywhere.
    script = re.sub(r"\bTIMESTAMP\b", "TEXT", script)
    script = re.sub(r"\bDATE\b", "TEXT", script)
    return script


def get_connection(db_path: Path | None = None):
    """
    SQLite connection (row_factory=Row, WAL) by default; a PgConnection
    facade when DATABASE_URL is set. Callers can't tell the difference.
    """
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        return PgConnection(dsn)

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

        -- Saved leagues for the redraft hub (draft companion / evaluation /
        -- start-sit): any-platform bookmarks per signed-in user, with the
        -- user's own team so tools can jump straight to it. Distinct from
        -- user_leagues, which tracks dynasty IMPORTS.
        CREATE TABLE IF NOT EXISTS saved_leagues (
            sleeper_user_id TEXT NOT NULL,
            platform        TEXT NOT NULL,
            league_id       TEXT NOT NULL,
            season          INT,
            name            TEXT,
            team_id         TEXT,
            added_at        TIMESTAMP,
            PRIMARY KEY (sleeper_user_id, platform, league_id)
        );

        -- Cross-platform player id mapping (from the DynastyProcess
        -- crosswalk). Lets the ESPN draft assistant match ESPN pick events
        -- to our sleeper-keyed board.
        CREATE TABLE IF NOT EXISTS player_ids (
            sleeper_id TEXT PRIMARY KEY,
            espn_id    TEXT
        );

        -- Average draft position (redraft), from FantasyCalc. Powers the
        -- draft assistant's "value falling to you" indicator.
        CREATE TABLE IF NOT EXISTS adp_snapshots (
            player_id     TEXT NOT NULL,
            source        TEXT NOT NULL,
            format        TEXT NOT NULL,
            snapshot_date TEXT NOT NULL,
            adp           REAL NOT NULL,
            PRIMARY KEY (player_id, source, format, snapshot_date)
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
