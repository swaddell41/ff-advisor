"""
Asset-first sell analysis.

The user picks a specific asset they hold — a player or a future pick — and
this module ranks league-mates as buyers, blending:

  need        (35%) — how thin they are at the asset's position (or how short
                      on draft capital, for picks). Desperation sells.
  overpay     (30%) — their history when *acquiring* this position and this
                      age bracket, plus their overall trade record. A manager
                      who has paid -20% when buying WRs will do it again.
  posture     (15%) — who buys what: contenders buy veterans, rebuilders buy
                      youth and picks, nobody in between buys anything easily.
  payment     (20%) — can they actually pay me with things I want: draft
                      capital surplus, or players at positions where I'm thin.

For each buyer we also propose ASKS — what to request in return — priced at
a premium over sticker when their biases suggest they'll pay it (they overpay
for the position, they're a desperate contender, they burn picks anyway).
"""

from __future__ import annotations

import logging
from datetime import date
from sqlite3 import Connection

from app.acquire import (
    DYNASTY_POSITIONS,
    VETERAN_AGE,
    _age_now,
    _clamp,
    _my_pick_inventory,
    _pick_value_now,
    _latest_pick_snap_date,
    _position_roster,
)
from app.pick_conversion import PickResolutionContext, compute_pick_conversion
from app.profiles.engine import (
    _ensure_graded,
    _get_manager_trades,
    classify_posture,
    compute_age_biases,
    compute_differential_stats,
    compute_position_biases,
    compute_positional_needs,
    compute_posture_patterns,
    get_league_family_ids,
)

logger = logging.getLogger(__name__)

W_NEED = 0.35
W_OVERPAY = 0.30
W_POSTURE = 0.15
W_PAYMENT = 0.20

MAX_PREMIUM = 0.25


def _age_bucket(age: float | None) -> str | None:
    if age is None:
        return None
    if age <= 23:
        return "young"
    if age <= 26:
        return "prime"
    return "veteran"


def _posture_appetite(their_posture: str, age: float | None) -> float:
    """How much this posture wants this kind of player."""
    bucket = _age_bucket(age)
    table = {
        "veteran": {"contend": 1.0, "middling": 0.55, "rebuild": 0.2},
        "prime":   {"contend": 0.9, "middling": 0.6, "rebuild": 0.4},
        "young":   {"contend": 0.7, "middling": 0.6, "rebuild": 0.85},
        None:       {"contend": 0.6, "middling": 0.6, "rebuild": 0.6},
    }
    return table[bucket][their_posture]


# ---------------------------------------------------------------------------
# My sellable assets
# ---------------------------------------------------------------------------

def my_assets(conn: Connection, my_user_id: str, league_id: str) -> dict:
    """Everything I could sell: full roster with values, plus future picks."""
    family_ids = get_league_family_ids(conn, league_id)
    ph = ",".join("?" * len(family_ids))
    current_league_row = conn.execute(
        f"SELECT id, format_key FROM leagues WHERE id IN ({ph}) ORDER BY season DESC LIMIT 1",
        family_ids,
    ).fetchone()
    current_league_id = current_league_row["id"] if current_league_row else league_id
    fmt = (current_league_row["format_key"] if current_league_row else None) or "sf_ppr"

    row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source='rosteraudit' AND format=?",
        (fmt,),
    ).fetchone()
    snap_date = row["d"] if row else None

    players = []
    for pos in DYNASTY_POSITIONS:
        players.extend(
            {**p, "position": pos}
            for p in _position_roster(conn, current_league_id, my_user_id, pos, fmt, snap_date)
        )
    players.sort(key=lambda p: p["value"], reverse=True)

    my_roster_row = conn.execute(
        "SELECT roster_id FROM league_managers WHERE league_id = ? AND user_id = ?",
        (current_league_id, my_user_id),
    ).fetchone()
    my_roster_id = my_roster_row["roster_id"] if my_roster_row else None

    pick_ctx = PickResolutionContext(conn, league_id)
    picks = _my_pick_inventory(conn, current_league_id, my_roster_id, fmt, pick_ctx.last_drafted_season)

    return {
        "league_id": league_id,
        "current_league_id": current_league_id,
        "format_key": fmt,
        "snapshot_date": snap_date,
        "players": players,
        "picks": picks,
    }


# ---------------------------------------------------------------------------
# Ask construction — what to request from a buyer
# ---------------------------------------------------------------------------

def _ask_packages(
    ask_value: int,
    their_picks: list[dict],
    their_players_at_my_needs: list[dict],
) -> list[dict]:
    """Up to three ask shapes at or above the premium-adjusted ask price."""
    asks = []

    # Picks-only ask
    combo: list[dict] = []
    total = 0
    for p in their_picks:
        if len(combo) >= 3:
            break
        if total + p["value"] <= ask_value * 1.25:
            combo.append(p)
            total += p["value"]
            if total >= ask_value * 0.9:
                break
    def _pick_item(p: dict) -> dict:
        return {
            "label": p["label"],
            "value": p["value"],
            "ref": {"type": "pick", "season": p["season"], "round": p["round"]},
        }

    def _player_item(pl: dict) -> dict:
        return {
            "label": f"{pl['name']} ({pl['position']})",
            "value": pl["value"],
            "ref": {"type": "player", "player_id": pl["player_id"]},
        }

    if combo and total >= ask_value * 0.9:
        asks.append({
            "kind": "picks_only",
            "items": [_pick_item(p) for p in combo],
            "ask_total": total,
        })

    # Single player at one of my need positions
    swap = next(
        (pl for pl in their_players_at_my_needs
         if ask_value * 0.85 <= pl["value"] <= ask_value * 1.3),
        None,
    )
    if swap:
        asks.append({
            "kind": "player",
            "items": [_player_item(swap)],
            "ask_total": swap["value"],
        })

    # Player + pick mix
    for pl in their_players_at_my_needs:
        if pl["value"] >= ask_value * 0.95:
            continue
        gap_lo = ask_value * 0.9 - pl["value"]
        gap_hi = ask_value * 1.25 - pl["value"]
        filler = next((p for p in reversed(their_picks) if gap_lo <= p["value"] <= gap_hi), None)
        if filler and pl["value"] >= ask_value * 0.4:
            asks.append({
                "kind": "player_plus_pick",
                "items": [_player_item(pl), _pick_item(filler)],
                "ask_total": pl["value"] + filler["value"],
            })
            break

    return asks[:3]


# ---------------------------------------------------------------------------
# Sell report
# ---------------------------------------------------------------------------

def sell_report(
    conn: Connection,
    my_user_id: str,
    league_id: str,
    asset: dict,
) -> dict:
    """
    Rank buyers for one of my assets.

    asset: {"type": "player", "player_id": "..."} or
           {"type": "pick", "season": 2027, "round": 2}
    """
    family_ids = get_league_family_ids(conn, league_id)
    _ensure_graded(conn, family_ids)

    needs_data = compute_positional_needs(conn, my_user_id, league_id)
    fmt = needs_data["format_key"]
    snap_date = needs_data["snapshot_date"]
    league_avg = needs_data["league_avg"]
    all_manager_values = needs_data["all_managers"]
    pick_capital = needs_data.get("pick_capital", {})
    my_needs = needs_data["needs"]
    my_need_positions = [
        p for p in DYNASTY_POSITIONS if my_needs.get(p, {}).get("need_score", 0) > 0.05
    ]

    ph = ",".join("?" * len(family_ids))
    current_league_row = conn.execute(
        f"SELECT id FROM leagues WHERE id IN ({ph}) ORDER BY season DESC LIMIT 1",
        family_ids,
    ).fetchone()
    current_league_id = current_league_row["id"] if current_league_row else league_id

    pick_ctx = PickResolutionContext(conn, league_id)
    pick_snap = _latest_pick_snap_date(conn, fmt)

    # ── Resolve the asset ──────────────────────────────────────────────
    if asset["type"] == "player":
        prow = conn.execute(
            """
            SELECT pl.sleeper_id, pl.full_name, pl.position, pl.birth_date, pl.team,
                   COALESCE(vs.value, 0) as value
            FROM players pl
            LEFT JOIN value_snapshots vs
                   ON vs.player_id = pl.sleeper_id AND vs.source='rosteraudit'
                  AND vs.format = ? AND vs.snapshot_date = ?
            WHERE pl.sleeper_id = ?
            """,
            (fmt, snap_date, asset["player_id"]),
        ).fetchone()
        if prow is None:
            raise ValueError(f"Player {asset['player_id']} not found")
        asset_info = {
            "type": "player",
            "player_id": prow["sleeper_id"],
            "name": prow["full_name"],
            "position": prow["position"],
            "team": prow["team"],
            "age": _age_now(prow["birth_date"]),
            "value": prow["value"],
        }
    elif asset["type"] == "pick":
        value = _pick_value_now(conn, fmt, asset["season"], asset["round"], pick_snap)
        asset_info = {
            "type": "pick",
            "season": asset["season"],
            "round": asset["round"],
            "name": f"{asset['season']} R{asset['round']}",
            "position": None,
            "age": None,
            "value": value,
        }
    else:
        raise ValueError("asset.type must be 'player' or 'pick'")

    pos = asset_info["position"]
    age = asset_info["age"]
    sticker = asset_info["value"]

    # Posture overrides
    override_rows = conn.execute(
        f"SELECT user_id, posture FROM user_posture_overrides WHERE league_id IN ({ph})",
        family_ids,
    ).fetchall()
    posture_overrides = {r["user_id"]: r["posture"] for r in override_rows}

    other_managers = conn.execute(
        """
        SELECT DISTINCT lm.user_id, lm.roster_id, m.display_name, m.username
        FROM league_managers lm
        LEFT JOIN managers m ON m.user_id = lm.user_id
        WHERE lm.league_id = ? AND lm.user_id != ?
        """,
        (current_league_id, my_user_id),
    ).fetchall()

    buyers = []
    for row in other_managers:
        uid = row["user_id"]
        name = row["display_name"] or row["username"] or uid

        trades = _get_manager_trades(conn, uid, family_ids)
        diff_stats = compute_differential_stats(trades) if trades else None
        pos_biases = compute_position_biases(trades) if trades else {}
        age_biases = compute_age_biases(trades) if trades else {}
        their_posture = posture_overrides.get(uid) or (
            classify_posture(compute_posture_patterns(trades)) if trades else "middling"
        )
        avg_diff = (diff_stats or {}).get("avg_decision_differential") or 0.0
        their_pick_score = pick_capital.get(uid, {}).get("pick_capital_score", 0.0)
        conv = compute_pick_conversion(conn, uid, league_id, ctx=pick_ctx)

        signals: list[str] = []

        # ── Need ───────────────────────────────────────────────────────
        if pos is not None:
            avg_at_pos = league_avg.get(pos, 0) or 0
            their_val = all_manager_values.get(uid, {}).get(pos, 0)
            deficit = (avg_at_pos - their_val) / avg_at_pos if avg_at_pos > 0 else 0.0
            need_score = _clamp(deficit / 0.40)
            if deficit > 0.10:
                signals.append(f"thin at {pos} ({round(-deficit * 100)}% vs league avg)")
        else:
            # Selling a pick: need = they're short on draft capital
            deficit = -their_pick_score
            need_score = _clamp(0.5 + deficit)
            if their_pick_score < -0.10:
                signals.append("short on draft capital")

        # ── Overpay likelihood ─────────────────────────────────────────
        acq_pos_bias = None
        acq_pos_n = 0
        if pos is not None:
            acq = pos_biases.get(pos, {}).get("acquiring", {})
            acq_pos_bias = acq.get("avg_differential")
            acq_pos_n = acq.get("count", 0)

        acq_age_bias = None
        bucket = _age_bucket(age)
        if bucket is not None:
            aacq = age_biases.get(bucket, {}).get("acquiring", {})
            if aacq.get("count", 0) >= 2:
                acq_age_bias = aacq.get("avg_differential")

        overpay_score = _clamp(
            0.5
            + (-(acq_pos_bias or 0.0)) * 2.0 * (1 if acq_pos_n >= 2 else 0)
            + (-(acq_age_bias or 0.0)) * 1.0
            + (-avg_diff) * 1.0
        )
        if acq_pos_bias is not None and acq_pos_n >= 2 and acq_pos_bias < -0.05:
            a = pos_biases[pos]["acquiring"]
            signals.append(
                f"overpays for {pos}s ({round(acq_pos_bias * 100)}% avg, "
                f"{a.get('wins', 0)}W-{a.get('losses', 0)}L in {acq_pos_n} buys)"
            )
        if acq_age_bias is not None and acq_age_bias < -0.06 and bucket:
            signals.append(f"overpays for {bucket} players ({round(acq_age_bias * 100)}% avg)")

        # ── Posture appetite ───────────────────────────────────────────
        if pos is not None:
            posture_score = _posture_appetite(their_posture, age)
        else:
            # Picks: rebuilders want them; pick-hitters value them
            posture_score = {"rebuild": 1.0, "middling": 0.6, "contend": 0.35}[their_posture]
            acq_med = conv["acquired"]["median_return_ratio"]
            if acq_med is not None and acq_med >= 1.3:
                posture_score = max(posture_score, 0.8)
                signals.append("their acquired picks tend to hit — they value draft capital")

        # ── Payment ability ────────────────────────────────────────────
        their_picks = _my_pick_inventory(
            conn, current_league_id, row["roster_id"], fmt, pick_ctx.last_drafted_season
        )
        their_pick_total = sum(p["value"] for p in their_picks)

        their_players_at_my_needs: list[dict] = []
        for need_pos in my_need_positions:
            if need_pos == pos:
                continue
            roster = _position_roster(conn, current_league_id, uid, need_pos, fmt, snap_date)
            for pl in roster:
                if pl["rank"] >= 2 and pl["value"] > 0:
                    pl["position"] = need_pos
                    their_players_at_my_needs.append(pl)
        their_players_at_my_needs.sort(key=lambda p: p["value"], reverse=True)

        payment_score = 0.3
        if their_pick_total >= sticker * 0.9:
            payment_score = max(payment_score, 0.85)
            if their_pick_score > 0.10:
                signals.append("has surplus draft capital to spend")
        if their_players_at_my_needs and my_need_positions:
            payment_score = max(payment_score, 0.7)

        buyer_score = round(
            need_score * W_NEED
            + overpay_score * W_OVERPAY
            + posture_score * W_POSTURE
            + payment_score * W_PAYMENT,
            3,
        )

        # ── Premium + asks ─────────────────────────────────────────────
        premium = 0.0
        premium_reasons: list[str] = []
        if acq_pos_bias is not None and acq_pos_n >= 2 and acq_pos_bias < -0.05:
            bump = min(MAX_PREMIUM, abs(acq_pos_bias))
            premium += bump
            premium_reasons.append(f"they've paid {round(acq_pos_bias * 100)}% when buying {pos}s")
        if acq_age_bias is not None and acq_age_bias < -0.06:
            premium += min(0.08, abs(acq_age_bias) / 2)
            premium_reasons.append(f"they overpay for {bucket} players")
        if pos is not None and their_posture == "contend" and need_score > 0.3:
            premium += 0.05
            premium_reasons.append("contender with a hole to fill")
        premium = min(MAX_PREMIUM, premium)
        ask_value = round(sticker * (1 + premium))

        # When selling a pick, asking for picks back is a pointless swap —
        # only propose player-based returns.
        ask_picks = their_picks if asset_info["type"] == "player" else []
        asks = _ask_packages(ask_value, ask_picks, their_players_at_my_needs) if sticker > 0 else []

        posture_word = {"rebuild": "Rebuilding", "contend": "Contending", "middling": "Middling"}[their_posture]
        summary = f"{posture_word}. " + (
            " ".join(s.rstrip(".") + "." for s in signals)
            if signals else "No strong edge — expect a market-price negotiation."
        )

        buyers.append({
            "user_id": uid,
            "manager_name": name,
            "their_posture": their_posture,
            "buyer_score": buyer_score,
            "scores": {
                "need": round(need_score, 3),
                "overpay": round(overpay_score, 3),
                "posture": round(posture_score, 3),
                "payment": round(payment_score, 3),
            },
            "acq_pos_bias": acq_pos_bias,
            "acq_pos_count": acq_pos_n,
            "avg_decision_differential": (diff_stats or {}).get("avg_decision_differential"),
            "total_trades": (diff_stats or {}).get("total_trades", 0),
            "pick_capital_score": round(their_pick_score, 3),
            "their_picks": their_picks,
            "premium_pct": round(premium, 3),
            "premium_reasons": premium_reasons,
            "ask_value": ask_value,
            "asks": asks,
            "summary": summary,
        })

    buyers.sort(key=lambda b: b["buyer_score"], reverse=True)

    league_row = conn.execute("SELECT name FROM leagues WHERE id = ?", (league_id,)).fetchone()
    return {
        "league_id": league_id,
        "league_name": league_row["name"] if league_row else league_id,
        "format_key": fmt,
        "snapshot_date": snap_date,
        "asset": asset_info,
        "my_need_positions": my_need_positions,
        "buyers": buyers,
    }
