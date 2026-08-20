"""
Claim-based auth for a small trusted circle.

Sleeper has no OAuth and every piece of league data is public, so identity
here is a claim: you type your Sleeper username, we resolve it via the
Sleeper API, and a session cookie remembers who you are. No passwords.
This is deliberate — the stakes are posture overrides and saved views, not
private data. If the app ever goes beyond trusted users, replace with real
auth (magic links) before anything sensitive is stored.

The request's user is carried in a contextvar set by middleware so the
existing endpoint code (`_require_user_id`) keeps working unchanged. When
no session cookie is present we fall back to SLEEPER_USER_ID from .env —
this keeps the original single-user local workflow alive for development.
"""

from __future__ import annotations

import logging
import secrets
from contextvars import ContextVar
from datetime import datetime, timezone
from sqlite3 import Connection

logger = logging.getLogger(__name__)

SESSION_COOKIE = "ff_session"
current_session_user: ContextVar[str | None] = ContextVar("current_session_user", default=None)


def create_session(conn: Connection, sleeper_user_id: str) -> str:
    token = secrets.token_hex(32)
    conn.execute(
        "INSERT INTO sessions (token, sleeper_user_id, created_at) VALUES (?, ?, ?)",
        (token, sleeper_user_id, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    return token


def get_session_user(conn: Connection, token: str | None) -> str | None:
    if not token:
        return None
    row = conn.execute(
        "SELECT sleeper_user_id FROM sessions WHERE token = ?", (token,)
    ).fetchone()
    return row["sleeper_user_id"] if row else None


def delete_session(conn: Connection, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()


def upsert_app_user(
    conn: Connection, sleeper_user_id: str, username: str | None, display_name: str | None
) -> None:
    conn.execute(
        "INSERT INTO app_users (sleeper_user_id, username, display_name, created_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(sleeper_user_id) DO UPDATE SET username=excluded.username, "
        "display_name=excluded.display_name",
        (sleeper_user_id, username, display_name, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
