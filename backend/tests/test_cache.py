"""
Tests for the Sleeper HTTP cache layer.

Covers:
- Cache miss: fetches from network and stores response
- Cache hit: returns stored response without network call
- TTL expiry: re-fetches when cached entry is older than TTL
- Cache forever (TTL=None): never re-fetches regardless of age
"""

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
import responses as resp_lib

from app.db import init_schema
from app.ingestion.sleeper import SleeperClient


@pytest.fixture
def conn():
    """In-memory SQLite connection with schema initialized."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    init_schema(c)
    yield c
    c.close()


@pytest.fixture
def client(conn):
    return SleeperClient(conn)


# ---------------------------------------------------------------------------
# Cache miss → network fetch → stored in cache
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_cache_miss_fetches_and_stores(conn, client):
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/TEST123",
        json={"league_id": "TEST123", "name": "Test League"},
        status=200,
    )

    result = client.get_league("TEST123")
    assert result["league_id"] == "TEST123"

    # Exactly one HTTP call
    assert len(resp_lib.calls) == 1

    # Stored in cache
    row = conn.execute(
        "SELECT response_json FROM sleeper_cache WHERE url = ?",
        ("https://api.sleeper.app/v1/league/TEST123",),
    ).fetchone()
    assert row is not None
    cached_data = json.loads(row["response_json"])
    assert cached_data["name"] == "Test League"


# ---------------------------------------------------------------------------
# Cache hit → no network call
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_cache_hit_skips_network(conn, client):
    # Pre-populate cache with a fresh entry
    fresh_ts = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO sleeper_cache (url, response_json, fetched_at) VALUES (?, ?, ?)",
        (
            "https://api.sleeper.app/v1/league/HIT123",
            json.dumps({"league_id": "HIT123", "name": "Cached League"}),
            fresh_ts,
        ),
    )
    conn.commit()

    # Register a mock that should NOT be called
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/HIT123",
        json={"league_id": "HIT123", "name": "Should Not Be Fetched"},
        status=200,
    )

    result = client.get_league("HIT123")
    assert result["name"] == "Cached League"
    assert len(resp_lib.calls) == 0  # no network calls made


# ---------------------------------------------------------------------------
# TTL expiry → re-fetches stale entry
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_cache_ttl_expired_refetches(conn, client):
    # Insert a cache entry older than CACHE_TTL_SECONDS (1 hour)
    stale_ts = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    conn.execute(
        "INSERT INTO sleeper_cache (url, response_json, fetched_at) VALUES (?, ?, ?)",
        (
            "https://api.sleeper.app/v1/league/STALE123",
            json.dumps({"league_id": "STALE123", "name": "Old Data"}),
            stale_ts,
        ),
    )
    conn.commit()

    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/STALE123",
        json={"league_id": "STALE123", "name": "Fresh Data"},
        status=200,
    )

    result = client.get_league("STALE123")
    assert result["name"] == "Fresh Data"
    assert len(resp_lib.calls) == 1  # network was hit to refresh


# ---------------------------------------------------------------------------
# Cache forever (TTL=None) → never re-fetches even if very old
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_cache_forever_never_refetches(conn, client):
    # Insert a very old entry for a past-week transactions URL
    ancient_ts = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
    url = "https://api.sleeper.app/v1/league/FOREVER123/transactions/5"
    conn.execute(
        "INSERT INTO sleeper_cache (url, response_json, fetched_at) VALUES (?, ?, ?)",
        (url, json.dumps([{"transaction_id": "TX1", "type": "trade"}]), ancient_ts),
    )
    conn.commit()

    resp_lib.add(resp_lib.GET, url, json=[], status=200)

    result = client.get_transactions("FOREVER123", 5)
    # TTL=None for week > 0 — should return cached data without network call
    assert len(resp_lib.calls) == 0
    assert result[0]["transaction_id"] == "TX1"


# ---------------------------------------------------------------------------
# Cache is updated after a fresh fetch
# ---------------------------------------------------------------------------

@resp_lib.activate
def test_cache_updated_after_fetch(conn, client):
    resp_lib.add(
        resp_lib.GET,
        "https://api.sleeper.app/v1/league/UPDATE123",
        json={"league_id": "UPDATE123"},
        status=200,
    )

    client.get_league("UPDATE123")

    row = conn.execute(
        "SELECT fetched_at FROM sleeper_cache WHERE url = ?",
        ("https://api.sleeper.app/v1/league/UPDATE123",),
    ).fetchone()
    assert row is not None
    # fetched_at should be close to now
    fetched = datetime.fromisoformat(row["fetched_at"])
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - fetched).total_seconds()
    assert age < 5  # stored within the last 5 seconds
