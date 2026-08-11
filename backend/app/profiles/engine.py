"""
Manager profile aggregation engine.

Computes four analytical dimensions for each manager in a league:

1. DIFFERENTIAL STATS
   Total trades, average decision/outcome differential, best/worst single trade,
   win/loss/neutral counts. "Win" = decision differential pct > 3% (B+ or better).

2. POSITION BIASES
   For each position (QB, RB, WR, TE): average trade differential when this manager
   is *acquiring* vs *shedding* players of that position.
   Pattern: consistently negative differential when acquiring RBs → "overpays for RBs".

   Differential is attributed at the trade level (not per asset) — if I acquire 2 RBs
   in a trade, that trade's differential counts once toward "acquiring RBs".

3. AGE BIASES
   Same differential analysis, but buckets are player age at trade time:
     young     ≤ 23
     prime     24–26
     veteran   ≥ 27

4. POSTURE PATTERNS
   Without per-week roster history we can't compute exact posture (that requires
   record and full roster snapshot at each trade date). Instead we classify each
   trade by its *asset flow* type, which approximates the manager's intent:
     rebuild   — received more pick value than player value (buying future)
     contend   — received more player value than pick value (buying present)
     neutral   — balanced or player-for-player / pick-for-pick trade
   We then show differential stats broken down by posture type, revealing:
   "when you trade like you're rebuilding, do you get good value?"

   NOTE: True posture (roster age, record, future picks held) requires ingesting
   matchup data and maintaining per-week roster snapshots. This is deferred to Phase 4.

All functions accept a sqlite3 Connection and return plain dicts for easy JSON
serialisation by the API layer.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import date, datetime
from sqlite3 import Connection

logger = logging.getLogger(__name__)

# ── Grade cutoff for win/loss/neutral (mirrors engine.py) ──────────────────
WIN_PCT_THRESHOLD = 0.03    # pct > +3% → win (B+ or better)
LOSS_PCT_THRESHOLD = -0.03  # pct < -3% → loss (B- or worse)

# ── Age buckets ─────────────────────────────────────────────────────────────
AGE_BUCKETS = [
    ("young",   None, 23),   # ≤ 23
    ("prime",   24,   26),   # 24–26
    ("veteran", 27,   None), # ≥ 27
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).date()
    except (ValueError, TypeError):
        return None


def _age_at(birth_date_str: str | None, trade_date: date) -> float | None:
    """Return player age (in decimal years) at the time of the trade."""
    if not birth_date_str:
        return None
    try:
        bd = date.fromisoformat(birth_date_str)
        delta = trade_date - bd
        return delta.days / 365.25
    except (ValueError, TypeError):
        return None


def _age_bucket(age: float | None) -> str | None:
    if age is None:
        return None
    if age <= 23:
        return "young"
    if age <= 26:
        return "prime"
    return "veteran"


def _pct(differential: int, received: int, given: int) -> float:
    larger = max(received, given)
    if larger == 0:
        return 0.0
    return differential / larger


def _win_loss(pct: float) -> str:
    if pct > WIN_PCT_THRESHOLD:
        return "win"
    if pct < LOSS_PCT_THRESHOLD:
        return "loss"
    return "neutral"


def _avg(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _bias_dict(diffs: list[float]) -> dict:
    """Summary stats for a list of differentials."""
    if not diffs:
        return {"count": 0, "avg_differential": None, "wins": 0, "losses": 0, "neutrals": 0}
    wins = sum(1 for d in diffs if d > WIN_PCT_THRESHOLD)
    losses = sum(1 for d in diffs if d < LOSS_PCT_THRESHOLD)
    neutrals = len(diffs) - wins - losses
    return {
        "count": len(diffs),
        "avg_differential": round(_avg(diffs), 4),
        "wins": wins,
        "losses": losses,
        "neutrals": neutrals,
    }


# ---------------------------------------------------------------------------
# League family / cross-league helpers
# ---------------------------------------------------------------------------

def get_league_family_ids(conn: Connection, league_id: str) -> list[str]:
    """
    Return all league_ids that belong to the same franchise chain as league_id.

    Walks backward via previous_league_id to find the root, then walks forward
    to collect every season. Handles branching chains (unlikely but safe).
    """
    # Walk backward to root
    visited: set[str] = set()
    current: str | None = league_id
    while current and current not in visited:
        visited.add(current)
        row = conn.execute(
            "SELECT previous_league_id FROM leagues WHERE id = ?", (current,)
        ).fetchone()
        current = (row["previous_league_id"] or None) if row else None

    # BFS forward from every node we found (handles forks)
    queue = list(visited)
    while queue:
        lid = queue.pop(0)
        children = conn.execute(
            "SELECT id FROM leagues WHERE previous_league_id = ?", (lid,)
        ).fetchall()
        for c in children:
            cid = c["id"]
            if cid not in visited:
                visited.add(cid)
                queue.append(cid)

    return sorted(visited)


def get_all_manager_leagues(conn: Connection, user_id: str) -> list[str]:
    """Return every league_id this manager has ever appeared in."""
    rows = conn.execute(
        "SELECT league_id FROM league_managers WHERE user_id = ?", (user_id,)
    ).fetchall()
    return [r["league_id"] for r in rows]


def _resolve_league_ids(
    conn: Connection,
    user_id: str,
    anchor_league_id: str,
    scope: str,
) -> tuple[list[str], str]:
    """
    Resolve the list of league_ids to include in a profile, and a display label.

    scope:
      'season'  — only the anchor league_id (original behaviour)
      'family'  — all seasons of the same franchise (default)
      'all'     — every league this manager has ever played in
    """
    if scope == "season":
        return [anchor_league_id], "This season"
    if scope == "all":
        ids = get_all_manager_leagues(conn, user_id)
        return ids, "All leagues"
    # default: family
    ids = get_league_family_ids(conn, anchor_league_id)
    return ids, "All seasons"


# ---------------------------------------------------------------------------
# Step 1 — fetch manager's trades across one or more leagues
# ---------------------------------------------------------------------------

def _get_manager_trades(
    conn: Connection,
    user_id: str,
    league_ids: list[str],
) -> list[dict]:
    """
    Return all trades for a manager across one or more leagues, enriched with
    their grade and the assets they gave/received.
    """
    if not league_ids:
        return []
    placeholders = ",".join("?" * len(league_ids))
    rows = conn.execute(
        f"""
        SELECT t.id as trade_id,
               t.league_id,
               t.season, t.week, t.executed_at,
               ts.roster_id,
               tg_d.total_value_received as d_received,
               tg_d.total_value_given    as d_given,
               tg_d.differential        as d_diff,
               tg_d.letter_grade        as d_grade,
               tg_o.total_value_received as o_received,
               tg_o.total_value_given    as o_given,
               tg_o.differential        as o_diff,
               tg_o.letter_grade        as o_grade
        FROM trade_sides ts
        JOIN trades t ON t.id = ts.trade_id
        LEFT JOIN trade_grades tg_d
               ON tg_d.trade_id = ts.trade_id
              AND tg_d.side_roster_id = ts.roster_id
              AND tg_d.grade_type = 'decision'
        LEFT JOIN trade_grades tg_o
               ON tg_o.trade_id = ts.trade_id
              AND tg_o.side_roster_id = ts.roster_id
              AND tg_o.grade_type = 'outcome'
        WHERE ts.user_id = ? AND t.league_id IN ({placeholders})
        ORDER BY t.executed_at DESC
        """,
        (user_id, *league_ids),
    ).fetchall()

    trades = []
    for r in rows:
        rid = r["roster_id"]
        tid = r["trade_id"]

        # Assets received (to_roster_id = this manager)
        received = conn.execute(
            """
            SELECT ta.asset_type, ta.player_id, ta.pick_season, ta.pick_round,
                   p.position, p.birth_date
            FROM trade_assets ta
            LEFT JOIN players p ON p.sleeper_id = ta.player_id
            WHERE ta.trade_id = ? AND ta.to_roster_id = ?
            """,
            (tid, rid),
        ).fetchall()

        # Assets given (from_roster_id = this manager)
        given = conn.execute(
            """
            SELECT ta.asset_type, ta.player_id, ta.pick_season, ta.pick_round,
                   p.position, p.birth_date
            FROM trade_assets ta
            LEFT JOIN players p ON p.sleeper_id = ta.player_id
            WHERE ta.trade_id = ? AND ta.from_roster_id = ?
            """,
            (tid, rid),
        ).fetchall()

        trades.append({
            "trade_id": tid,
            "league_id": r["league_id"],
            "season": r["season"],
            "week": r["week"],
            "executed_at": r["executed_at"],
            "roster_id": rid,
            "d_received": r["d_received"] or 0,
            "d_given": r["d_given"] or 0,
            "d_diff": r["d_diff"] or 0,
            "d_grade": r["d_grade"],
            "o_received": r["o_received"] or 0,
            "o_given": r["o_given"] or 0,
            "o_diff": r["o_diff"] or 0,
            "o_grade": r["o_grade"],
            "assets_received": [dict(a) for a in received],
            "assets_given": [dict(a) for a in given],
        })

    return trades


# ---------------------------------------------------------------------------
# Step 2 — Differential stats
# ---------------------------------------------------------------------------

def compute_differential_stats(trades: list[dict]) -> dict:
    """
    Aggregate summary statistics across all of a manager's trades.

    Returns:
        total_trades, avg_decision_differential, avg_outcome_differential,
        best_decision_trade, worst_decision_trade, wins, losses, neutrals,
        win_rate (as decimal)
    """
    if not trades:
        return {
            "total_trades": 0,
            "avg_decision_differential": None,
            "avg_outcome_differential": None,
            "best_decision_trade": None,
            "worst_decision_trade": None,
            "wins": 0, "losses": 0, "neutrals": 0, "win_rate": None,
        }

    graded = [t for t in trades if t["d_grade"] is not None]

    d_pcts = [_pct(t["d_diff"], t["d_received"], t["d_given"]) for t in graded]
    o_pcts = [_pct(t["o_diff"], t["o_received"], t["o_given"]) for t in graded]

    wins = sum(1 for p in d_pcts if p > WIN_PCT_THRESHOLD)
    losses = sum(1 for p in d_pcts if p < LOSS_PCT_THRESHOLD)
    neutrals = len(d_pcts) - wins - losses

    best = max(graded, key=lambda t: t["d_diff"]) if graded else None
    worst = min(graded, key=lambda t: t["d_diff"]) if graded else None

    return {
        "total_trades": len(trades),
        "graded_trades": len(graded),
        "avg_decision_differential": round(_avg(d_pcts), 4) if d_pcts else None,
        "avg_outcome_differential": round(_avg(o_pcts), 4) if o_pcts else None,
        "best_decision_trade": {
            "trade_id": best["trade_id"],
            "differential": best["d_diff"],
            "letter_grade": best["d_grade"],
            "executed_at": best["executed_at"],
        } if best else None,
        "worst_decision_trade": {
            "trade_id": worst["trade_id"],
            "differential": worst["d_diff"],
            "letter_grade": worst["d_grade"],
            "executed_at": worst["executed_at"],
        } if worst else None,
        "wins": wins,
        "losses": losses,
        "neutrals": neutrals,
        "win_rate": round(wins / len(d_pcts), 4) if d_pcts else None,
    }


# ---------------------------------------------------------------------------
# Step 3 — Position biases
# ---------------------------------------------------------------------------

def compute_position_biases(trades: list[dict]) -> dict:
    """
    For each position (QB, RB, WR, TE), compute average trade differential
    when this manager is acquiring vs shedding players of that position.

    A trade counts toward "acquiring QB" if the manager received ≥1 QB.
    A trade counts toward "shedding QB" if the manager gave ≥1 QB.
    The differential used is the trade-level decision differential percentage.

    Example interpretation:
    - position_biases["RB"]["acquiring"]["avg_differential"] = -0.12
      → "When acquiring RBs, this manager gets 12% less than they give"
      → "Overpays for RBs"
    """
    POSITIONS = ["QB", "RB", "WR", "TE"]

    acquiring: dict[str, list[float]] = {p: [] for p in POSITIONS}
    shedding: dict[str, list[float]] = {p: [] for p in POSITIONS}

    for t in trades:
        if t["d_grade"] is None:
            continue
        d_pct = _pct(t["d_diff"], t["d_received"], t["d_given"])

        received_positions = {a["position"] for a in t["assets_received"] if a["asset_type"] == "player" and a["position"]}
        given_positions = {a["position"] for a in t["assets_given"] if a["asset_type"] == "player" and a["position"]}

        for pos in POSITIONS:
            if pos in received_positions:
                acquiring[pos].append(d_pct)
            if pos in given_positions:
                shedding[pos].append(d_pct)

    return {
        pos: {
            "acquiring": _bias_dict(acquiring[pos]),
            "shedding": _bias_dict(shedding[pos]),
        }
        for pos in POSITIONS
    }


# ---------------------------------------------------------------------------
# Step 4 — Age biases
# ---------------------------------------------------------------------------

def compute_age_biases(trades: list[dict]) -> dict:
    """
    For each age bucket (young ≤23, prime 24-26, veteran ≥27), compute
    average trade differential when acquiring vs shedding players in that bucket.

    Age is computed at the time of the trade (not current age).

    Example interpretation:
    - age_biases["veteran"]["acquiring"]["avg_differential"] = -0.18
      → "Consistently overpays when buying veterans"
    """
    acquiring: dict[str, list[float]] = {b[0]: [] for b in AGE_BUCKETS}
    shedding: dict[str, list[float]] = {b[0]: [] for b in AGE_BUCKETS}

    for t in trades:
        if t["d_grade"] is None:
            continue
        d_pct = _pct(t["d_diff"], t["d_received"], t["d_given"])
        trade_date = _parse_date(t["executed_at"]) or date.today()

        received_buckets = set()
        for a in t["assets_received"]:
            if a["asset_type"] != "player":
                continue
            age = _age_at(a.get("birth_date"), trade_date)
            bucket = _age_bucket(age)
            if bucket:
                received_buckets.add(bucket)

        given_buckets = set()
        for a in t["assets_given"]:
            if a["asset_type"] != "player":
                continue
            age = _age_at(a.get("birth_date"), trade_date)
            bucket = _age_bucket(age)
            if bucket:
                given_buckets.add(bucket)

        for bucket in received_buckets:
            acquiring[bucket].append(d_pct)
        for bucket in given_buckets:
            shedding[bucket].append(d_pct)

    return {
        bucket: {
            "label": label,
            "acquiring": _bias_dict(acquiring[bucket]),
            "shedding": _bias_dict(shedding[bucket]),
        }
        for bucket, label in [("young", "Young (≤23)"), ("prime", "Prime (24-26)"), ("veteran", "Veteran (27+)")]
    }


# ---------------------------------------------------------------------------
# Step 5 — Posture patterns
# ---------------------------------------------------------------------------

def compute_posture_patterns(trades: list[dict]) -> dict:
    """
    Classify each trade by asset-flow type (an approximation of posture intent)
    and compute differential stats per category.

    NOTE: True posture requires per-week roster snapshots and record data,
    which aren't available until Phase 4. This is a trade-flow approximation.

    Classification rules (applied per manager's side of the trade):
      rebuild  — received picks whose value > received players' value
                 (accumulating future assets, typical rebuild move)
      contend  — received players whose value > received picks' value
                 (acquiring proven talent, typical contend move)
      neutral  — balanced mix or no clear direction

    "Stuck" pattern: high veteran acquisition differential AND poor overall win rate.
    """
    rebuild_pcts: list[float] = []
    contend_pcts: list[float] = []
    neutral_pcts: list[float] = []

    for t in trades:
        if t["d_grade"] is None:
            continue
        d_pct = _pct(t["d_diff"], t["d_received"], t["d_given"])

        # Classify by what the manager is receiving
        received_picks = [a for a in t["assets_received"] if a["asset_type"] == "pick"]
        received_players = [a for a in t["assets_received"] if a["asset_type"] == "player"]

        has_picks = len(received_picks) > 0
        has_players = len(received_players) > 0

        if has_picks and not has_players:
            rebuild_pcts.append(d_pct)
        elif has_players and not has_picks:
            contend_pcts.append(d_pct)
        else:
            neutral_pcts.append(d_pct)

    graded = [t for t in trades if t["d_grade"] is not None]
    overall_win_rate = None
    if graded:
        wins = sum(1 for t in graded if _pct(t["d_diff"], t["d_received"], t["d_given"]) > WIN_PCT_THRESHOLD)
        overall_win_rate = wins / len(graded)

    # "Stuck" flag: manager tends to trade for veterans AND has poor win rate
    vet_acq = compute_age_biases(trades)["veteran"]["acquiring"]
    stuck_signal = (
        vet_acq["count"] >= 3
        and vet_acq["avg_differential"] is not None
        and vet_acq["avg_differential"] < -0.10
        and overall_win_rate is not None
        and overall_win_rate < 0.35
    )

    return {
        "rebuild": _bias_dict(rebuild_pcts),
        "contend": _bias_dict(contend_pcts),
        "neutral": _bias_dict(neutral_pcts),
        "stuck_signal": stuck_signal,
        "note": (
            "Posture is approximated from asset-flow type (picks received = rebuild, "
            "players received = contend). True posture requires per-week roster history "
            "which is available in Phase 4."
        ),
    }


# ---------------------------------------------------------------------------
# Full profile computation
# ---------------------------------------------------------------------------

def _ensure_graded(conn: Connection, league_ids: list[str]) -> None:
    """Trigger grade computation for any league in the list that has ungraded trades."""
    from app.grading.engine import grade_league
    from app.value_sources import RosterAuditValueSource
    source = RosterAuditValueSource(conn)
    for lid in league_ids:
        count = conn.execute(
            "SELECT COUNT(*) FROM trade_grades tg JOIN trades t ON t.id = tg.trade_id WHERE t.league_id = ?",
            (lid,),
        ).fetchone()[0]
        if count == 0:
            logger.info("Auto-grading league %s before profile computation", lid)
            grade_league(conn, lid, source)


def compute_profile(
    conn: Connection,
    user_id: str,
    league_id: str,
    scope: str = "family",
) -> dict | None:
    """
    Compute the full manager profile across one or more leagues.

    scope:
      'season'  — only this league_id / season
      'family'  — all seasons of the same franchise chain (default)
      'all'     — every league this manager has played in

    Returns None if the manager has no trades in scope.
    """
    league_ids, scope_label = _resolve_league_ids(conn, user_id, league_id, scope)
    _ensure_graded(conn, league_ids)

    trades = _get_manager_trades(conn, user_id, league_ids)
    if not trades:
        return None

    manager = conn.execute(
        "SELECT user_id, username, display_name FROM managers WHERE user_id = ?",
        (user_id,),
    ).fetchone()

    seasons_included = sorted({t["season"] for t in trades if t.get("season")})

    profile = {
        "user_id": user_id,
        "manager_name": (manager["display_name"] or manager["username"]) if manager else user_id,
        "anchor_league_id": league_id,
        "scope": scope,
        "scope_label": scope_label,
        "leagues_included": league_ids,
        "seasons_included": seasons_included,
        "differential_stats": compute_differential_stats(trades),
        "position_biases": compute_position_biases(trades),
        "age_biases": compute_age_biases(trades),
        "posture_patterns": compute_posture_patterns(trades),
    }

    return profile


def compute_league_profiles(
    conn: Connection,
    league_id: str,
    scope: str = "family",
) -> list[dict]:
    """
    Compute summary profiles for all managers in a league, using the given scope.

    Uses the union of managers across all included seasons so no one is missed.
    """
    league_ids, scope_label = _resolve_league_ids(conn, "ANY", league_id, scope)

    # Collect all unique managers across the included leagues
    placeholders = ",".join("?" * len(league_ids))
    managers = conn.execute(
        f"SELECT DISTINCT user_id FROM league_managers WHERE league_id IN ({placeholders})",
        league_ids,
    ).fetchall()

    _ensure_graded(conn, league_ids)

    summaries = []
    for m in managers:
        uid = m["user_id"]
        # For "all" scope we still need to resolve per-user since every manager's
        # all-leagues set may differ. Re-resolve for each user.
        if scope == "all":
            user_league_ids = get_all_manager_leagues(conn, uid)
        else:
            user_league_ids = league_ids

        trades = _get_manager_trades(conn, uid, user_league_ids)
        if not trades:
            continue

        manager = conn.execute(
            "SELECT display_name, username FROM managers WHERE user_id = ?", (uid,)
        ).fetchone()

        diff_stats = compute_differential_stats(trades)
        summaries.append({
            "user_id": uid,
            "manager_name": (manager["display_name"] or manager["username"]) if manager else uid,
            "total_trades": diff_stats["total_trades"],
            "graded_trades": diff_stats["graded_trades"],
            "avg_decision_differential": diff_stats["avg_decision_differential"],
            "wins": diff_stats["wins"],
            "losses": diff_stats["losses"],
            "neutrals": diff_stats["neutrals"],
            "win_rate": diff_stats["win_rate"],
            "best_grade": diff_stats["best_decision_trade"]["letter_grade"] if diff_stats["best_decision_trade"] else None,
            "worst_grade": diff_stats["worst_decision_trade"]["letter_grade"] if diff_stats["worst_decision_trade"] else None,
            "seasons_included": sorted({t["season"] for t in trades if t.get("season")}),
        })

    summaries.sort(key=lambda s: s["avg_decision_differential"] or 0, reverse=True)
    return summaries


# ---------------------------------------------------------------------------
# Positional needs
# ---------------------------------------------------------------------------

DYNASTY_POSITIONS = ["QB", "RB", "WR", "TE"]
CURRENT_YEAR = 2026   # First future season for pick capital counting


def _get_latest_snapshot_date(conn: Connection, fmt: str) -> str | None:
    """Return the most recent snapshot date available for a format key."""
    row = conn.execute(
        "SELECT MAX(snapshot_date) as d FROM value_snapshots WHERE source='rosteraudit' AND format=?",
        (fmt,),
    ).fetchone()
    return row["d"] if row else None


def compute_pick_capital(
    conn: Connection,
    league_id: str,
    snap_date: str | None,
    fmt: str,
) -> dict[str, dict]:
    """
    Compute draft capital metrics for every manager in the league.

    Two signals combined into a single normalised pick_capital_score per manager:

    1. Net historical pick VALUE flow (from trade_assets + pick_value_snapshots):
       Positive = manager has received more pick value than they've given away.
       Negative = manager has been spending pick capital.

    2. Net future pick COUNT differential (from sleeper_cache traded_picks):
       Counts future picks (season >= CURRENT_YEAR) where owner_id == their
       roster minus picks that originated from their slot now held by others.
       Positive = they've accumulated others' future picks.
       Negative = they've traded away their own future picks.

    Returns {user_id: {"net_pick_value": int, "net_future_picks": int,
                        "pick_capital_score": float}}
    where pick_capital_score > 0 means surplus capital, < 0 means needs picks.
    """
    import json as _json

    family_ids = get_league_family_ids(conn, league_id)

    # --- Signal 1: net historical pick value flow ---
    if not snap_date:
        pick_received: dict[str, int] = {}
        pick_given: dict[str, int] = {}
    else:
        ph = ",".join("?" * len(family_ids))
        # Picks received (to_roster_id = user's roster in that league)
        received_rows = conn.execute(
            f"""
            SELECT lm.user_id, COALESCE(SUM(pvs.mid_value), 0) as total
            FROM trade_assets ta
            JOIN trades t ON t.id = ta.trade_id
            JOIN league_managers lm
                ON lm.league_id = t.league_id
               AND lm.roster_id = ta.to_roster_id
            LEFT JOIN pick_value_snapshots pvs
                ON pvs.season = ta.pick_season
               AND pvs.round  = ta.pick_round
               AND pvs.source = 'rosteraudit'
               AND pvs.format = ?
               AND pvs.snapshot_date = ?
            WHERE ta.asset_type = 'pick' AND t.league_id IN ({ph})
            GROUP BY lm.user_id
            """,
            (fmt, snap_date, *family_ids),
        ).fetchall()
        pick_received = {r["user_id"]: r["total"] for r in received_rows}

        given_rows = conn.execute(
            f"""
            SELECT lm.user_id, COALESCE(SUM(pvs.mid_value), 0) as total
            FROM trade_assets ta
            JOIN trades t ON t.id = ta.trade_id
            JOIN league_managers lm
                ON lm.league_id = t.league_id
               AND lm.roster_id = ta.from_roster_id
            LEFT JOIN pick_value_snapshots pvs
                ON pvs.season = ta.pick_season
               AND pvs.round  = ta.pick_round
               AND pvs.source = 'rosteraudit'
               AND pvs.format = ?
               AND pvs.snapshot_date = ?
            WHERE ta.asset_type = 'pick' AND t.league_id IN ({ph})
            GROUP BY lm.user_id
            """,
            (fmt, snap_date, *family_ids),
        ).fetchall()
        pick_given = {r["user_id"]: r["total"] for r in given_rows}

    # --- Signal 2: net future pick count from traded_picks cache ---
    # Use the most recent league in the family
    current_league_row = conn.execute(
        f"SELECT id FROM leagues WHERE id IN ({','.join('?' * len(family_ids))}) ORDER BY season DESC LIMIT 1",
        family_ids,
    ).fetchone()
    current_league_id = current_league_row["id"] if current_league_row else league_id

    # roster_id → user_id for current league
    roster_map = {
        r["roster_id"]: r["user_id"]
        for r in conn.execute(
            "SELECT roster_id, user_id FROM league_managers WHERE league_id = ?",
            (current_league_id,),
        ).fetchall()
    }

    # Parse traded_picks from cache
    cache_url = f"https://api.sleeper.app/v1/league/{current_league_id}/traded_picks"
    cache_row = conn.execute(
        "SELECT response_json FROM sleeper_cache WHERE url = ?", (cache_url,)
    ).fetchone()

    acquired_future: dict[str, int] = {}   # picks from other teams I now hold
    given_away_future: dict[str, int] = {} # my picks now held by others

    if cache_row:
        for pick in _json.loads(cache_row["response_json"]):
            try:
                season = int(pick.get("season", 0))
            except (ValueError, TypeError):
                continue
            if season < CURRENT_YEAR:
                continue
            owner_id = pick.get("owner_id")      # current holder (roster_id)
            orig_id  = pick.get("roster_id")     # original owner (roster_id)
            if owner_id is None or orig_id is None:
                continue
            # Pick acquired from another team
            owner_uid = roster_map.get(owner_id)
            if owner_uid and owner_id != orig_id:
                acquired_future[owner_uid] = acquired_future.get(owner_uid, 0) + 1
            # Own pick now held by someone else
            orig_uid = roster_map.get(orig_id)
            if orig_uid and owner_id != orig_id:
                given_away_future[orig_uid] = given_away_future.get(orig_uid, 0) + 1

    # --- Combine signals per manager ---
    all_uids = set(pick_received) | set(pick_given) | set(acquired_future) | set(given_away_future) | set(roster_map.values())
    result: dict[str, dict] = {}

    for uid in all_uids:
        net_value = pick_received.get(uid, 0) - pick_given.get(uid, 0)
        net_picks  = acquired_future.get(uid, 0) - given_away_future.get(uid, 0)
        result[uid] = {
            "net_pick_value": net_value,
            "net_future_picks": net_picks,
        }

    # Normalise to a single pick_capital_score relative to league average
    if result:
        avg_value = sum(v["net_pick_value"]  for v in result.values()) / len(result)
        avg_picks  = sum(v["net_future_picks"] for v in result.values()) / len(result)
        value_range = max(1, max(abs(v["net_pick_value"]  - avg_value) for v in result.values()))
        picks_range = max(1, max(abs(v["net_future_picks"] - avg_picks)  for v in result.values()))
        for uid, data in result.items():
            norm_value = (data["net_pick_value"]  - avg_value) / value_range
            norm_picks  = (data["net_future_picks"] - avg_picks)  / picks_range
            # Blend: pick value history (70%) + current future count (30%)
            data["pick_capital_score"] = round(norm_value * 0.70 + norm_picks * 0.30, 3)
    else:
        for data in result.values():
            data["pick_capital_score"] = 0.0

    return result


def compute_positional_needs(
    conn: Connection,
    my_user_id: str,
    league_id: str,
) -> dict:
    """
    Compute positional value totals for every manager in the league and
    derive my needs/surplus profile relative to the league average.

    Returns:
    {
      "format_key": "sf_ppr",
      "snapshot_date": "2026-05-14",
      "my_values": {"QB": 12000, "RB": 25000, "WR": 30000, "TE": 8000},
      "league_avg": {"QB": 10000, "RB": 22000, "WR": 28000, "TE": 9000},
      "needs": {
          "QB": {"my_value": 12000, "league_avg": 10000, "need_score": -0.20, "label": "surplus"},
          "RB": {"my_value": 25000, "league_avg": 22000, "need_score": -0.14, "label": "surplus"},
          "WR": {"my_value": 30000, "league_avg": 28000, "need_score": -0.07, "label": "slight surplus"},
          "TE": {"my_value": 8000,  "league_avg": 9000,  "need_score":  0.11, "label": "need"},
      },
      "all_managers": {user_id: {"QB": ..., "RB": ..., "WR": ..., "TE": ...}, ...}
    }

    need_score > 0 → below average → need
    need_score < 0 → above average → surplus
    """
    # Determine format key for this league
    league_row = conn.execute(
        "SELECT format_key FROM leagues WHERE id = ?", (league_id,)
    ).fetchone()
    fmt = (league_row["format_key"] if league_row else None) or "sf_ppr"

    # Get the latest snapshot date for this format
    snap_date = _get_latest_snapshot_date(conn, fmt)
    if snap_date is None:
        # No snapshots — return zeros so downstream code doesn't crash
        return {
            "format_key": fmt,
            "snapshot_date": None,
            "my_values": {p: 0 for p in DYNASTY_POSITIONS},
            "league_avg": {p: 0 for p in DYNASTY_POSITIONS},
            "needs": {
                p: {"my_value": 0, "league_avg": 0, "need_score": 0.0, "label": "unknown"}
                for p in DYNASTY_POSITIONS
            },
            "all_managers": {},
        }

    # Use the most recent league in the family (current rosters)
    family_ids = get_league_family_ids(conn, league_id)
    # Pick the league with the highest season number as "current"
    current_league_row = conn.execute(
        f"""
        SELECT id FROM leagues WHERE id IN ({','.join('?' * len(family_ids))})
        ORDER BY season DESC LIMIT 1
        """,
        family_ids,
    ).fetchone()
    current_league_id = current_league_row["id"] if current_league_row else league_id

    # Get all managers with rosters in the current league
    managers = conn.execute(
        "SELECT DISTINCT user_id FROM roster_players WHERE league_id = ?",
        (current_league_id,),
    ).fetchall()

    if not managers:
        return {
            "format_key": fmt,
            "snapshot_date": snap_date,
            "my_values": {p: 0 for p in DYNASTY_POSITIONS},
            "league_avg": {p: 0 for p in DYNASTY_POSITIONS},
            "needs": {
                p: {"my_value": 0, "league_avg": 0, "need_score": 0.0, "label": "unknown"}
                for p in DYNASTY_POSITIONS
            },
            "all_managers": {},
        }

    # For each manager, sum player values by position
    all_manager_values: dict[str, dict[str, int]] = {}

    for mgr_row in managers:
        uid = mgr_row["user_id"]
        pos_totals: dict[str, int] = {p: 0 for p in DYNASTY_POSITIONS}

        roster_players = conn.execute(
            """
            SELECT rp.player_id, pl.position,
                   COALESCE(vs.value, 0) as value
            FROM roster_players rp
            JOIN players pl ON pl.sleeper_id = rp.player_id
            LEFT JOIN value_snapshots vs
                   ON vs.player_id = rp.player_id
                  AND vs.source = 'rosteraudit'
                  AND vs.format = ?
                  AND vs.snapshot_date = ?
            WHERE rp.league_id = ? AND rp.user_id = ?
              AND pl.position IN ('QB','RB','WR','TE')
            """,
            (fmt, snap_date, current_league_id, uid),
        ).fetchall()

        for rp in roster_players:
            pos = rp["position"]
            if pos in pos_totals:
                pos_totals[pos] += rp["value"]

        all_manager_values[uid] = pos_totals

    # League averages (only managers with rosters)
    n = len(all_manager_values)
    league_avg: dict[str, float] = {}
    for pos in DYNASTY_POSITIONS:
        total = sum(v[pos] for v in all_manager_values.values())
        league_avg[pos] = total / n if n > 0 else 0.0

    # My values and needs
    my_values = all_manager_values.get(my_user_id, {p: 0 for p in DYNASTY_POSITIONS})
    needs: dict[str, dict] = {}
    for pos in DYNASTY_POSITIONS:
        avg = league_avg[pos]
        my_val = my_values[pos]
        if avg > 0:
            need_score = (avg - my_val) / avg
        else:
            need_score = 0.0

        if need_score > 0.15:
            label = "need"
        elif need_score > 0.05:
            label = "slight need"
        elif need_score < -0.15:
            label = "surplus"
        elif need_score < -0.05:
            label = "slight surplus"
        else:
            label = "average"

        needs[pos] = {
            "my_value": my_val,
            "league_avg": round(avg),
            "need_score": round(need_score, 3),
            "label": label,
        }

    # --- Add pick capital as a synthetic "position" ---
    pick_capital = compute_pick_capital(conn, league_id, snap_date, fmt)
    my_picks = pick_capital.get(my_user_id, {}).get("pick_capital_score", 0.0)

    # need_score for picks: positive = I need picks (below avg capital),
    #                       negative = I have surplus pick capital
    pick_need_score = round(-my_picks, 3)
    if pick_need_score > 0.20:
        pick_label = "need"
    elif pick_need_score > 0.07:
        pick_label = "slight need"
    elif pick_need_score < -0.20:
        pick_label = "surplus"
    elif pick_need_score < -0.07:
        pick_label = "slight surplus"
    else:
        pick_label = "average"

    needs["PICKS"] = {
        "my_value": round(my_picks * 1000),    # scaled for display parity
        "league_avg": 0,
        "need_score": pick_need_score,
        "label": pick_label,
        "net_pick_value": pick_capital.get(my_user_id, {}).get("net_pick_value", 0),
        "net_future_picks": pick_capital.get(my_user_id, {}).get("net_future_picks", 0),
    }

    return {
        "format_key": fmt,
        "snapshot_date": snap_date,
        "my_values": my_values,
        "league_avg": {p: round(v) for p, v in league_avg.items()},
        "needs": needs,
        "all_managers": all_manager_values,
        "pick_capital": pick_capital,
    }


def _positional_fit_score(
    target_user_id: str,
    my_needs: dict,           # output of compute_positional_needs()["needs"]
    all_manager_values: dict,
    league_avg: dict,
    target_pos_biases: dict,  # position_biases from target's profile
    my_pick_need: float = 0.0,
    their_pick_score: float = 0.0,
) -> tuple[float, list[str], list[str]]:
    """
    Score how well a target manager complements my positional needs.

    Returns:
        (score 0-1, my_needs_they_fill, my_surplus_they_want)

    Signals checked per position:
      - I need pos X AND they have surplus of pos X
            AND their shedding bias for X is neutral/negative (cheap source)
      - I have surplus of pos X AND they overpay when acquiring X
    """
    target_values = all_manager_values.get(target_user_id, {})
    signals: list[float] = []
    fills_my_need: list[str] = []
    wants_my_surplus: list[str] = []

    for pos in DYNASTY_POSITIONS:
        need_score = my_needs.get(pos, {}).get("need_score", 0.0)
        avg = league_avg.get(pos, 0)
        their_val = target_values.get(pos, 0)

        their_surplus = (their_val - avg) / avg if avg > 0 else 0.0

        acq_bias = (target_pos_biases.get(pos, {}).get("acquiring", {}).get("avg_differential") or 0.0)
        shed_bias = (target_pos_biases.get(pos, {}).get("shedding", {}).get("avg_differential") or 0.0)

        if need_score > 0.05:
            # I need this position — do they have surplus AND undersell it?
            if their_surplus > 0.10:
                # They have surplus — a potential source
                # Better if they also tend to undersell (negative shedding bias)
                undersell_bonus = max(0.0, -shed_bias)  # 0 if neutral, positive if they undersell
                signal = min(1.0, their_surplus + undersell_bonus * 0.5)
                signals.append(signal * need_score)  # weight by how badly I need it
                fills_my_need.append(pos)

        if need_score < -0.05:
            # I have surplus — do they overpay when acquiring this position?
            my_surplus = abs(need_score)
            if acq_bias < -0.05:
                # They overpay — good target to sell to
                overpay_strength = min(1.0, abs(acq_bias) * 4)
                signals.append(overpay_strength * my_surplus)
                wants_my_surplus.append(pos)

    # --- Pick capital alignment ---
    # I need picks AND they have surplus pick capital → they may sell players for picks
    if my_pick_need > 0.07 and their_pick_score > 0.10:
        signals.append(min(1.0, my_pick_need * their_pick_score * 4))
        fills_my_need.append("PICKS")
    # I have surplus picks AND they need picks → they may trade players to me for picks
    if my_pick_need < -0.07 and their_pick_score < -0.10:
        signals.append(min(1.0, abs(my_pick_need) * abs(their_pick_score) * 4))
        wants_my_surplus.append("PICKS")

    score = min(1.0, sum(signals) / max(1, len(signals))) if signals else 0.0
    return round(score, 3), fills_my_need, wants_my_surplus


def profile_hash(profile: dict) -> str:
    """Stable hash of profile data — used to invalidate cached scouting reports."""
    canonical = json.dumps(profile, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Posture classification
# ---------------------------------------------------------------------------

def classify_posture(posture_patterns: dict) -> str:
    """
    Classify a manager's roster posture from their trade-flow patterns.

    'rebuild'  — predominantly receives picks (buying future)
    'contend'  — predominantly receives players (buying present)
    'middling' — balanced or insufficient data

    Thresholds: one direction needs to be at least 1.5× the other to be
    classified; otherwise falls back to 'middling'.
    """
    rebuild_n = posture_patterns.get("rebuild", {}).get("count", 0)
    contend_n = posture_patterns.get("contend", {}).get("count", 0)
    total = rebuild_n + contend_n

    if total < 3:
        return "middling"

    if rebuild_n >= contend_n * 1.5:
        return "rebuild"
    if contend_n >= rebuild_n * 1.5:
        return "contend"
    return "middling"


def _direction_mismatch(my_posture: str, their_posture: str) -> float:
    """
    Score how complementary two managers' postures are.
    rebuild ↔ contend = 1.0 (perfect trade partners)
    either  ↔ middling = 0.5
    same    ↔ same     = 0.0
    """
    if my_posture == their_posture:
        return 0.0
    if "middling" in (my_posture, their_posture):
        return 0.5
    return 1.0


def _top_negative_bias(position_biases: dict) -> tuple[str | None, float | None]:
    """Return the position with the worst (most negative) acquiring differential."""
    worst_pos: str | None = None
    worst_val: float | None = None
    for pos, data in position_biases.items():
        avg = data.get("acquiring", {}).get("avg_differential")
        if avg is not None and (worst_val is None or avg < worst_val):
            worst_pos = pos
            worst_val = avg
    return worst_pos, worst_val


def _build_actionable_summary(
    manager_name: str,
    their_profile: dict,
    their_posture: str,
    my_posture: str,
    fills_my_need: list[str] | None = None,
    wants_my_surplus: list[str] | None = None,
    their_pick_score: float = 0.0,
    my_pick_need: float = 0.0,
) -> str:
    """
    Build a short rule-based actionable summary for a trade target.

    Examples:
    - "Overpays for WRs (-24%, 2W-7L). Contending based on trade patterns.
       Consider offering WR depth or veterans in exchange for picks."
    - "Fair trader overall. Rebuilding. May trade veteran RBs for picks."
    """
    parts: list[str] = []

    diff_stats = their_profile.get("differential_stats", {})
    avg_diff = diff_stats.get("avg_decision_differential")
    win_rate = diff_stats.get("win_rate")

    # Overall trade quality
    if avg_diff is not None and avg_diff < -0.08:
        pct_str = f"{abs(round(avg_diff * 100))}%"
        wins = diff_stats.get("wins", 0)
        losses = diff_stats.get("losses", 0)
        parts.append(f"Gives away ~{pct_str} of value per trade on average ({wins}W-{losses}L).")
    elif win_rate is not None and win_rate > 0.55:
        parts.append(f"Sharp trader — wins {round(win_rate * 100)}% of trades. Target carefully.")

    # Worst position bias
    worst_pos, worst_val = _top_negative_bias(their_profile.get("position_biases", {}))
    if worst_pos and worst_val is not None and worst_val < -0.08:
        n = their_profile["position_biases"][worst_pos]["acquiring"].get("count", 0)
        w = their_profile["position_biases"][worst_pos]["acquiring"].get("wins", 0)
        l = their_profile["position_biases"][worst_pos]["acquiring"].get("losses", 0)
        parts.append(
            f"Overpays for {worst_pos}s ({round(worst_val * 100)}%, {w}W-{l}L in {n} trades)."
        )

    # Posture + trade suggestion
    posture_labels = {"rebuild": "rebuilding", "contend": "contending", "middling": "direction unclear"}
    parts.append(f"Trade pattern suggests {posture_labels.get(their_posture, 'unclear direction')}.")

    non_pick_fills = [p for p in (fills_my_need  or []) if p != "PICKS"]
    non_pick_wants = [p for p in (wants_my_surplus or []) if p != "PICKS"]
    posture_labels = {"rebuild": "rebuilding", "contend": "contending", "middling": "direction unclear"}

    # Posture-driven call-to-action — the most important part of the summary
    if my_posture == "rebuild":
        # I want to sell players for picks. Best target: contender/middling who wants my stuff and has picks.
        if non_pick_wants and their_pick_score > 0.05 and their_posture in ("contend", "middling"):
            pos_str = "/".join(non_pick_wants)
            parts.append(
                f"Strong sell target: {posture_labels[their_posture]}, needs {pos_str}, and has draft capital. "
                f"Offer your {pos_str} depth for future picks."
            )
        elif non_pick_wants and their_posture in ("contend", "middling"):
            pos_str = "/".join(non_pick_wants)
            parts.append(f"They need {pos_str} and are {posture_labels[their_posture]} — push for picks in return.")
        elif their_pick_score > 0.10:
            parts.append("Has surplus draft capital — a potential source of picks even without a position match.")
        elif "PICKS" in (fills_my_need or []):
            parts.append("Has extra future picks — good target to sell proven players for draft capital.")
        elif non_pick_wants:
            pos_str = "/".join(non_pick_wants)
            parts.append(f"Needs {pos_str} (your surplus) but limited pick capital — might trade players or mixed assets.")

    elif my_posture == "contend":
        # I want to buy players with picks. Best target: rebuilder/middling who has my needed positions and needs picks.
        if non_pick_fills and their_posture in ("rebuild", "middling") and (their_pick_score < -0.05 or my_pick_need < -0.07):
            pos_str = "/".join(non_pick_fills)
            parts.append(
                f"Strong buy target: {posture_labels[their_posture]}, has {pos_str} depth, and needs draft capital. "
                f"Offer picks for their {pos_str}."
            )
        elif non_pick_fills and their_posture in ("rebuild", "middling"):
            pos_str = "/".join(non_pick_fills)
            parts.append(f"Has {pos_str} surplus and is {posture_labels[their_posture]} — offer picks or young assets.")
        elif "PICKS" in (wants_my_surplus or []):
            parts.append("Needs draft capital — consider offering picks for proven contributors.")
        elif non_pick_fills:
            pos_str = "/".join(non_pick_fills)
            parts.append(f"Has {pos_str} depth at your needed position — explore trade structure.")

    else:
        # Middling posture — balanced hints
        if "PICKS" in (fills_my_need or []):
            parts.append("Has surplus draft capital — good target to sell players for picks.")
        if "PICKS" in (wants_my_surplus or []):
            parts.append("Needs draft capital — consider offering picks for their players.")
        if non_pick_fills:
            pos_str = "/".join(non_pick_fills)
            parts.append(f"Has {pos_str} depth that could fill your positional need.")
        if non_pick_wants:
            pos_str = "/".join(non_pick_wants)
            parts.append(f"Tends to overpay for {pos_str} — good target to sell your surplus.")
        if not fills_my_need and not wants_my_surplus:
            if their_posture == "contend" and worst_pos:
                parts.append(f"Consider offering {worst_pos} assets — they tend to overpay for them.")
            elif their_posture == "rebuild":
                parts.append("May be willing to sell veterans at a discount.")

    return " ".join(parts) if parts else "Insufficient data to generate a recommendation."


# ---------------------------------------------------------------------------
# Trade target scoring
# ---------------------------------------------------------------------------

def _posture_fit_multiplier(
    my_posture: str,
    their_posture: str,
    fills_my_need: list[str],
    wants_my_surplus: list[str],
    their_pick_score: float,
    my_pick_need: float,
) -> float:
    """
    Boost the positional fit score based on whether the trade structure
    aligns with my posture goal.

    Rebuild → I want to SELL players for PICKS
      Ideal: they're contending/middling + need a position I have + have picks to give.
      Each condition met adds a layer; all three = 2.5× multiplier.

    Contend → I want to BUY players with PICKS
      Ideal: they're rebuilding/middling + have a position I need + need picks.
      Each condition met adds a layer; all three = 2.5× multiplier.

    Middling → no adjustment (1.0×).
    """
    non_pick_wants = [p for p in wants_my_surplus if p != "PICKS"]
    non_pick_fills = [p for p in fills_my_need  if p != "PICKS"]

    if my_posture == "rebuild":
        # I want to trade players away and accumulate picks
        has_right_posture  = their_posture in ("contend", "middling")
        they_want_my_stuff = len(non_pick_wants) > 0           # they need positions I have surplus
        they_have_picks    = their_pick_score > 0.05            # they have draft capital to offer

        conditions_met = sum([has_right_posture, they_want_my_stuff, they_have_picks])
        if conditions_met == 3:
            return 2.5
        if conditions_met == 2:
            return 1.7
        if conditions_met == 1:
            return 1.2
        return 0.6   # none match — penalty: wrong type of target for rebuild mode

    if my_posture == "contend":
        # I want to acquire players by offering picks
        has_right_posture = their_posture in ("rebuild", "middling")
        they_have_my_need = len(non_pick_fills) > 0            # they have surplus at positions I need
        they_need_picks   = their_pick_score < -0.05 or my_pick_need < -0.07  # they need picks OR I have surplus picks

        conditions_met = sum([has_right_posture, they_have_my_need, they_need_picks])
        if conditions_met == 3:
            return 2.5
        if conditions_met == 2:
            return 1.7
        if conditions_met == 1:
            return 1.2
        return 0.6

    # Middling — no posture adjustment
    return 1.0


def score_trade_targets(
    conn: Connection,
    my_user_id: str,
    league_id: str,
    my_posture: str = "middling",
    positional_needs: dict | None = None,
) -> list[dict]:
    """
    Rank all managers in a league (excluding me) by trade opportunity.

    Returns a list sorted by opportunity_score descending. Each entry:
        user_id, manager_name, overpay_score, mismatch_score,
        opportunity_score, their_posture, actionable_summary,
        avg_decision_differential, win_rate
    """
    # All leagues in the family for consistent scope
    family_ids = get_league_family_ids(conn, league_id)
    _ensure_graded(conn, family_ids)

    # Get all managers in this league except me
    placeholders = ",".join("?" * len(family_ids))
    other_managers = conn.execute(
        f"""
        SELECT DISTINCT lm.user_id, m.display_name, m.username
        FROM league_managers lm
        LEFT JOIN managers m ON m.user_id = lm.user_id
        WHERE lm.league_id IN ({placeholders})
          AND lm.user_id != ?
        """,
        (*family_ids, my_user_id),
    ).fetchall()

    # Compute positional needs once for the whole league (expensive — do it once)
    if positional_needs is None:
        positional_needs = compute_positional_needs(conn, my_user_id, league_id)

    pos_needs = positional_needs.get("needs", {})
    all_manager_values = positional_needs.get("all_managers", {})
    league_avg_values = positional_needs.get("league_avg", {})
    pick_capital = positional_needs.get("pick_capital", {})
    my_pick_need = pos_needs.get("PICKS", {}).get("need_score", 0.0)

    # Load all posture overrides for this league family in one query
    ph2 = ",".join("?" * len(family_ids))
    override_rows = conn.execute(
        f"SELECT user_id, posture FROM user_posture_overrides WHERE league_id IN ({ph2})",
        family_ids,
    ).fetchall()
    posture_overrides: dict[str, str] = {r["user_id"]: r["posture"] for r in override_rows}

    targets = []
    for row in other_managers:
        uid = row["user_id"]
        name = row["display_name"] or row["username"] or uid

        trades = _get_manager_trades(conn, uid, family_ids)
        if not trades:
            continue

        diff_stats = compute_differential_stats(trades)
        pos_biases = compute_position_biases(trades)
        posture_patterns = compute_posture_patterns(trades)

        # Respect manual override; fall back to auto-detected posture
        their_posture = posture_overrides.get(uid) or classify_posture(posture_patterns)
        posture_is_override = uid in posture_overrides

        avg_diff = diff_stats.get("avg_decision_differential") or 0.0

        # Overpay score: normalize avg differential to 0–1
        # -0.25 → 1.0 (terrible trader), 0.0 → 0.5, +0.25 → 0.0 (great trader)
        overpay_score = max(0.0, min(1.0, (-avg_diff + 0.25) / 0.50))

        mismatch_score = _direction_mismatch(my_posture, their_posture)

        # Positional fit score — includes pick capital alignment
        their_pick_score = pick_capital.get(uid, {}).get("pick_capital_score", 0.0)
        pos_fit_score, fills_my_need, wants_my_surplus = _positional_fit_score(
            uid, pos_needs, all_manager_values, league_avg_values, pos_biases,
            my_pick_need=my_pick_need,
            their_pick_score=their_pick_score,
        )

        # Posture-conditioned fit multiplier:
        # When rebuilding: best targets are contenders/middling who want my players AND have picks
        # When contending: best targets are rebuilders/middling who have my needed players AND need picks
        pos_fit_multiplier = _posture_fit_multiplier(
            my_posture, their_posture,
            fills_my_need, wants_my_surplus,
            their_pick_score, my_pick_need,
        )
        conditioned_fit = min(1.0, pos_fit_score * pos_fit_multiplier)

        # Reweighted opportunity score: 0.35 overpay + 0.25 direction + 0.40 positional fit
        opportunity_score = round(
            overpay_score * 0.35
            + mismatch_score * 0.25
            + conditioned_fit * 0.40,
            3,
        )

        fake_profile = {
            "differential_stats": diff_stats,
            "position_biases": pos_biases,
            "posture_patterns": posture_patterns,
        }
        summary = _build_actionable_summary(
            name, fake_profile, their_posture, my_posture,
            fills_my_need=fills_my_need,
            wants_my_surplus=wants_my_surplus,
            their_pick_score=their_pick_score,
            my_pick_need=my_pick_need,
        )

        targets.append({
            "user_id": uid,
            "manager_name": name,
            "their_posture": their_posture,
            "posture_is_override": posture_is_override,
            "overpay_score": round(overpay_score, 3),
            "mismatch_score": round(mismatch_score, 3),
            "pos_fit_score": pos_fit_score,
            "opportunity_score": opportunity_score,
            "fills_my_need": fills_my_need,
            "wants_my_surplus": wants_my_surplus,
            "pick_capital_score": round(their_pick_score, 3),
            "avg_decision_differential": diff_stats.get("avg_decision_differential"),
            "win_rate": diff_stats.get("win_rate"),
            "total_trades": diff_stats.get("total_trades", 0),
            "actionable_summary": summary,
        })

    targets.sort(key=lambda t: t["opportunity_score"], reverse=True)
    return targets
