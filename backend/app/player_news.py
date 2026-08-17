"""
Player card: everything the tool knows about one player, plus free news.

  - Identity + injury status from the Sleeper player blob we already store
    (players.raw_json) — no network needed.
  - Values from all three sources (rosteraudit / fantasycalc /
    dynastyprocess) with per-source history, so the card can show a trend
    as weekly snapshots accumulate.
  - Headlines from Google News RSS ("<player name>" NFL) — free, no key,
    aggregates many outlets with source attribution. Responses are cached
    in sleeper_cache under a pseudo-URL for NEWS_TTL_SECONDS so repeated
    card opens don't hammer the feed.
"""

from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from sqlite3 import Connection
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

NEWS_TTL_SECONDS = 6 * 3600
NEWS_LIMIT = 12
VALUE_SOURCES = ["rosteraudit", "fantasycalc", "dynastyprocess"]
SOURCE_LABELS = {
    "rosteraudit": "ours",
    "fantasycalc": "market",
    "dynastyprocess": "experts",
}


# ---------------------------------------------------------------------------
# News (Google News RSS, cached)
# ---------------------------------------------------------------------------

def _cache_get(conn: Connection, key: str, ttl: int) -> list | None:
    row = conn.execute(
        "SELECT response_json, fetched_at FROM sleeper_cache WHERE url = ?", (key,)
    ).fetchone()
    if row is None:
        return None
    fetched = datetime.fromisoformat(row["fetched_at"])
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    if (datetime.now(timezone.utc) - fetched).total_seconds() > ttl:
        return None
    return json.loads(row["response_json"])


def _cache_set(conn: Connection, key: str, data: list) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO sleeper_cache (url, response_json, fetched_at) VALUES (?, ?, ?)",
        (key, json.dumps(data), datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


def _parse_rss(xml_text: str) -> list[dict]:
    items = []
    root = ET.fromstring(xml_text)
    for item in root.iter("item"):
        title = item.findtext("title") or ""
        link = item.findtext("link") or ""
        pub = item.findtext("pubDate") or ""
        source_el = item.find("source")
        source = source_el.text if source_el is not None else None
        # Google appends " - Outlet" to titles; strip when it matches the source.
        if source and title.endswith(f" - {source}"):
            title = title[: -len(f" - {source}")]
        published = None
        try:
            published = parsedate_to_datetime(pub).isoformat()
        except (TypeError, ValueError):
            pass
        items.append({"title": title, "link": link, "source": source, "published": published})
    return items


def fetch_player_news(conn: Connection, full_name: str, player_id: str) -> dict:
    """Cached Google News headlines for one player."""
    cache_key = f"news://player/{player_id}"
    cached = _cache_get(conn, cache_key, NEWS_TTL_SECONDS)
    if cached is not None:
        return {"items": cached[:NEWS_LIMIT], "cached": True}

    query = quote(f'"{full_name}" NFL')
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        items = _parse_rss(resp.text)
    except Exception as e:
        logger.warning("News fetch failed for %s: %s", full_name, e)
        stale = _cache_get(conn, cache_key, ttl=10**9)  # any age beats nothing
        return {"items": (stale or [])[:NEWS_LIMIT], "cached": True, "error": str(e)}

    # Sort newest first, dedupe by title.
    seen: set[str] = set()
    deduped = []
    for it in sorted(items, key=lambda x: x["published"] or "", reverse=True):
        k = re.sub(r"\W+", "", it["title"].lower())[:60]
        if k in seen:
            continue
        seen.add(k)
        deduped.append(it)

    _cache_set(conn, cache_key, deduped)
    return {"items": deduped[:NEWS_LIMIT], "cached": False}


# ---------------------------------------------------------------------------
# Card
# ---------------------------------------------------------------------------

def player_card(conn: Connection, league_id: str, player_id: str) -> dict | None:
    league_row = conn.execute(
        "SELECT format_key FROM leagues WHERE id = ?", (league_id,)
    ).fetchone()
    fmt = (league_row["format_key"] if league_row else None) or "sf_ppr"

    prow = conn.execute(
        "SELECT sleeper_id, full_name, position, team, birth_date, status, raw_json "
        "FROM players WHERE sleeper_id = ?",
        (player_id,),
    ).fetchone()
    if prow is None:
        return None

    raw = json.loads(prow["raw_json"]) if prow["raw_json"] else {}
    age = None
    if prow["birth_date"]:
        try:
            bd = datetime.fromisoformat(prow["birth_date"]).date()
            age = round((datetime.now(timezone.utc).date() - bd).days / 365.25, 1)
        except ValueError:
            pass

    # Values + history per source
    values: dict[str, dict] = {}
    for source in VALUE_SOURCES:
        rows = conn.execute(
            "SELECT snapshot_date, value FROM value_snapshots "
            "WHERE player_id = ? AND source = ? AND format = ? ORDER BY snapshot_date",
            (player_id, source, fmt),
        ).fetchall()
        history = [{"date": r["snapshot_date"], "value": r["value"]} for r in rows]
        values[SOURCE_LABELS[source]] = {
            "current": history[-1]["value"] if history else None,
            "history": history,
        }

    news = fetch_player_news(conn, prow["full_name"], player_id)

    return {
        "player_id": prow["sleeper_id"],
        "name": prow["full_name"],
        "position": prow["position"],
        "team": prow["team"],
        "age": age,
        "status": prow["status"],
        "injury": {
            "status": raw.get("injury_status"),
            "body_part": raw.get("injury_body_part"),
            "notes": raw.get("injury_notes"),
        },
        "years_exp": raw.get("years_exp"),
        "depth_chart_order": raw.get("depth_chart_order"),
        "format_key": fmt,
        "values": values,
        "news": news,
    }
