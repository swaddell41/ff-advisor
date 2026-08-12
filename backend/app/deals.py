"""
Live deal evaluation for the Trade Hub builder.

Given a counterparty and the assets on both sides of a working trade,
score the deal against that manager's DEMONSTRATED prices:

  - Assets coming to me are adjusted DOWN by their shedding bias at each
    player's position (they've sold WRs at -20% before) and the
    rebuilder-moving-a-veteran nudge.
  - Assets going to them are adjusted UP ("perceived value") by their
    acquiring bias at each position (they've paid +20% over market for RBs,
    so my RB buys more in their eyes).
  - Picks always count at sticker on both sides. Draft skill NEVER moves a
    number — it rides along as a display-only risk note, and a players-only
    trader gets an appetite warning when picks are on my side.

The verdict compares my side's perceived value to their side's adjusted
value — "would this manager, as they have actually behaved, take this?"
"""

from __future__ import annotations

import logging
from sqlite3 import Connection

from app.acquire import VETERAN_AGE, _age_now, _latest_pick_snap_date, _pick_value_now
from app.pick_conversion import PickResolutionContext
from app.pick_signals import (
    LOW_APPETITE,
    compute_draft_skill,
    compute_pick_appetite,
    draft_skill_note,
)
from app.profiles.engine import (
    _ensure_graded,
    _get_manager_trades,
    classify_posture,
    compute_age_biases,
    compute_position_biases,
    compute_posture_patterns,
    get_league_family_ids,
)

logger = logging.getLogger(__name__)

# Their-side discount cap (matches acquire's package pricing).
MAX_BIAS_ADJUST = 0.15
# An asset is "contested" when the two value sources disagree by at least
# this fraction of the larger value (and the stakes aren't trivial).
CONTESTED_SPREAD = 0.40
CONTESTED_MIN_VALUE = 250
# My-side perceived-value bump caps (matches sell's premium model, so the
# evaluator agrees with the asks the sell tool proposes).
MAX_ACQ_BUMP = 0.25
MAX_AGE_BUMP = 0.08
MAX_TOTAL_BUMP = 0.30
MIN_BIAS_SAMPLE = 2


def _age_bucket(age: float | None) -> str | None:
    if age is None:
        return None
    if age <= 23:
        return "young"
    if age <= 26:
        return "prime"
    return "veteran"


def _resolve_asset(
    conn: Connection,
    fmt: str,
    snap_date: str | None,
    pick_snap: str | None,
    ref: dict,
) -> dict | None:
    """Resolve an asset ref to {type, label, value, position?, age?, ref}."""
    if ref.get("type") == "player":
        row = conn.execute(
            """
            SELECT pl.sleeper_id, pl.full_name, pl.position, pl.birth_date,
                   COALESCE(vs.value, 0) as value
            FROM players pl
            LEFT JOIN value_snapshots vs
                   ON vs.player_id = pl.sleeper_id AND vs.source='rosteraudit'
                  AND vs.format = ? AND vs.snapshot_date = ?
            WHERE pl.sleeper_id = ?
            """,
            (fmt, snap_date, ref.get("player_id")),
        ).fetchone()
        if row is None:
            return None
        return {
            "type": "player",
            "label": row["full_name"],
            "position": row["position"],
            "age": _age_now(row["birth_date"]),
            "value": row["value"],
            "ref": {"type": "player", "player_id": row["sleeper_id"]},
        }
    if ref.get("type") == "pick":
        season = ref.get("season")
        rnd = ref.get("round")
        if season is None or rnd is None:
            return None
        return {
            "type": "pick",
            "label": f"{season} R{rnd}",
            "position": None,
            "age": None,
            "value": _pick_value_now(conn, fmt, season, rnd, pick_snap),
            "ref": {"type": "pick", "season": season, "round": rnd},
        }
    return None


def _market_snap_dates(conn: Connection, fmt: str) -> tuple[str | None, str | None]:
    p = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source='fantasycalc' AND format=?",
        (fmt,),
    ).fetchone()
    k = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM pick_value_snapshots WHERE source='fantasycalc' AND format=?",
        (fmt,),
    ).fetchone()
    return (p["d"] if p else None), (k["d"] if k else None)


def _market_value(
    conn: Connection, fmt: str, ref: dict,
    mkt_snap: str | None, mkt_pick_snap: str | None,
) -> int | None:
    """FantasyCalc value (normalized to our scale) for one asset ref."""
    if ref.get("type") == "player" and mkt_snap:
        row = conn.execute(
            "SELECT value FROM value_snapshots WHERE player_id=? AND source='fantasycalc' "
            "AND format=? AND snapshot_date=?",
            (ref.get("player_id"), fmt, mkt_snap),
        ).fetchone()
        return row["value"] if row else None
    if ref.get("type") == "pick" and mkt_pick_snap:
        row = conn.execute(
            "SELECT mid_value FROM pick_value_snapshots WHERE season=? AND round=? "
            "AND source='fantasycalc' AND format=? AND snapshot_date=?",
            (ref.get("season"), ref.get("round"), fmt, mkt_pick_snap),
        ).fetchone()
        return row["mid_value"] if row else None
    return None


def _is_contested(ours: int, market: int | None) -> bool:
    if market is None:
        return False
    hi = max(ours, market)
    if hi < CONTESTED_MIN_VALUE:
        return False
    return abs(market - ours) / hi >= CONTESTED_SPREAD


def _nearest_pick_label(conn: Connection, fmt: str, value: int, pick_snap: str | None) -> str | None:
    """Translate a value into 'roughly a 2027 R2' using our pick board."""
    if pick_snap is None or value <= 0:
        return None
    row = conn.execute(
        "SELECT season, round FROM pick_value_snapshots "
        "WHERE source='rosteraudit' AND format=? AND snapshot_date=? "
        "ORDER BY ABS(mid_value - ?) ASC LIMIT 1",
        (fmt, pick_snap, value),
    ).fetchone()
    return f"roughly a {row['season']} R{row['round']}" if row else None


def evaluate_deal(
    conn: Connection,
    my_user_id: str,
    league_id: str,
    counterparty_id: str,
    my_asset_refs: list[dict],
    their_asset_refs: list[dict],
) -> dict:
    family_ids = get_league_family_ids(conn, league_id)
    _ensure_graded(conn, family_ids)

    league_row = conn.execute(
        "SELECT format_key FROM leagues WHERE id = ?", (league_id,)
    ).fetchone()
    fmt = (league_row["format_key"] if league_row else None) or "sf_ppr"
    snap_row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source='rosteraudit' AND format=?",
        (fmt,),
    ).fetchone()
    snap_date = snap_row["d"] if snap_row else None
    pick_snap = _latest_pick_snap_date(conn, fmt)
    mkt_snap, mkt_pick_snap = _market_snap_dates(conn, fmt)

    mrow = conn.execute(
        "SELECT display_name, username FROM managers WHERE user_id = ?", (counterparty_id,)
    ).fetchone()
    counterparty_name = (mrow["display_name"] or mrow["username"]) if mrow else counterparty_id

    trades = _get_manager_trades(conn, counterparty_id, family_ids)
    pos_biases = compute_position_biases(trades) if trades else {}
    age_biases = compute_age_biases(trades) if trades else {}
    override = conn.execute(
        f"SELECT posture FROM user_posture_overrides WHERE user_id = ? "
        f"AND league_id IN ({','.join('?' * len(family_ids))})",
        (counterparty_id, *family_ids),
    ).fetchone()
    their_posture = (override["posture"] if override else None) or (
        classify_posture(compute_posture_patterns(trades)) if trades else "middling"
    )

    appetite = compute_pick_appetite(conn, counterparty_id, family_ids)
    pick_ctx = PickResolutionContext(conn, league_id)
    skill = compute_draft_skill(conn, counterparty_id, pick_ctx)

    notes: list[str] = []

    def _bias(pos: str | None, side: str) -> tuple[float | None, int]:
        if pos is None:
            return None, 0
        b = pos_biases.get(pos, {}).get(side, {})
        return b.get("avg_differential"), b.get("count", 0)

    # ── Their side: what they'd give up ────────────────────────────────
    their_side = []
    their_raw = 0
    their_adjusted = 0
    their_market = 0
    for ref in their_asset_refs:
        a = _resolve_asset(conn, fmt, snap_date, pick_snap, ref)
        if a is None:
            continue
        adjusted = a["value"]
        note = None
        if a["type"] == "player":
            shed_bias, n = _bias(a["position"], "shedding")
            cut = 0.0
            if shed_bias is not None and n >= MIN_BIAS_SAMPLE and shed_bias < -0.05:
                cut += min(MAX_BIAS_ADJUST, abs(shed_bias))
                note = f"they've undersold {a['position']}s ({round(shed_bias * 100)}% avg, {n} trades)"
            if their_posture == "rebuild" and a["age"] is not None and a["age"] >= VETERAN_AGE:
                cut += 0.05
                note = (note + "; " if note else "") + "rebuilder moving a veteran"
            adjusted = round(a["value"] * (1 - min(MAX_BIAS_ADJUST + 0.05, cut)))
        market = _market_value(conn, fmt, a["ref"], mkt_snap, mkt_pick_snap)
        their_side.append({
            **a, "adjusted_value": adjusted, "note": note,
            "market_value": market,
            "contested": _is_contested(a["value"], market),
        })
        their_raw += a["value"]
        their_adjusted += adjusted
        their_market += market if market is not None else a["value"]

    # ── My side: what I'd send, valued through their eyes ──────────────
    my_side = []
    my_raw = 0
    my_perceived = 0
    my_market = 0
    sending_picks_value = 0
    for ref in my_asset_refs:
        a = _resolve_asset(conn, fmt, snap_date, pick_snap, ref)
        if a is None:
            continue
        perceived = a["value"]
        note = None
        if a["type"] == "player":
            bump = 0.0
            note_bits = []
            acq_bias, n = _bias(a["position"], "acquiring")
            if acq_bias is not None and n >= MIN_BIAS_SAMPLE and acq_bias < -0.05:
                bump += min(MAX_ACQ_BUMP, abs(acq_bias))
                note_bits.append(
                    f"they've overpaid for {a['position']}s ({round(acq_bias * 100)}% avg, {n} buys)"
                )
            bucket = _age_bucket(a["age"])
            if bucket:
                aacq = age_biases.get(bucket, {}).get("acquiring", {})
                age_bias = aacq.get("avg_differential")
                if age_bias is not None and aacq.get("count", 0) >= MIN_BIAS_SAMPLE and age_bias < -0.06:
                    bump += min(MAX_AGE_BUMP, abs(age_bias) / 2)
                    note_bits.append(f"they overpay for {bucket} players ({round(age_bias * 100)}% avg)")
            if bump > 0:
                perceived = round(a["value"] * (1 + min(MAX_TOTAL_BUMP, bump)))
                note = " · ".join(note_bits) + f" — your {a['position']} counts extra here"
        else:
            sending_picks_value += a["value"]
        market = _market_value(conn, fmt, a["ref"], mkt_snap, mkt_pick_snap)
        my_side.append({
            **a, "perceived_value": perceived, "note": note,
            "market_value": market,
            "contested": _is_contested(a["value"], market),
        })
        my_raw += a["value"]
        my_perceived += perceived
        my_market += market if market is not None else a["value"]

    # ── Composition warnings (display-only, never adjust numbers) ──────
    if sending_picks_value > 0 and appetite["share"] is not None and appetite["share"] < LOW_APPETITE:
        notes.append(
            f"You're offering picks to a players-only trader (picks in just "
            f"{round(appetite['share'] * 100)}% of their trades) — expect resistance."
        )
    if sending_picks_value > 0:
        sn = draft_skill_note(skill)
        if sn:
            notes.append(sn)

    # ── Verdict ────────────────────────────────────────────────────────
    verdict = None
    ratio = None
    if their_adjusted > 0 and my_side:
        ratio = round(my_perceived / their_adjusted, 3)
        if ratio < 0.85:
            verdict = {
                "label": "light",
                "text": f"Likely rejected — you're {round((1 - ratio) * 100)}% short of their demonstrated price.",
            }
        elif ratio < 0.95:
            verdict = {
                "label": "slightly_light",
                "text": "Close but light — a small sweetener probably closes it.",
            }
        elif ratio <= 1.10:
            verdict = {"label": "fair", "text": "Right at their demonstrated price."}
        elif ratio <= 1.25:
            verdict = {
                "label": "rich",
                "text": f"You're {round((ratio - 1) * 100)}% over their price — try trimming your side.",
            }
        else:
            verdict = {
                "label": "overpay",
                "text": f"Heavy overpay ({round((ratio - 1) * 100)}% above their price) — pull something back.",
            }

    # ── Market view (FantasyCalc — prices from real completed trades) ──
    market_ratio = None
    market_verdict = None
    if their_market > 0 and my_side:
        market_ratio = round(my_market / their_market, 3)
        if market_ratio < 0.9:
            market_verdict = {
                "label": "market_win",
                "text": f"Market view: you get {round((1 / market_ratio - 1) * 100)}% more than you give at real-trade prices.",
            }
        elif market_ratio <= 1.1:
            market_verdict = {"label": "market_fair", "text": "Market view: even at real-trade prices."}
        else:
            market_verdict = {
                "label": "market_overpay",
                "text": f"Market view: you give {round((market_ratio - 1) * 100)}% more than you get at real-trade prices.",
            }

    # ── Belief framing: what you'd have to believe for this to be right ─
    beliefs: list[str] = []
    for a in their_side:
        if not a["contested"]:
            continue
        ours = a["value"]
        market = a["market_value"]
        # Value this asset would need for the deal to be even by our numbers,
        # holding everything else fixed (and its bias discount ratio).
        others_adj = their_adjusted - a["adjusted_value"]
        disc = (a["adjusted_value"] / ours) if ours > 0 else 1.0
        needed = max(0, round((my_perceived - others_adj) / max(disc, 0.01)))
        pick_cmp = _nearest_pick_label(conn, fmt, needed, pick_snap)
        if market is not None and market > ours:
            line = (
                f"This deal makes sense if you believe {a['label']} is worth at least "
                f"{needed:,}{f' ({pick_cmp})' if pick_cmp else ''}. Our model prices them at {ours:,} "
                f"— likely floor-pricing recent absence or production — while the trade market pays {market:,}"
                + (", already above that bar." if market >= needed else ", still short of that bar.")
            )
        else:
            line = (
                f"Careful: our model prices {a['label']} at {ours:,} but the market only pays "
                f"{market:,} — the deal needs them to be worth {needed:,} to break even, and the market disagrees."
            )
        beliefs.append(line)
    for a in my_side:
        if not a["contested"]:
            continue
        ours = a["value"]
        market = a["market_value"]
        if market is not None and market < ours:
            beliefs.append(
                f"Your cost may be lower than our verdict implies: our model prices {a['label']} at {ours:,} "
                f"but the market pays only {market:,} — if you side with the market, you're giving up less."
            )
        elif market is not None and market > ours:
            beliefs.append(
                f"Careful what you're giving: the market pays {market:,} for {a['label']} vs our {ours:,} — "
                f"you may be sending more real value than our verdict shows."
            )

    return {
        "league_id": league_id,
        "counterparty": {
            "user_id": counterparty_id,
            "name": counterparty_name,
            "posture": their_posture,
        },
        "my_side": my_side,
        "their_side": their_side,
        "totals": {
            "my_raw": my_raw,
            "my_perceived": my_perceived,
            "their_raw": their_raw,
            "their_adjusted": their_adjusted,
            "my_market": my_market,
            "their_market": their_market,
        },
        "ratio": ratio,
        "verdict": verdict,
        "market_ratio": market_ratio,
        "market_verdict": market_verdict,
        "beliefs": beliefs,
        "notes": notes,
        "receptivity": {
            "appetite_share": appetite["share"],
            "appetite_pick_trades": appetite["pick_trades"],
            "appetite_total_trades": appetite["total_trades"],
            "draft_skill": skill,
            "draft_skill_note": draft_skill_note(skill),
        },
    }
