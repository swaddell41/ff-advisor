"""
Auth + onboarding routes.

POST /api/auth/login      {username} → resolve Sleeper user, set session cookie
GET  /api/auth/me         → who am I + my selected leagues
POST /api/auth/logout
POST /api/onboard/leagues {league_ids} → select + start background imports
GET  /api/onboard/status  → import progress for my selected leagues
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.auth import (
    SESSION_COOKIE,
    create_session,
    delete_session,
    get_session_user,
    upsert_app_user,
)
from app.db import get_connection
from app.onboarding import (
    get_job_statuses,
    list_user_leagues,
    lookup_sleeper_user,
    run_import_sync,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _conn():
    return get_connection()


class LoginRequest(BaseModel):
    username: str


@router.post("/api/auth/login")
def login(body: LoginRequest, response: Response):
    username = body.username.strip().lstrip("@")
    if not username:
        raise HTTPException(status_code=400, detail="Username required")

    user = lookup_sleeper_user(username)
    if user is None:
        raise HTTPException(status_code=404, detail=f"No Sleeper user named '{username}'")

    uid = str(user["user_id"])
    conn = _conn()
    try:
        upsert_app_user(conn, uid, user.get("username"), user.get("display_name"))
        token = create_session(conn, uid)
        response.set_cookie(
            SESSION_COOKIE, token,
            httponly=True, samesite="lax", max_age=180 * 86400,
            secure=bool(os.environ.get("VERCEL")),
        )

        leagues = list_user_leagues(uid)
        imported = {
            r["id"]
            for r in conn.execute("SELECT id FROM leagues").fetchall()
        }
        selected = {
            r["league_id"]
            for r in conn.execute(
                "SELECT league_id FROM user_leagues WHERE sleeper_user_id = ?", (uid,)
            ).fetchall()
        }
        return {
            "user_id": uid,
            "username": user.get("username"),
            "display_name": user.get("display_name"),
            "leagues": [
                {**l, "imported": l["league_id"] in imported, "selected": l["league_id"] in selected}
                for l in leagues
            ],
        }
    finally:
        conn.close()


@router.get("/api/auth/me")
def me(request: Request):
    conn = _conn()
    try:
        uid = get_session_user(conn, request.cookies.get(SESSION_COOKIE))
        if uid is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        user = conn.execute(
            "SELECT sleeper_user_id, username, display_name FROM app_users WHERE sleeper_user_id = ?",
            (uid,),
        ).fetchone()
        selected = [
            r["league_id"]
            for r in conn.execute(
                "SELECT league_id FROM user_leagues WHERE sleeper_user_id = ?", (uid,)
            ).fetchall()
        ]
        return {
            "user_id": uid,
            "username": user["username"] if user else None,
            "display_name": user["display_name"] if user else None,
            "selected_leagues": selected,
        }
    finally:
        conn.close()


@router.post("/api/auth/logout")
def logout(request: Request, response: Response):
    conn = _conn()
    try:
        delete_session(conn, request.cookies.get(SESSION_COOKIE))
    finally:
        conn.close()
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


class OnboardLeaguesRequest(BaseModel):
    league_ids: list[str]


@router.post("/api/onboard/leagues")
def onboard_leagues(body: OnboardLeaguesRequest, request: Request):
    conn = _conn()
    try:
        uid = get_session_user(conn, request.cookies.get(SESSION_COOKIE))
        if uid is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        if not body.league_ids:
            raise HTTPException(status_code=400, detail="Pick at least one league")

        for lid in body.league_ids:
            conn.execute(
                "INSERT OR IGNORE INTO user_leagues (sleeper_user_id, league_id) VALUES (?, ?)",
                (uid, lid),
            )
        conn.commit()
        return {"selected": body.league_ids}
    finally:
        conn.close()


@router.post("/api/onboard/import/{league_id}")
def onboard_import(league_id: str, request: Request):
    """
    Import one league family synchronously (~30-60s). The frontend calls
    this once per selected league, in sequence, showing progress per league.
    """
    conn = _conn()
    try:
        uid = get_session_user(conn, request.cookies.get(SESSION_COOKIE))
        if uid is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        selected = conn.execute(
            "SELECT 1 FROM user_leagues WHERE sleeper_user_id = ? AND league_id = ?",
            (uid, league_id),
        ).fetchone()
        if not selected:
            raise HTTPException(status_code=403, detail="League not in your selections")
    finally:
        conn.close()

    result = run_import_sync(league_id)
    if result["status"] == "error":
        raise HTTPException(status_code=500, detail=result["detail"])
    return result


@router.get("/api/onboard/status")
def onboard_status(request: Request):
    conn = _conn()
    try:
        uid = get_session_user(conn, request.cookies.get(SESSION_COOKIE))
        if uid is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        selected = [
            r["league_id"]
            for r in conn.execute(
                "SELECT league_id FROM user_leagues WHERE sleeper_user_id = ?", (uid,)
            ).fetchall()
        ]
        return {"leagues": get_job_statuses(selected, conn)}
    finally:
        conn.close()
