"""
Pick-conversion analytics.

Resolves draft picks that changed hands in trades to the player actually
selected with them (via cached Sleeper draft results), then compares the
pick's cost at trade time to that player's value today.

The headline question, per manager: "when this manager accepts picks as
payment, do those picks ever turn into anything?" A manager whose acquired
picks consistently bust treats picks as cheap currency — which makes them a
good target to buy players from with draft capital.

Resolution chain for a pick asset (season, round, original_owner_roster_id):
  1. Find the completed draft for that season in the league family.
  2. original_owner_roster_id → user_id (league_managers of the draft's league)
  3. user_id → draft slot (draft_order on the draft object)
  4. (round, slot) → the pick made there → player_id
Snake drafts reverse even-round slots; rookie drafts are typically linear.

Ratios are computed as player_value_today / pick_cost_at_trade_time.
  hit:  ratio >= 1.0
  bust: ratio < 0.5
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from sqlite3 import Connection

from app.value_sources import RosterAuditValueSource
from app.profiles.engine import get_league_family_ids

logger = logging.getLogger(__name__)

HIT_RATIO = 1.0
BUST_RATIO = 0.5


class PickResolutionContext:
    """
    Preloaded draft + roster data for one league family, so per-manager
    conversion stats don't re-read the sleeper_cache for every call.
    """

    def __init__(self, conn: Connection, anchor_league_id: str) -> None:
        self.conn = conn
        self.family_ids = get_league_family_ids(conn, anchor_league_id)

        league_row = conn.execute(
            "SELECT format_key FROM leagues WHERE id = ?", (anchor_league_id,)
        ).fetchone()
        self.fmt = (league_row["format_key"] if league_row else None) or "sf_ppr"
        self.source = RosterAuditValueSource(conn)

        # season → draft info
        self.drafts: dict[int, dict] = {}
        for lid in self.family_ids:
            row = conn.execute(
                "SELECT response_json FROM sleeper_cache WHERE url = ?",
                (f"https://api.sleeper.app/v1/league/{lid}/drafts",),
            ).fetchone()
            if not row:
                continue
            for draft in json.loads(row["response_json"]):
                if draft.get("status") != "complete":
                    continue
                did = draft.get("draft_id")
                try:
                    season = int(draft.get("season"))
                except (TypeError, ValueError):
                    continue
                picks_row = conn.execute(
                    "SELECT response_json FROM sleeper_cache WHERE url = ?",
                    (f"https://api.sleeper.app/v1/draft/{did}/picks",),
                ).fetchone()
                if not picks_row:
                    continue
                picks = json.loads(picks_row["response_json"])
                self.drafts[season] = {
                    "league_id": lid,
                    "draft_order": draft.get("draft_order") or {},
                    "slot_to_roster_id": draft.get("slot_to_roster_id"),
                    "type": draft.get("type"),
                    "picks": picks,
                    "n_slots": max((p.get("draft_slot") or 0) for p in picks) if picks else 0,
                }

        self.last_drafted_season = max(self.drafts) if self.drafts else 0

        # (league_id, roster_id) → user_id across the family
        self.roster_user: dict[tuple[str, int], str] = {}
        for lm in conn.execute(
            f"SELECT league_id, roster_id, user_id FROM league_managers "
            f"WHERE league_id IN ({','.join('?' * len(self.family_ids))})",
            self.family_ids,
        ).fetchall():
            self.roster_user[(lm["league_id"], lm["roster_id"])] = lm["user_id"]

        # latest player-value snapshot date for this format
        row = conn.execute(
            "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source='rosteraudit' AND format=?",
            (self.fmt,),
        ).fetchone()
        self.latest_snap = row["d"] if row else None

    # ------------------------------------------------------------------

    def pick_cost(self, pick_season: int, pick_round: int, as_of: date) -> int | None:
        """
        Value of a pick at trade time. Exact (season, round) snapshot when we
        have one; otherwise estimate from the closest season with the same
        round — RosterAudit history only goes back so far, and a "one year
        out" R2 is roughly a "one year out" R2 in any era.
        """
        val, _ = self.source.get_pick_value(pick_season, pick_round, self.fmt, as_of)
        if val is not None:
            return val
        row = self.conn.execute(
            """
            SELECT mid_value FROM pick_value_snapshots
            WHERE round = ? AND source = 'rosteraudit' AND format = ?
            ORDER BY snapshot_date ASC, season ASC
            LIMIT 1
            """,
            (pick_round, self.fmt),
        ).fetchone()
        return row["mid_value"] if row else None

    def player_value_now(self, player_id: str) -> int | None:
        if not self.latest_snap:
            return None
        row = self.conn.execute(
            "SELECT value FROM value_snapshots WHERE player_id=? AND source='rosteraudit' "
            "AND format=? AND snapshot_date=?",
            (player_id, self.fmt, self.latest_snap),
        ).fetchone()
        # A player missing from the latest snapshot is outside RosterAudit's
        # ranked set — effectively worthless in dynasty terms.
        return row["value"] if row else 0

    def resolve_pick(
        self, pick_season: int, pick_round: int, original_owner_roster_id: int | None
    ) -> tuple[str | None, str]:
        """
        Return (player_id, status) where status is:
          'resolved' — draft happened, player identified
          'pending'  — draft hasn't happened yet
          'unknown'  — draft happened but the slot couldn't be resolved
        """
        if pick_season > self.last_drafted_season:
            return None, "pending"
        info = self.drafts.get(pick_season)
        if info is None or original_owner_roster_id is None:
            return None, "unknown"

        slot = None
        s2r = info.get("slot_to_roster_id")
        if s2r:
            for s, rid in s2r.items():
                if rid == original_owner_roster_id:
                    slot = int(s)
                    break
        if slot is None:
            uid = self.roster_user.get((info["league_id"], original_owner_roster_id))
            if uid is not None:
                slot = info["draft_order"].get(uid)
        if slot is None and info["draft_order"] and info["n_slots"]:
            # A manager can be missing from draft_order (e.g. autodraft).
            # If exactly one slot is unassigned, it must be theirs.
            assigned = set(info["draft_order"].values())
            missing = [s for s in range(1, info["n_slots"] + 1) if s not in assigned]
            if len(missing) == 1:
                slot = missing[0]
        if slot is None:
            return None, "unknown"

        if info.get("type") == "snake" and pick_round % 2 == 0 and info["n_slots"]:
            slot = info["n_slots"] + 1 - slot

        for p in info["picks"]:
            if p.get("round") == pick_round and p.get("draft_slot") == slot:
                return p.get("player_id"), "resolved"
        return None, "unknown"


# ---------------------------------------------------------------------------


def _parse_trade_date(executed_at: str | None) -> date:
    if not executed_at:
        return date.today()
    try:
        return datetime.fromisoformat(executed_at).date()
    except (ValueError, TypeError):
        return date.today()


def _summarise(entries: list[dict]) -> dict:
    resolved = [e for e in entries if e["status"] == "resolved" and e["ratio"] is not None]
    ratios = sorted(e["ratio"] for e in resolved)
    hits = [e for e in resolved if e["ratio"] >= HIT_RATIO]
    busts = [e for e in resolved if e["ratio"] < BUST_RATIO]

    # Median, not mean — one 30x late-round hit shouldn't drown ten busts.
    median = None
    if ratios:
        mid = len(ratios) // 2
        median = ratios[mid] if len(ratios) % 2 else (ratios[mid - 1] + ratios[mid]) / 2

    best = max(resolved, key=lambda e: e["ratio"], default=None)
    worst = min(resolved, key=lambda e: e["ratio"], default=None)

    def _ex(e):
        if e is None:
            return None
        return {
            "player_name": e["player_name"],
            "pick_label": f"{e['pick_season']} R{e['pick_round']}",
            "cost_at_trade": e["cost"],
            "value_now": e["value_now"],
            "ratio": round(e["ratio"], 2),
        }

    return {
        "count": len(entries),
        "resolved": len(resolved),
        "pending": sum(1 for e in entries if e["status"] == "pending"),
        "avg_return_ratio": round(sum(ratios) / len(ratios), 2) if ratios else None,
        "median_return_ratio": round(median, 2) if median is not None else None,
        "hit_rate": round(len(hits) / len(resolved), 2) if resolved else None,
        "bust_rate": round(len(busts) / len(resolved), 2) if resolved else None,
        "best": _ex(best),
        "worst": _ex(worst),
    }


def _tendency(acquired: dict) -> str | None:
    """Plain-language read on what happens to picks this manager accepts."""
    n = acquired["resolved"]
    med = acquired["median_return_ratio"]
    if n < 3 or med is None:
        return None
    bust_rate = acquired["bust_rate"] or 0
    if med < 0.6 or bust_rate >= 0.6:
        return (
            f"Picks they've accepted rarely pan out (median return {med}x cost, "
            f"{int(bust_rate * 100)}% busts in {n} resolved picks) — draft capital is "
            f"cheap currency with this manager."
        )
    if med >= 1.3:
        return (
            f"Picks they've accepted tend to hit (median return {med}x cost in {n} "
            f"resolved picks) — they extract real value from draft capital, so "
            f"picks are expensive currency here."
        )
    return None


def compute_pick_conversion(
    conn: Connection,
    user_id: str,
    anchor_league_id: str,
    ctx: PickResolutionContext | None = None,
) -> dict:
    """
    Full pick-conversion profile for one manager across a league family.

    Returns {"acquired": summary, "shed": summary, "tendency": str | None}
    where each summary covers picks the manager received / gave away in trades.
    """
    if ctx is None:
        ctx = PickResolutionContext(conn, anchor_league_id)

    ph = ",".join("?" * len(ctx.family_ids))
    rows = conn.execute(
        f"""
        SELECT ta.pick_season, ta.pick_round, ta.pick_original_owner_roster_id,
               ta.to_roster_id, ta.from_roster_id,
               t.executed_at, t.league_id
        FROM trade_assets ta
        JOIN trades t ON t.id = ta.trade_id
        WHERE ta.asset_type = 'pick' AND t.league_id IN ({ph})
        """,
        ctx.family_ids,
    ).fetchall()

    acquired: list[dict] = []
    shed: list[dict] = []

    for r in rows:
        to_uid = ctx.roster_user.get((r["league_id"], r["to_roster_id"]))
        from_uid = ctx.roster_user.get((r["league_id"], r["from_roster_id"]))
        if user_id not in (to_uid, from_uid):
            continue

        trade_date = _parse_trade_date(r["executed_at"])
        cost = ctx.pick_cost(r["pick_season"], r["pick_round"], trade_date)
        player_id, status = ctx.resolve_pick(
            r["pick_season"], r["pick_round"], r["pick_original_owner_roster_id"]
        )

        player_name = None
        value_now = None
        ratio = None
        if status == "resolved" and player_id:
            p = conn.execute(
                "SELECT full_name FROM players WHERE sleeper_id = ?", (player_id,)
            ).fetchone()
            player_name = p["full_name"] if p else player_id
            value_now = ctx.player_value_now(player_id)
            if cost and cost > 0 and value_now is not None:
                ratio = value_now / cost

        entry = {
            "pick_season": r["pick_season"],
            "pick_round": r["pick_round"],
            "status": status,
            "cost": cost,
            "player_id": player_id,
            "player_name": player_name,
            "value_now": value_now,
            "ratio": ratio,
        }
        if to_uid == user_id:
            acquired.append(entry)
        if from_uid == user_id:
            shed.append(entry)

    acquired_summary = _summarise(acquired)
    shed_summary = _summarise(shed)
    return {
        "acquired": acquired_summary,
        "shed": shed_summary,
        "tendency": _tendency(acquired_summary),
    }
