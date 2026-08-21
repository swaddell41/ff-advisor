"""
Draft board for the Chrome extension's live draft assistant.

Returns every valued player ranked for the requested mode:
  redraft — FantasyCalc redraft values (fc_redraft) + ADP. What an August
            seasonal draft should run on.
  dynasty — our RosterAudit values with market alongside.

Tier breaks are computed per position from value gaps: a new tier starts
when the drop to the next player exceeds TIER_GAP_PCT of the previous
player's value (and a small absolute floor so the tail doesn't fragment).
The extension subtracts drafted players client-side — this board is
draft-agnostic and cacheable.
"""

from __future__ import annotations

import json
from sqlite3 import Connection

TIER_GAP_PCT = 0.12
TIER_GAP_MIN = 150


def _latest(conn: Connection, source: str, fmt: str) -> str | None:
    row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source=? AND format=?",
        (source, fmt),
    ).fetchone()
    return row["d"] if row else None


def draft_board(conn: Connection, fmt: str = "sf_ppr", mode: str = "redraft") -> dict:
    rank_source = "fc_redraft" if mode == "redraft" else "rosteraudit"
    rank_snap = _latest(conn, rank_source, fmt)
    if rank_snap is None and mode == "redraft":
        # No redraft snapshot yet — fall back to dynasty rather than 500.
        rank_source, mode = "rosteraudit", "dynasty"
        rank_snap = _latest(conn, rank_source, fmt)

    dyn_snap = _latest(conn, "rosteraudit", fmt)
    mkt_snap = _latest(conn, "fantasycalc", fmt)
    adp_row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM adp_snapshots WHERE source='fantasycalc' AND format=?",
        (fmt,),
    ).fetchone()
    adp_snap = adp_row["d"] if adp_row else None

    rows = conn.execute(
        """
        SELECT vs.player_id, vs.value as rank_value,
               pl.full_name, pl.position, pl.team, pl.birth_date, pl.raw_json,
               dyn.value as dynasty_value,
               mkt.value as market_value,
               adp.adp as adp,
               ids.espn_id as espn_id
        FROM value_snapshots vs
        JOIN players pl ON pl.sleeper_id = vs.player_id
        LEFT JOIN player_ids ids ON ids.sleeper_id = vs.player_id
        LEFT JOIN value_snapshots dyn
               ON dyn.player_id = vs.player_id AND dyn.source='rosteraudit'
              AND dyn.format = ? AND dyn.snapshot_date = ?
        LEFT JOIN value_snapshots mkt
               ON mkt.player_id = vs.player_id AND mkt.source='fantasycalc'
              AND mkt.format = ? AND mkt.snapshot_date = ?
        LEFT JOIN adp_snapshots adp
               ON adp.player_id = vs.player_id AND adp.source='fantasycalc'
              AND adp.format = ? AND adp.snapshot_date = ?
        WHERE vs.source = ? AND vs.format = ? AND vs.snapshot_date = ?
          AND vs.value > 0
          -- Only draftable players: Inactive on Sleeper = out of the NFL
          -- (retired/cut). IR/PUP players stay — they're stashable.
          AND (pl.status IS NULL OR pl.status != 'Inactive')
        ORDER BY vs.value DESC
        """,
        (fmt, dyn_snap, fmt, mkt_snap, fmt, adp_snap, rank_source, fmt, rank_snap),
    ).fetchall()

    players = []
    for r in rows:
        injury = None
        if r["raw_json"]:
            raw = json.loads(r["raw_json"])
            if raw.get("injury_status"):
                injury = raw.get("injury_status")
        players.append({
            "player_id": r["player_id"],
            "name": r["full_name"],
            "position": r["position"],
            "team": r["team"],
            "value": r["rank_value"],
            "dynasty_value": r["dynasty_value"],
            "market_value": r["market_value"],
            "adp": r["adp"],
            "espn_id": r["espn_id"],
            "injury_status": injury,
        })

    # Overall + positional ranks, and tier breaks per position
    pos_counters: dict[str, int] = {}
    pos_prev_value: dict[str, int] = {}
    pos_tier: dict[str, int] = {}
    for i, p in enumerate(players):
        p["overall_rank"] = i + 1
        pos = p["position"] or "?"
        pos_counters[pos] = pos_counters.get(pos, 0) + 1
        p["pos_rank"] = pos_counters[pos]
        prev = pos_prev_value.get(pos)
        if prev is None:
            pos_tier[pos] = 1
        else:
            gap = prev - p["value"]
            if gap > max(TIER_GAP_MIN, prev * TIER_GAP_PCT):
                pos_tier[pos] += 1
        p["tier"] = pos_tier[pos]
        pos_prev_value[pos] = p["value"]

    return {
        "mode": mode,
        "format": fmt,
        "rank_source": rank_source,
        "snapshot_date": rank_snap,
        "players": players,
    }
