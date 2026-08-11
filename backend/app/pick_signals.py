"""
Pick receptivity signals — the three-layer model for "will this manager
trade a player for picks, and what does it cost me to pay that way?"

  1. NEED      — are they short on future draft capital? (inventory-based,
                 with per-year concentration: three 2027 firsts means low
                 marginal interest in a fourth)
  2. APPETITE  — do they actually do pick deals? Share of their historical
                 trades where they received at least one pick, recency-
                 weighted. A players-only trader won't take picks no matter
                 how pick-poor they are.
  3. DRAFT SKILL — do the players they select outperform their draft slot?
                 Measured on every selection they've made in ROOKIE drafts
                 (startup drafts excluded — everyone picks vets there).
                 STRICTLY display-only: never touches price or scores.
                 It's a risk note for the user: sending picks to a cold
                 drafter is low-regret; sending them to a sharp one arms
                 a rival. Directional — the sample grows every season.

Also computes the preferred pick HORIZON (how many years out the picks
they've accepted tend to be) so offers match their window.
"""

from __future__ import annotations

import logging
import statistics
from sqlite3 import Connection

from app.pick_conversion import PickResolutionContext

logger = logging.getLogger(__name__)

# Rookie drafts only — startup drafts run 20+ rounds, rookies run ≤6.
MAX_ROOKIE_ROUNDS = 6

# Recency decay by seasons-ago, relative to the manager's most recent season.
SEASON_DECAY = {0: 1.0, 1: 0.75, 2: 0.5}
SEASON_DECAY_FLOOR = 0.3

# Draft-skill labeling
SKILL_MIN_SAMPLE = 8
SKILL_SHARP = 1.3   # median ratio ≥ → "sharp"
SKILL_COLD = 0.6    # median ratio ≤ → "cold"

# Appetite gate: below this weighted share, lead with player-based offers.
LOW_APPETITE = 0.20

# Concentration: holding this many picks in one draft year saturates interest.
CONCENTRATION_LIMIT = 3


def _season_weight(season: int | None, current: int) -> float:
    if season is None:
        return SEASON_DECAY_FLOOR
    return SEASON_DECAY.get(current - season, SEASON_DECAY_FLOOR)


# ---------------------------------------------------------------------------
# Layer 2 — appetite
# ---------------------------------------------------------------------------

def compute_pick_appetite(conn: Connection, user_id: str, family_ids: list[str]) -> dict:
    """
    Recency-weighted share of this manager's trades in which they RECEIVED
    at least one pick. Also the raw counts for display.
    """
    ph = ",".join("?" * len(family_ids))
    rows = conn.execute(
        f"""
        SELECT t.season,
               EXISTS(
                   SELECT 1 FROM trade_assets ta
                   WHERE ta.trade_id = t.id
                     AND ta.to_roster_id = ts.roster_id
                     AND ta.asset_type = 'pick'
               ) as got_pick
        FROM trade_sides ts
        JOIN trades t ON t.id = ts.trade_id
        WHERE ts.user_id = ? AND t.league_id IN ({ph})
        """,
        (user_id, *family_ids),
    ).fetchall()

    if not rows:
        return {"share": None, "pick_trades": 0, "total_trades": 0}

    current = max((r["season"] or 0) for r in rows)
    wsum = 0.0
    wgot = 0.0
    got = 0
    for r in rows:
        w = _season_weight(r["season"], current)
        wsum += w
        if r["got_pick"]:
            wgot += w
            got += 1

    return {
        "share": round(wgot / wsum, 3) if wsum > 0 else None,
        "pick_trades": got,
        "total_trades": len(rows),
    }


# ---------------------------------------------------------------------------
# Horizon — how far out are the picks they accept?
# ---------------------------------------------------------------------------

def compute_pick_horizon(conn: Connection, user_id: str, family_ids: list[str]) -> float | None:
    """
    Recency-weighted average years-out (pick season minus trade season) of
    picks this manager has received. None if they've never received a pick.
    """
    ph = ",".join("?" * len(family_ids))
    rows = conn.execute(
        f"""
        SELECT t.season as trade_season, ta.pick_season
        FROM trade_assets ta
        JOIN trades t ON t.id = ta.trade_id
        JOIN league_managers lm
            ON lm.league_id = t.league_id AND lm.roster_id = ta.to_roster_id
        WHERE lm.user_id = ? AND ta.asset_type = 'pick' AND t.league_id IN ({ph})
        """,
        (user_id, *family_ids),
    ).fetchall()

    pairs = [
        (r["pick_season"] - r["trade_season"], r["trade_season"])
        for r in rows
        if r["pick_season"] is not None and r["trade_season"] is not None
    ]
    if not pairs:
        return None
    current = max(s for _, s in pairs)
    wsum = sum(_season_weight(s, current) for _, s in pairs)
    if wsum == 0:
        return None
    return round(sum(y * _season_weight(s, current) for y, s in pairs) / wsum, 1)


# ---------------------------------------------------------------------------
# Layer 3 — draft skill (display-only)
# ---------------------------------------------------------------------------

def _slot_tercile(slot: int, n_slots: int) -> str:
    if n_slots <= 0:
        return "mid"
    third = n_slots / 3
    if slot <= third:
        return "early"
    if slot <= 2 * third:
        return "mid"
    return "late"


def _round_baselines(conn: Connection, fmt: str) -> dict[int, dict[str, int]]:
    """
    Expected value of a pick by (round, tercile), from the OLDEST snapshot
    (values before the class was seen keep the baseline honest-ish). One
    row per round; season differences are noise at this resolution.
    """
    oldest = conn.execute(
        "SELECT MIN(snapshot_date) as d FROM pick_value_snapshots WHERE source='rosteraudit' AND format=?",
        (fmt,),
    ).fetchone()
    if not oldest or not oldest["d"]:
        return {}
    rows = conn.execute(
        """
        SELECT round, early_value, mid_value, late_value
        FROM pick_value_snapshots
        WHERE source='rosteraudit' AND format=? AND snapshot_date=?
          AND season = (
              SELECT MIN(season) FROM pick_value_snapshots
              WHERE source='rosteraudit' AND format=? AND snapshot_date=?
          )
        """,
        (fmt, oldest["d"], fmt, oldest["d"]),
    ).fetchall()
    baselines: dict[int, dict[str, int]] = {}
    for r in rows:
        mid = r["mid_value"]
        baselines[r["round"]] = {
            "early": r["early_value"] or mid,
            "mid": mid,
            "late": r["late_value"] or mid,
        }
    return baselines


def compute_draft_skill(
    conn: Connection,
    user_id: str,
    ctx: PickResolutionContext,
) -> dict:
    """
    Rookie-draft selection quality: for every pick this manager made in a
    rookie draft, player value today ÷ slot-expected value. Median ratio.

    Display-only and directional — never feeds pricing or scoring.
    """
    baselines = _round_baselines(conn, ctx.fmt)

    ratios: list[float] = []
    seasons: set[int] = set()
    best: tuple[float, str, str] | None = None   # (ratio, player, label)
    worst: tuple[float, str, str] | None = None

    for season, info in ctx.drafts.items():
        picks = info["picks"]
        if not picks:
            continue
        max_round = max((p.get("round") or 0) for p in picks)
        if max_round > MAX_ROOKIE_ROUNDS:
            continue  # startup draft — everyone picks vets, says nothing about rookie eye

        for p in picks:
            picker = p.get("picked_by")
            if not picker:
                # Autopick — attribute via the roster that owned the slot
                picker = ctx.roster_user.get((info["league_id"], p.get("roster_id")))
            if picker != user_id:
                continue

            rnd = p.get("round")
            slot = p.get("draft_slot")
            player_id = p.get("player_id")
            if not rnd or not slot or not player_id:
                continue
            expected = baselines.get(rnd, {}).get(_slot_tercile(slot, info["n_slots"]))
            if not expected or expected <= 0:
                continue
            value_now = ctx.player_value_now(player_id)
            if value_now is None:
                continue

            ratio = value_now / expected
            ratios.append(ratio)
            seasons.add(season)

            prow = conn.execute(
                "SELECT full_name FROM players WHERE sleeper_id = ?", (player_id,)
            ).fetchone()
            pname = (prow["full_name"] if prow else player_id) or player_id
            label = f"{season} R{rnd}"
            if best is None or ratio > best[0]:
                best = (ratio, pname, label)
            if worst is None or ratio < worst[0]:
                worst = (ratio, pname, label)

    n = len(ratios)
    median = round(statistics.median(ratios), 2) if ratios else None

    skill_label = None
    if n >= SKILL_MIN_SAMPLE and median is not None:
        if median >= SKILL_SHARP:
            skill_label = "sharp"
        elif median <= SKILL_COLD:
            skill_label = "cold"
        else:
            skill_label = "average"

    return {
        "n": n,
        "median_ratio": median,
        "label": skill_label,   # None when sample too small
        "seasons": sorted(seasons),
        "best": {"player": best[1], "pick": best[2], "ratio": round(best[0], 1)} if best else None,
        "worst": {"player": worst[1], "pick": worst[2], "ratio": round(worst[0], 1)} if worst else None,
    }


def draft_skill_note(skill: dict) -> str | None:
    """One-line risk framing for the user. Display-only."""
    if skill["label"] is None:
        if skill["n"] > 0:
            return f"Draft record too thin to judge ({skill['n']} rookie picks so far)."
        return None
    med = skill["median_ratio"]
    n = skill["n"]
    yrs = "–".join(str(s) for s in (skill["seasons"][:1] + skill["seasons"][-1:])) if skill["seasons"] else ""
    if skill["label"] == "cold":
        return (
            f"Cold drafter: their rookie picks return a median {med}x of slot value "
            f"({n} picks, {yrs}) — low regret sending them your picks."
        )
    if skill["label"] == "sharp":
        return (
            f"Sharp drafter: median {med}x of slot value ({n} picks, {yrs}) — "
            f"picks become weapons in their hands; trade them carefully."
        )
    return f"Average drafter (median {med}x of slot value, {n} picks, {yrs})."


# ---------------------------------------------------------------------------
# Layer 1 refinement — per-year holdings / concentration
# ---------------------------------------------------------------------------

def year_holdings(their_picks: list[dict]) -> dict[int, int]:
    """Count of future picks held per draft year."""
    counts: dict[int, int] = {}
    for p in their_picks:
        counts[p["season"]] = counts.get(p["season"], 0) + 1
    return counts


def concentrated_years(their_picks: list[dict]) -> list[int]:
    """Draft years where they already hoard picks — low marginal interest."""
    return sorted(
        s for s, c in year_holdings(their_picks).items() if c >= CONCENTRATION_LIMIT
    )


def prefer_picks_for_target(
    my_picks: list[dict],
    horizon: float | None,
    their_concentrated_years: list[int],
    current_season: int,
) -> list[dict]:
    """
    Reorder my pick inventory for offers to this specific manager: picks in
    draft years matching their accepted-pick horizon first, years they
    already hoard last; value-desc within each band.
    """
    def sort_key(p: dict) -> tuple:
        concentrated = p["season"] in their_concentrated_years
        if horizon is not None:
            distance = abs((p["season"] - current_season) - horizon)
        else:
            distance = 0
        return (concentrated, distance, -p["value"])

    return sorted(my_picks, key=sort_key)
