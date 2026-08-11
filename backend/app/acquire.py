"""
Query-driven acquisition targeting.

The user states an intent — "in this league I want to acquire a WR" — and
this module ranks league-mates as sources for that position, shows the actual
players they hold, and proposes concrete packages that exploit each manager's
historical tendencies.

Per target manager, four signals blend into an acquisition score (0-1):

  surplus     (35%) — how far above league average their value at the
                      position is; you can't buy what they don't have.
  seller      (25%) — their history when shedding this position: a negative
                      shedding differential means they've undersold it before.
                      Their overall trade record folds in lightly.
  willingness (20%) — posture: rebuilders sell players, contenders mostly
                      don't (unless the asset is surplus depth).
  payment     (20%) — how cheaply I can pay: they historically accept picks
                      that bust (pick-conversion), or they're short on draft
                      capital and I hold surplus picks.

Package suggestions are rule-based value matching against the latest
RosterAudit snapshot, with a discount applied when the target's biases
suggest they'll take less (undersells the position, accepts busting picks,
rebuilding manager selling a veteran).
"""

from __future__ import annotations

import json
import logging
from datetime import date
from sqlite3 import Connection

from app.pick_conversion import PickResolutionContext, compute_pick_conversion
from app.profiles.engine import (
    _ensure_graded,
    _get_manager_trades,
    classify_posture,
    compute_differential_stats,
    compute_position_biases,
    compute_positional_needs,
    compute_posture_patterns,
    get_league_family_ids,
)

logger = logging.getLogger(__name__)

DYNASTY_POSITIONS = ["QB", "RB", "WR", "TE"]
VETERAN_AGE = 27.0

# Acquisition score weights
W_SURPLUS = 0.35
W_SELLER = 0.25
W_WILLING = 0.20
W_PAYMENT = 0.20


def _age_now(birth_date_str: str | None) -> float | None:
    if not birth_date_str:
        return None
    try:
        bd = date.fromisoformat(birth_date_str)
        return round((date.today() - bd).days / 365.25, 1)
    except (ValueError, TypeError):
        return None


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


# ---------------------------------------------------------------------------
# Roster detail
# ---------------------------------------------------------------------------

def _position_roster(
    conn: Connection,
    league_id: str,
    user_id: str,
    position: str,
    fmt: str,
    snap_date: str | None,
) -> list[dict]:
    """A manager's players at one position, sorted by current value desc."""
    if snap_date is None:
        return []
    rows = conn.execute(
        """
        SELECT rp.player_id, pl.full_name, pl.birth_date, pl.team,
               COALESCE(vs.value, 0) as value
        FROM roster_players rp
        JOIN players pl ON pl.sleeper_id = rp.player_id
        LEFT JOIN value_snapshots vs
               ON vs.player_id = rp.player_id
              AND vs.source = 'rosteraudit'
              AND vs.format = ?
              AND vs.snapshot_date = ?
        WHERE rp.league_id = ? AND rp.user_id = ? AND pl.position = ?
        ORDER BY value DESC
        """,
        (fmt, snap_date, league_id, user_id, position),
    ).fetchall()
    return [
        {
            "player_id": r["player_id"],
            "name": r["full_name"],
            "team": r["team"],
            "age": _age_now(r["birth_date"]),
            "value": r["value"],
            "rank": i + 1,
        }
        for i, r in enumerate(rows)
    ]


def _flag_availability(
    players: list[dict], their_posture: str, surplus_pct: float
) -> None:
    """
    Annotate each player with likely_available + a reason.

    Heuristics — not truth, just negotiation starting points:
      - Rebuilders will move veterans (27+) at any roster slot.
      - Anyone will move depth (rank 3+ at the position).
      - A manager with real positional surplus will move their #2.
    """
    for p in players:
        reasons = []
        age = p.get("age")
        if their_posture == "rebuild" and age is not None and age >= VETERAN_AGE:
            reasons.append("veteran on a rebuilding team")
        if p["rank"] >= 3:
            reasons.append(f"depth piece (their {position_ordinal(p['rank'])} at the position)")
        elif p["rank"] == 2 and surplus_pct > 0.10:
            reasons.append("second option at a surplus position")
        p["likely_available"] = bool(reasons)
        p["availability_reason"] = "; ".join(reasons) if reasons else None


def position_ordinal(rank: int) -> str:
    return {1: "top option", 2: "2nd option", 3: "3rd option"}.get(rank, f"{rank}th option")


# ---------------------------------------------------------------------------
# My tradable assets
# ---------------------------------------------------------------------------

def _latest_pick_snap_date(conn: Connection, fmt: str) -> str | None:
    row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM pick_value_snapshots WHERE source='rosteraudit' AND format=?",
        (fmt,),
    ).fetchone()
    return row["d"] if row else None


def _pick_value_now(conn: Connection, fmt: str, season: int, rnd: int, snap: str | None) -> int:
    if snap is None:
        return 0
    row = conn.execute(
        "SELECT mid_value FROM pick_value_snapshots WHERE season=? AND round=? "
        "AND source='rosteraudit' AND format=? AND snapshot_date=?",
        (season, rnd, fmt, snap),
    ).fetchone()
    return row["mid_value"] if row else 0


def _my_pick_inventory(
    conn: Connection,
    current_league_id: str,
    my_roster_id: int | None,
    fmt: str,
    last_drafted_season: int,
) -> list[dict]:
    """
    Future picks I currently hold: my own picks not traded away, plus picks
    acquired from other rosters (from the traded_picks endpoint cache).
    """
    if my_roster_id is None:
        return []

    pick_snap = _latest_pick_snap_date(conn, fmt)

    # How many rounds does this league's rookie draft run?
    n_rounds_row = conn.execute(
        "SELECT MAX(pick_round) as r FROM trade_assets ta JOIN trades t ON t.id=ta.trade_id "
        "WHERE t.league_id = ? AND ta.asset_type='pick'",
        (current_league_id,),
    ).fetchone()
    n_rounds = min(n_rounds_row["r"] or 4, 5)

    future_seasons = [last_drafted_season + i for i in (1, 2, 3)]

    # Start with all my own future picks
    holdings: dict[tuple[int, int, int], str] = {}  # (season, round, orig_roster) → label
    for season in future_seasons:
        for rnd in range(1, n_rounds + 1):
            holdings[(season, rnd, my_roster_id)] = "own"

    cache_row = conn.execute(
        "SELECT response_json FROM sleeper_cache WHERE url = ?",
        (f"https://api.sleeper.app/v1/league/{current_league_id}/traded_picks",),
    ).fetchone()
    if cache_row:
        for p in json.loads(cache_row["response_json"]):
            try:
                season = int(p.get("season", 0))
            except (TypeError, ValueError):
                continue
            if season not in future_seasons:
                continue
            rnd = p.get("round")
            orig = p.get("roster_id")
            owner = p.get("owner_id")
            if rnd is None or orig is None or owner is None:
                continue
            key = (season, rnd, orig)
            if orig == my_roster_id and owner != my_roster_id:
                holdings.pop(key, None)          # my pick, traded away
            elif owner == my_roster_id and orig != my_roster_id:
                holdings[key] = "acquired"        # someone else's pick, now mine

    inventory = []
    for (season, rnd, orig), via in sorted(holdings.items()):
        value = _pick_value_now(conn, fmt, season, rnd, pick_snap)
        if value <= 0:
            continue
        inventory.append({
            "season": season,
            "round": rnd,
            "label": f"{season} R{rnd}" + (" (acquired)" if via == "acquired" else ""),
            "value": value,
            "via": via,
        })
    inventory.sort(key=lambda x: x["value"], reverse=True)
    return inventory


def _my_offerable_players(
    conn: Connection,
    current_league_id: str,
    my_user_id: str,
    target_position: str,
    needs: dict,
    fmt: str,
    snap_date: str | None,
) -> list[dict]:
    """
    Players from my surplus positions I could realistically offer: everything
    below my top option at each surplus position (never offer the piece that
    makes the position a strength).
    """
    offerable = []
    for pos in DYNASTY_POSITIONS:
        if pos == target_position:
            continue
        if needs.get(pos, {}).get("need_score", 0.0) >= -0.05:
            continue  # not a surplus position
        roster = _position_roster(conn, current_league_id, my_user_id, pos, fmt, snap_date)
        for p in roster:
            if p["rank"] >= 2 and p["value"] > 0:
                p["position"] = pos
                offerable.append(p)
    offerable.sort(key=lambda x: x["value"], reverse=True)
    return offerable


# ---------------------------------------------------------------------------
# Package suggestions
# ---------------------------------------------------------------------------

def _price_discount(
    shed_bias: float | None,
    picks_are_cheap: bool,
    their_posture: str,
    player_age: float | None,
    paying_with_picks: bool,
) -> tuple[float, list[str]]:
    """Return (discount multiplier, reasons). 1.0 = pay full sticker."""
    discount = 1.0
    reasons: list[str] = []
    if shed_bias is not None and shed_bias < -0.05:
        cut = min(0.15, abs(shed_bias))
        discount -= cut
        reasons.append(f"they've historically undersold this position ({round(shed_bias * 100)}% avg when shedding)")
    if paying_with_picks and picks_are_cheap:
        discount -= 0.10
        reasons.append("picks they accept tend to bust, so they price draft capital cheap")
    if their_posture == "rebuild" and player_age is not None and player_age >= VETERAN_AGE:
        discount -= 0.05
        reasons.append("rebuilding managers move veterans at a discount")
    return max(0.70, discount), reasons


def _pick_combo(picks: list[dict], lo: float, hi: float, max_picks: int = 3) -> list[dict] | None:
    """Greedy: largest picks first until the total lands inside [lo, hi]."""
    combo: list[dict] = []
    total = 0
    for p in picks:
        if len(combo) >= max_picks:
            break
        if total + p["value"] <= hi:
            combo.append(p)
            total += p["value"]
            if total >= lo:
                return combo
    return combo if combo and total >= lo else None


def _build_packages(
    target_player: dict,
    my_picks: list[dict],
    my_players: list[dict],
    shed_bias: float | None,
    picks_are_cheap: bool,
    their_posture: str,
    they_need_picks: bool,
) -> list[dict]:
    """Up to three package shapes for one target player."""
    packages = []
    base = target_player["value"]
    if base <= 0:
        return []

    def add(kind: str, items: list[dict], paying_with_picks: bool, note: str | None = None):
        discount, reasons = _price_discount(
            shed_bias, picks_are_cheap, their_posture, target_player.get("age"), paying_with_picks
        )
        adjusted = round(base * discount)
        total = sum(i["value"] for i in items)
        rationale_bits = list(reasons)
        if note:
            rationale_bits.insert(0, note)
        packages.append({
            "kind": kind,
            "items": [
                {"label": i.get("label") or i.get("name"), "value": i["value"]}
                for i in items
            ],
            "package_value": total,
            "sticker_value": base,
            "adjusted_target_value": adjusted,
            "rationale": (
                " · ".join(rationale_bits)
                if rationale_bits
                else "straight value-for-value swap"
            ),
        })

    # Shape 1 — picks only (strongest when they need picks or price them cheap)
    discount_est, _ = _price_discount(shed_bias, picks_are_cheap, their_posture, target_player.get("age"), True)
    adj = base * discount_est
    combo = _pick_combo(my_picks, adj * 0.90, adj * 1.15)
    if combo:
        note = "they're short on draft capital" if they_need_picks else None
        add("picks_only", combo, paying_with_picks=True, note=note)

    # Shape 2 — one player + one pick
    discount_est, _ = _price_discount(shed_bias, picks_are_cheap, their_posture, target_player.get("age"), True)
    adj = base * discount_est
    best_combo = None
    for pl in my_players[:6]:
        if pl["value"] >= adj * 1.05:
            continue
        gap_lo, gap_hi = adj * 0.90 - pl["value"], adj * 1.15 - pl["value"]
        fillers = [p for p in my_picks if gap_lo <= p["value"] <= gap_hi]
        if pl["value"] >= adj * 0.90 * 0.55 and fillers:
            best_combo = [pl, min(fillers, key=lambda f: f["value"])]
            break
    if best_combo:
        add("player_plus_pick", best_combo, paying_with_picks=True)

    # Shape 3 — straight player swap from my surplus
    discount_est, _ = _price_discount(shed_bias, picks_are_cheap, their_posture, target_player.get("age"), False)
    adj = base * discount_est
    swap = next((pl for pl in my_players if adj * 0.85 <= pl["value"] <= adj * 1.15), None)
    if swap:
        add("player_swap", [swap], paying_with_picks=False,
            note=f"moves your surplus {swap.get('position', '')} for your {target_player.get('name', 'target')} need".strip())

    return packages[:3]


# ---------------------------------------------------------------------------
# Main report
# ---------------------------------------------------------------------------

def acquisition_report(
    conn: Connection,
    my_user_id: str,
    league_id: str,
    position: str,
) -> dict:
    """
    Rank every other manager in the league as a source for `position`,
    with player-level detail and suggested packages.
    """
    position = position.upper()
    if position not in DYNASTY_POSITIONS:
        raise ValueError(f"position must be one of {DYNASTY_POSITIONS}")

    family_ids = get_league_family_ids(conn, league_id)
    _ensure_graded(conn, family_ids)

    needs_data = compute_positional_needs(conn, my_user_id, league_id)
    fmt = needs_data["format_key"]
    snap_date = needs_data["snapshot_date"]
    league_avg = needs_data["league_avg"]
    all_manager_values = needs_data["all_managers"]
    pick_capital = needs_data.get("pick_capital", {})

    # Current league = highest season in the family
    ph = ",".join("?" * len(family_ids))
    current_league_row = conn.execute(
        f"SELECT id FROM leagues WHERE id IN ({ph}) ORDER BY season DESC LIMIT 1",
        family_ids,
    ).fetchone()
    current_league_id = current_league_row["id"] if current_league_row else league_id

    pick_ctx = PickResolutionContext(conn, league_id)

    my_roster_row = conn.execute(
        "SELECT roster_id FROM league_managers WHERE league_id = ? AND user_id = ?",
        (current_league_id, my_user_id),
    ).fetchone()
    my_roster_id = my_roster_row["roster_id"] if my_roster_row else None

    my_picks = _my_pick_inventory(
        conn, current_league_id, my_roster_id, fmt, pick_ctx.last_drafted_season
    )
    my_players = _my_offerable_players(
        conn, current_league_id, my_user_id, position, needs_data["needs"], fmt, snap_date
    )
    my_pick_value_total = sum(p["value"] for p in my_picks)

    avg_at_pos = league_avg.get(position, 0) or 0

    # Posture overrides for the family
    override_rows = conn.execute(
        f"SELECT user_id, posture FROM user_posture_overrides WHERE league_id IN ({ph})",
        family_ids,
    ).fetchall()
    posture_overrides = {r["user_id"]: r["posture"] for r in override_rows}

    other_managers = conn.execute(
        """
        SELECT DISTINCT lm.user_id, m.display_name, m.username
        FROM league_managers lm
        LEFT JOIN managers m ON m.user_id = lm.user_id
        WHERE lm.league_id = ? AND lm.user_id != ?
        """,
        (current_league_id, my_user_id),
    ).fetchall()

    targets = []
    for row in other_managers:
        uid = row["user_id"]
        name = row["display_name"] or row["username"] or uid

        their_val = all_manager_values.get(uid, {}).get(position, 0)
        surplus_pct = (their_val - avg_at_pos) / avg_at_pos if avg_at_pos > 0 else 0.0

        trades = _get_manager_trades(conn, uid, family_ids)
        diff_stats = compute_differential_stats(trades) if trades else None
        pos_biases = compute_position_biases(trades) if trades else {}
        their_posture = posture_overrides.get(uid) or (
            classify_posture(compute_posture_patterns(trades)) if trades else "middling"
        )

        bias_at_pos = pos_biases.get(position, {})
        shed = bias_at_pos.get("shedding", {})
        shed_bias = shed.get("avg_differential")
        shed_count = shed.get("count", 0)

        conv = compute_pick_conversion(conn, uid, league_id, ctx=pick_ctx)
        acq_ratio = conv["acquired"]["median_return_ratio"]
        picks_are_cheap = (
            conv["acquired"]["resolved"] >= 3
            and acq_ratio is not None
            and acq_ratio < 0.8
        )
        their_pick_score = pick_capital.get(uid, {}).get("pick_capital_score", 0.0)
        they_need_picks = their_pick_score < -0.07

        # ── Scores ─────────────────────────────────────────────────────
        surplus_score = _clamp(surplus_pct / 0.40)

        avg_diff = (diff_stats or {}).get("avg_decision_differential") or 0.0
        seller_score = _clamp(
            0.5
            + (-(shed_bias or 0.0)) * 2.0      # undersells the position
            + (-avg_diff) * 1.0                # generally loses trades
        )

        willingness = {"rebuild": 1.0, "contend": 0.25, "middling": 0.6}[their_posture]
        if surplus_pct > 0.15:
            willingness = max(willingness, 0.55)  # even contenders sell surplus depth
        willingness_score = willingness

        payment_score = 0.3
        if picks_are_cheap and my_pick_value_total > 0:
            payment_score = max(payment_score, 0.9)
        if they_need_picks and my_pick_value_total > 0:
            payment_score = max(payment_score, 0.8)
        if my_players:
            payment_score = max(payment_score, 0.5)

        acquisition_score = round(
            surplus_score * W_SURPLUS
            + seller_score * W_SELLER
            + willingness_score * W_WILLING
            + payment_score * W_PAYMENT,
            3,
        )

        # ── Roster + packages ──────────────────────────────────────────
        players = _position_roster(conn, current_league_id, uid, position, fmt, snap_date)
        _flag_availability(players, their_posture, surplus_pct)

        suggestions = []
        for p in [pl for pl in players if pl["likely_available"]][:2] or players[1:2]:
            pkgs = _build_packages(
                p, my_picks, my_players,
                shed_bias if shed_count >= 2 else None,
                picks_are_cheap, their_posture, they_need_picks,
            )
            if pkgs:
                suggestions.append({"player": p, "packages": pkgs})

        # ── Summary line ───────────────────────────────────────────────
        bits = []
        if surplus_pct > 0.10:
            bits.append(f"{position} surplus (+{round(surplus_pct * 100)}% vs league avg)")
        elif surplus_pct < -0.10:
            bits.append(f"thin at {position} ({round(surplus_pct * 100)}% vs avg)")
        if shed_bias is not None and shed_count >= 2 and shed_bias < -0.05:
            bits.append(f"undersold {position}s before ({round(shed_bias * 100)}% avg over {shed_count} trades)")
        if conv["tendency"]:
            bits.append(conv["tendency"])
        elif they_need_picks:
            bits.append("short on draft capital — picks talk")
        posture_word = {"rebuild": "Rebuilding", "contend": "Contending", "middling": "Middling"}[their_posture]
        summary = f"{posture_word}. " + (" ".join(s.rstrip('.') + "." for s in bits) if bits else "No strong signals — a fair-market negotiation.")

        targets.append({
            "user_id": uid,
            "manager_name": name,
            "their_posture": their_posture,
            "acquisition_score": acquisition_score,
            "scores": {
                "surplus": round(surplus_score, 3),
                "seller": round(seller_score, 3),
                "willingness": round(willingness_score, 3),
                "payment": round(payment_score, 3),
            },
            "position_value": their_val,
            "surplus_pct": round(surplus_pct, 3),
            "shed_bias": shed_bias,
            "shed_count": shed_count,
            "avg_decision_differential": (diff_stats or {}).get("avg_decision_differential"),
            "total_trades": (diff_stats or {}).get("total_trades", 0),
            "pick_conversion": conv,
            "pick_capital_score": round(their_pick_score, 3),
            "players": players,
            "suggestions": suggestions,
            "summary": summary,
        })

    targets.sort(key=lambda t: t["acquisition_score"], reverse=True)

    league_row = conn.execute("SELECT name FROM leagues WHERE id = ?", (league_id,)).fetchone()
    my_val = all_manager_values.get(my_user_id, {}).get(position, 0)

    return {
        "league_id": league_id,
        "league_name": league_row["name"] if league_row else league_id,
        "position": position,
        "format_key": fmt,
        "snapshot_date": snap_date,
        "my_context": {
            "my_value": my_val,
            "league_avg": avg_at_pos,
            "surplus_positions": [
                p for p in DYNASTY_POSITIONS
                if needs_data["needs"].get(p, {}).get("need_score", 0) < -0.05
            ],
            "pick_inventory": my_picks,
            "offerable_players": my_players[:8],
        },
        "targets": targets,
    }
