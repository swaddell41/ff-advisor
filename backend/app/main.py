"""
FastAPI application entry point.

Phase 1: health check only.
Phase 2 will add /api/leagues, /api/trades, and grading routes.
Phase 3 will add /api/managers and scouting report routes.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Load .env from the project root (two levels up from app/)
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from app.api.auth import router as auth_router
from app.api.leagues import router as leagues_router
from app.api.managers import router as managers_router
from app.api.me import router as me_router
from app.api.espn import router as espn_router
from app.auth import SESSION_COOKIE, current_session_user, get_session_user  # noqa: E402
from app.db import get_connection, init_schema  # noqa: E402

app = FastAPI(
    title="Dynasty FF Advisor",
    description="Personal dynasty fantasy football trade analysis tool.",
    version="0.1.0",
)

# Allow the Vite dev server (localhost:5173) to call the API during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    # The Chrome extension's side panel (chrome-extension:// origin) and
    # local extension testing. Extension fetches with host_permissions
    # bypass CORS anyway; this keeps standalone/panel testing honest.
    # Draft-site origins: the in-row annotator fetches the (public) draft
    # board from content scripts, which inherit the page's origin.
    allow_origin_regex=r"chrome-extension://.*|http://localhost:\d+|https://(www\.)?sleeper\.com|https://([a-z0-9-]+\.)?espn\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(auth_router)
app.include_router(leagues_router)
app.include_router(managers_router)
app.include_router(me_router)
app.include_router(espn_router)


@app.middleware("http")
async def session_middleware(request, call_next):
    """Resolve the session cookie into a contextvar the endpoints read."""
    uid = None
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        conn = get_connection()
        try:
            uid = get_session_user(conn, token)
        finally:
            conn.close()
    reset = current_session_user.set(uid)
    try:
        return await call_next(request)
    finally:
        current_session_user.reset(reset)


@app.on_event("startup")
def on_startup() -> None:
    """Initialize the database schema; seed the .env user as an app user."""
    conn = get_connection()
    init_schema(conn)
    # Migrate the original single-user setup into the multi-user tables so
    # the env-fallback identity and the daily refresh see the same state.
    env_uid = os.environ.get("SLEEPER_USER_ID")
    if env_uid:
        mrow = conn.execute(
            "SELECT username, display_name FROM managers WHERE user_id = ?", (env_uid,)
        ).fetchone()
        conn.execute(
            "INSERT OR IGNORE INTO app_users (sleeper_user_id, username, display_name) VALUES (?, ?, ?)",
            (env_uid, mrow["username"] if mrow else None, mrow["display_name"] if mrow else None),
        )
        for lid in (os.environ.get("LEAGUE_IDS") or "").split(","):
            if lid.strip():
                conn.execute(
                    "INSERT OR IGNORE INTO user_leagues (sleeper_user_id, league_id) VALUES (?, ?)",
                    (env_uid, lid.strip()),
                )
        conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    """Returns service status and DB path. Useful for verifying the server is up."""
    from app.db import get_db_path
    db_path = get_db_path()
    return {
        "status": "ok",
        "db_path": str(db_path),
        "db_exists": db_path.exists(),
    }


# ---------------------------------------------------------------------------
# Serve the built frontend bundle in production.
# In development, the Vite dev server handles frontend requests directly.
# ---------------------------------------------------------------------------

_FRONTEND_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"

if _FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
