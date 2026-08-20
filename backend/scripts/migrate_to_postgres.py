"""
One-time migration: copy the local SQLite database into Postgres (Neon).

Usage:
    cd backend
    DATABASE_URL=postgres://... python scripts/migrate_to_postgres.py

Reads every table from the local SQLite file and writes it through the
PgConnection facade (which handles dialect translation). Idempotent —
re-running upserts. Fixes the trade_assets sequence afterwards so future
AUTOINCREMENT-style inserts don't collide with migrated ids.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from app.db import TABLE_PKS, PgConnection, get_db_path, init_schema  # noqa: E402


def main() -> None:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("Set DATABASE_URL to the Neon connection string")

    src = sqlite3.connect(str(get_db_path()))
    src.row_factory = sqlite3.Row

    dst = PgConnection(dsn)
    print("Creating schema…")
    init_schema(dst)

    from psycopg2.extras import execute_values

    for table in TABLE_PKS:
        rows = src.execute(f"SELECT * FROM {table}").fetchall()
        if not rows:
            print(f"{table}: empty")
            continue
        cols = list(rows[0].keys())
        pks = TABLE_PKS[table]
        non_pk = [c for c in cols if c not in pks]
        conflict = (
            f"ON CONFLICT ({', '.join(pks)}) DO UPDATE SET "
            + ", ".join(f"{c} = EXCLUDED.{c}" for c in non_pk)
            if non_pk
            else f"ON CONFLICT ({', '.join(pks)}) DO NOTHING"
        )
        sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES %s {conflict}"
        cur = dst._conn.cursor()
        execute_values(cur, sql, [tuple(r) for r in rows], page_size=500)
        dst.commit()
        print(f"{table}: {len(rows)} rows")

    # trade_assets ids were copied explicitly — advance the sequence past them.
    dst.execute(
        "SELECT setval(pg_get_serial_sequence('trade_assets','id'), "
        "COALESCE((SELECT MAX(id) FROM trade_assets), 1))"
    )
    dst.commit()
    dst.close()
    src.close()
    print("Migration complete.")


if __name__ == "__main__":
    main()
