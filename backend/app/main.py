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

from app.api.leagues import router as leagues_router
from app.api.managers import router as managers_router
from app.api.me import router as me_router
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
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(leagues_router)
app.include_router(managers_router)
app.include_router(me_router)


@app.on_event("startup")
def on_startup() -> None:
    """Initialize the database schema on startup."""
    conn = get_connection()
    init_schema(conn)
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
