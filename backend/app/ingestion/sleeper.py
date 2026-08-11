"""
Sleeper API client with SQLite-backed HTTP cache.

Cache strategy:
- Every response is stored in sleeper_cache(url, response_json, fetched_at).
- Past-week transaction responses: cached forever (Sleeper never modifies them).
- Roster and current-week data: 1-hour TTL (CACHE_TTL_SECONDS).
- The /v1/players/nfl endpoint: 7-day TTL (it's huge; refresh weekly at most).

Rate limiting: Sleeper allows 1000 req/min. We sleep 0.05s between calls,
giving a maximum of ~20 req/s — well within limits.

All public endpoints, no auth required.
"""

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from sqlite3 import Connection
from typing import Any

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://api.sleeper.app"
CACHE_TTL_SECONDS = 3600          # 1 hour — for rosters, current-week data
PLAYERS_TTL_SECONDS = 7 * 86400   # 7 days — /v1/players/nfl is huge
REQUEST_DELAY_SECONDS = 0.05       # polite rate limiting


class SleeperClient:
    """
    Thin wrapper around the Sleeper public API with SQLite response caching.

    Pass a live sqlite3 Connection so the client shares the same transaction
    context as the ingestion pipeline. The connection is NOT closed by this
    class — the caller owns it.
    """

    def __init__(self, conn: Connection) -> None:
        self._conn = conn
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": "ff-advisor/1.0 (personal tool)"})

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    def get_league(self, league_id: str) -> dict:
        """GET /v1/league/{league_id}"""
        return self._get(f"/v1/league/{league_id}", ttl=CACHE_TTL_SECONDS)

    def get_league_users(self, league_id: str) -> list[dict]:
        """GET /v1/league/{league_id}/users"""
        return self._get(f"/v1/league/{league_id}/users", ttl=CACHE_TTL_SECONDS)

    def get_league_rosters(self, league_id: str) -> list[dict]:
        """GET /v1/league/{league_id}/rosters"""
        return self._get(f"/v1/league/{league_id}/rosters", ttl=CACHE_TTL_SECONDS)

    def get_transactions(self, league_id: str, week: int) -> list[dict]:
        """
        GET /v1/league/{league_id}/transactions/{week}

        Past weeks are cached forever — Sleeper never changes them.
        Week 0 (pre-season / free agency) uses the short TTL.
        """
        # We treat any week <= the previous week as immutable.
        # The caller is responsible for deciding which weeks are "past";
        # we simply use a very long TTL for all of them, and a short TTL
        # for week 0 (waivers) as a conservative default.
        ttl = CACHE_TTL_SECONDS if week == 0 else None  # None = cache forever
        return self._get(f"/v1/league/{league_id}/transactions/{week}", ttl=ttl)

    def get_league_drafts(self, league_id: str) -> list[dict]:
        """GET /v1/league/{league_id}/drafts"""
        return self._get(f"/v1/league/{league_id}/drafts", ttl=CACHE_TTL_SECONDS)

    def get_draft_picks(self, draft_id: str) -> list[dict]:
        """GET /v1/draft/{draft_id}/picks — cache forever (completed drafts)"""
        return self._get(f"/v1/draft/{draft_id}/picks", ttl=None)

    def get_traded_picks(self, league_id: str) -> list[dict]:
        """GET /v1/league/{league_id}/traded_picks"""
        return self._get(f"/v1/league/{league_id}/traded_picks", ttl=CACHE_TTL_SECONDS)

    def get_all_players(self) -> dict[str, dict]:
        """
        GET /v1/players/nfl

        Returns a massive dict of {sleeper_id: player_metadata}.
        7-day TTL — refresh weekly at most.
        """
        return self._get("/v1/players/nfl", ttl=PLAYERS_TTL_SECONDS)

    def get_user_by_username(self, username: str) -> dict:
        """GET /v1/user/{username}"""
        return self._get(f"/v1/user/{username}", ttl=CACHE_TTL_SECONDS)

    # ------------------------------------------------------------------
    # Cache internals
    # ------------------------------------------------------------------

    def _get(self, path: str, ttl: int | None) -> Any:
        """
        Fetch from cache if fresh; otherwise hit the Sleeper API and store.

        ttl=None means cache forever (past data that never changes).
        ttl=N   means re-fetch if the cached entry is older than N seconds.
        """
        url = BASE_URL + path
        cached = self._cache_get(url, ttl)
        if cached is not None:
            logger.debug("Cache hit: %s", url)
            return cached

        logger.debug("Cache miss, fetching: %s", url)
        time.sleep(REQUEST_DELAY_SECONDS)

        resp = self._session.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        self._cache_set(url, data)
        return data

    def _cache_get(self, url: str, ttl: int | None) -> Any | None:
        """
        Return deserialized JSON from cache if present and fresh.
        Returns None on miss or stale entry.
        """
        row = self._conn.execute(
            "SELECT response_json, fetched_at FROM sleeper_cache WHERE url = ?",
            (url,),
        ).fetchone()

        if row is None:
            return None

        if ttl is not None:
            fetched_at = _parse_ts(row["fetched_at"])
            age_seconds = (datetime.now(timezone.utc) - fetched_at).total_seconds()
            if age_seconds > ttl:
                logger.debug("Cache stale (%.0fs old, ttl=%ds): %s", age_seconds, ttl, url)
                return None

        return json.loads(row["response_json"])

    def _cache_set(self, url: str, data: Any) -> None:
        """Store a fresh response in the cache."""
        self._conn.execute(
            """
            INSERT OR REPLACE INTO sleeper_cache (url, response_json, fetched_at)
            VALUES (?, ?, ?)
            """,
            (url, json.dumps(data), datetime.now(timezone.utc).isoformat()),
        )
        self._conn.commit()


def _parse_ts(ts_str: str) -> datetime:
    """Parse an ISO timestamp string, adding UTC timezone if missing."""
    dt = datetime.fromisoformat(ts_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
