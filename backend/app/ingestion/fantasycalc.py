"""
FantasyCalc value source — the "market" second opinion.

FantasyCalc derives values from actual completed trades across thousands of
real dynasty leagues, which makes it the closest thing to observed market
price that exists. We snapshot it alongside RosterAudit NOT to replace our
pricing, but to flag where the two disagree — a large spread on an asset
means its value is contested (injury recoveries, hype rookies, aging vets)
and any verdict leaning on it should be read as conditional.

API: https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1
  - Players carry a direct sleeperId.
  - Picks appear as entities: "2027 2nd (Mid)", "2027 2nd (Early)", etc.
  - No TEP preset exists, so TEP formats reuse the SF numbers (documented
    approximation — this is a reference layer, not the pricing base).

Values are normalized onto RosterAudit's scale at write time using the ratio
of summed values over the shared player set, so downstream comparisons are
direct.
"""

from __future__ import annotations

import logging
import re
from datetime import date
from sqlite3 import Connection

import requests

logger = logging.getLogger(__name__)

FC_URL = "https://api.fantasycalc.com/values/current"
SOURCE_NAME = "fantasycalc"

# name pattern for pick entities: "2027 2nd (Mid)" / "2027 1st"
_PICK_RE = re.compile(r"^(\d{4}) (\d)(?:st|nd|rd|th)(?: \((Early|Mid|Late)\))?$")


def fetch_fantasycalc(num_qbs: int = 2, ppr: int = 1, num_teams: int = 12) -> list[dict]:
    resp = requests.get(
        FC_URL,
        params={
            "isDynasty": "true",
            "numQbs": num_qbs,
            "numTeams": num_teams,
            "ppr": ppr,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def _normalization_factor(conn: Connection, fmt: str, snap_date: str, fc_players: dict[str, float]) -> float:
    """
    Scale factor mapping FantasyCalc values onto RosterAudit's scale:
    ratio of summed RA values to summed FC values over the shared player set.
    """
    rows = conn.execute(
        "SELECT player_id, value FROM value_snapshots "
        "WHERE source='rosteraudit' AND format=? AND snapshot_date=? AND value > 0",
        (fmt, snap_date),
    ).fetchall()
    ra_sum = 0.0
    fc_sum = 0.0
    for r in rows:
        fc_val = fc_players.get(r["player_id"])
        if fc_val:
            ra_sum += r["value"]
            fc_sum += fc_val
    if fc_sum <= 0:
        logger.warning("No shared players for normalization (fmt=%s) — using factor 1.0", fmt)
        return 1.0
    factor = ra_sum / fc_sum
    logger.info("fmt=%s: normalization factor %.3f over %d shared players", fmt, factor, len(rows))
    return factor


def write_fantasycalc_snapshots(
    conn: Connection,
    format_keys: list[str],
    snapshot_date: date,
) -> tuple[int, int]:
    """
    Fetch FantasyCalc (superflex for sf_* formats, 1QB otherwise) and write
    normalized player + pick snapshots for each format key.

    Returns (player_rows, pick_rows).
    """
    data_by_qbs: dict[int, list[dict]] = {}
    total_players = 0
    total_picks = 0
    d_iso = snapshot_date.isoformat()

    for fmt in format_keys:
        num_qbs = 2 if fmt.startswith("sf") else 1
        if num_qbs not in data_by_qbs:
            data_by_qbs[num_qbs] = fetch_fantasycalc(num_qbs=num_qbs)
        entries = data_by_qbs[num_qbs]

        fc_players: dict[str, float] = {}
        # Redraft values + ADP ride along in the same payload — the draft
        # assistant needs both (dynasty values are wrong for redraft drafts).
        fc_redraft: dict[str, float] = {}
        fc_adp: dict[str, float] = {}
        # (season, round) → {"early": v, "mid": v, "late": v}
        fc_picks: dict[tuple[int, int], dict[str, float]] = {}

        for e in entries:
            p = e.get("player") or {}
            name = p.get("name") or ""
            value = e.get("value") or 0
            m = _PICK_RE.match(name)
            if m or p.get("position") == "PICK":
                if not m:
                    continue
                season, rnd, slot = int(m.group(1)), int(m.group(2)), m.group(3)
                slot_key = (slot or "Mid").lower()
                fc_picks.setdefault((season, rnd), {})[slot_key] = value
            else:
                sid = p.get("sleeperId")
                if sid:
                    fc_players[str(sid)] = value
                    if e.get("redraftValue"):
                        fc_redraft[str(sid)] = e["redraftValue"]
                    if e.get("maybeAdp"):
                        fc_adp[str(sid)] = e["maybeAdp"]

        factor = _normalization_factor(conn, fmt, d_iso, fc_players)

        for sid, value in fc_players.items():
            conn.execute(
                "INSERT OR REPLACE INTO value_snapshots (player_id, source, format, snapshot_date, value) "
                "VALUES (?, ?, ?, ?, ?)",
                (sid, SOURCE_NAME, fmt, d_iso, round(value * factor)),
            )
            total_players += 1

        # Redraft values stored RAW (own scale — only compared to each other)
        for sid, value in fc_redraft.items():
            conn.execute(
                "INSERT OR REPLACE INTO value_snapshots (player_id, source, format, snapshot_date, value) "
                "VALUES (?, ?, ?, ?, ?)",
                (sid, "fc_redraft", fmt, d_iso, round(value)),
            )
        for sid, adp in fc_adp.items():
            conn.execute(
                "INSERT OR REPLACE INTO adp_snapshots (player_id, source, format, snapshot_date, adp) "
                "VALUES (?, ?, ?, ?, ?)",
                (sid, SOURCE_NAME, fmt, d_iso, round(adp, 1)),
            )

        for (season, rnd), slots in fc_picks.items():
            mid = slots.get("mid")
            if mid is None:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO pick_value_snapshots "
                "(season, round, source, format, snapshot_date, early_value, mid_value, late_value) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    season, rnd, SOURCE_NAME, fmt, d_iso,
                    round(slots["early"] * factor) if "early" in slots else None,
                    round(mid * factor),
                    round(slots["late"] * factor) if "late" in slots else None,
                ),
            )
            total_picks += 1

        conn.commit()
        logger.info(
            "fmt=%s: wrote %d fantasycalc player rows, %d pick rows",
            fmt, len(fc_players), len(fc_picks),
        )

    return total_players, total_picks
