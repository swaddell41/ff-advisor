"""Lineup optimizer + ranking for the auction-value redraft evaluator."""

from app.redraft import _dst_espn_id_by_abbrev, _rank_teams, _team_sheet, optimal_lineup


def _p(name, pos, aav):
    return {"name": name, "pos": pos, "aav": aav}


SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"]


def test_optimal_lineup_fills_dedicated_then_flex():
    players = [
        _p("QB1", "QB", 40), _p("QB2", "QB", 20),
        _p("RB1", "RB", 60), _p("RB2", "RB", 50), _p("RB3", "RB", 30),
        _p("WR1", "WR", 55), _p("WR2", "WR", 45), _p("WR3", "WR", 25),
        _p("TE1", "TE", 15), _p("K1", "K", 1), _p("D1", "DST", 2),
        _p("Bench", "RB", 5),
    ]
    starters, bench = optimal_lineup(players, SLOTS)
    by_slot = {}
    for s in starters:
        by_slot.setdefault(s["slot"], []).append(s["name"])
    assert sorted(by_slot["RB"]) == ["RB1", "RB2"]
    assert by_slot["FLEX"] == ["RB3"]          # 30 beats WR3's 25 for the flex
    assert by_slot["SUPER_FLEX"] == ["WR3"]    # QB2 (20) loses SF to WR3 (25)
    assert [b["name"] for b in bench] == [_pn for _pn in ["QB2", "Bench"]]


def test_superflex_prefers_qb_when_richer():
    players = [
        _p("QB1", "QB", 40), _p("QB2", "QB", 35),
        _p("RB1", "RB", 30), _p("RB2", "RB", 10), _p("WR1", "WR", 8),
        _p("WR2", "WR", 6), _p("TE1", "TE", 4), _p("K1", "K", 1), _p("D1", "DST", 1),
    ]
    starters, _ = optimal_lineup(players, SLOTS)
    sf = [s for s in starters if s["slot"] == "SUPER_FLEX"]
    assert sf and sf[0]["name"] == "QB2"


def test_none_aav_players_ride_the_bench():
    players = [_p("RB1", "RB", 20), {"name": "Rookie", "pos": "RB", "aav": None}]
    starters, bench = optimal_lineup(players, ["RB"])
    assert starters[0]["name"] == "RB1"
    assert bench[0]["name"] == "Rookie"


def test_team_sheet_and_ranks():
    strong = _team_sheet("A", "a", [_p("RB1", "RB", 60), _p("WR1", "WR", 10)], ["RB", "WR"])
    weak = _team_sheet("B", "b", [_p("RB2", "RB", 20), _p("WR2", "WR", 30)], ["RB", "WR"])
    teams = [strong, weak]
    _rank_teams(teams)
    assert strong["rank"] == 1 and weak["rank"] == 2
    assert strong["pos_rank"]["RB"] == 1 and strong["pos_rank"]["WR"] == 2
    assert strong["starters_total"] == 70.0


def test_dst_abbrev_mapping_matches_espn_ids():
    m = _dst_espn_id_by_abbrev()
    assert m["HOU"] == "-16034"   # Texans D/ST, verified against live trends
    assert m["DEN"] == "-16007"
    assert m["WAS"] == "-16028"   # Sleeper says WAS where ESPN says WSH


def test_adp_curve_is_monotone_and_bounded():
    from app.redraft import _adp_curve
    values = {
        "1": {"aav": 70, "adp": 1.2}, "2": {"aav": 60, "adp": 2.1},
        "3": {"aav": 65, "adp": 3.0},  # local bump must be flattened
        "4": {"aav": 20, "adp": 10.0}, "5": {"aav": 1, "adp": 50.0},
    }
    curve = _adp_curve(values)
    xs = [curve(a) for a in [1, 2, 3, 10, 50]]
    assert xs == sorted(xs, reverse=True)
    assert curve(3) <= curve(2)          # monotone despite the bump
    assert curve(999) == 0.0             # beyond the sheet -> worthless
    assert curve(None) == 0.0


def test_methods_registry():
    from app.redraft import METHODS
    assert set(METHODS) == {"auction", "proj", "adp", "market"}


def test_lineup_swap_plan():
    from app.lineup import _build_result
    players = [
        {"name": "StarRB", "pos": "RB", "aav": 22.0, "injury": ""},
        {"name": "BenchedStud", "pos": "WR", "aav": 18.0, "injury": ""},
        {"name": "StartedDud", "pos": "WR", "aav": 4.0, "injury": ""},
        {"name": "HurtGuy", "pos": "RB", "aav": 0.0, "injury": "OUT"},
    ]
    current = {"StarRB", "StartedDud", "HurtGuy"}
    res = _build_result("T", 1, players, current, ["RB", "WR", "FLEX"])
    assert [p["name"] for p in res["start"]] == ["BenchedStud"]
    assert {p["name"] for p in res["sit"]} == {"HurtGuy"}  # dud keeps FLEX, hurt RB sits
    assert res["delta"] == res["optimal_total"] - res["current_total"]
    assert any(f["name"] == "HurtGuy" and f["why"] == "OUT" for f in res["flags"])


def test_blend_and_implied_total_math():
    from app.lineup import blend
    assert blend(20.0, 10.0) == 15.0
    assert blend(20.0, None) == 20.0   # single source stands alone
    # implied = (over/under - team spread) / 2; favorite carries a negative spread
    ou, fav_spread = 44.5, -3.0
    assert round((ou - fav_spread) / 2, 1) == 23.8   # favorite
    assert round((ou - (-fav_spread)) / 2, 1) == 20.8  # underdog


def test_optimal_lineup_display_order_is_positional():
    from app.lineup import _build_result
    players = [
        {"name": "K1", "pos": "K", "aav": 9.0, "injury": ""},
        {"name": "QB1", "pos": "QB", "aav": 20.0, "injury": ""},
        {"name": "D1", "pos": "DST", "aav": 8.0, "injury": ""},
        {"name": "WR1", "pos": "WR", "aav": 15.0, "injury": ""},
        {"name": "RB1", "pos": "RB", "aav": 12.0, "injury": ""},
        {"name": "RB2", "pos": "RB", "aav": 10.0, "injury": ""},
        {"name": "WR2", "pos": "WR", "aav": 22.0, "injury": ""},  # highest scorer overall
        {"name": "QB2", "pos": "QB", "aav": 11.0, "injury": ""},
    ]
    slots = ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"]
    res = _build_result("T", 1, players, set(), slots)
    assert [p["slot"] for p in res["optimal"]] == ["QB", "RB", "WR", "FLEX", "SUPER_FLEX", "K", "DEF"]
    assert res["optimal"][0]["name"] == "QB1"      # not WR2, despite 22.0


def test_faab_tiers_follow_expert_rules():
    from app.waivers import recommend_bid
    # League-winner, hot trend, early season: top of the 40-60% range.
    lw = recommend_bid("league-winner", 100, 3, trend_rank=2)
    assert 55 <= lw["bid"] <= 60
    # A new starter never exceeds 30% of remaining, and stays <=25% in month one.
    st = recommend_bid("starter", 100, 2, trend_rank=1)
    assert st["bid"] <= 25
    st_mid = recommend_bid("starter", 100, 8, trend_rank=1)
    assert 25 <= st_mid["bid"] <= 30
    # Depreciation: same claim is cheaper in the playoffs.
    late = recommend_bid("starter", 100, 16, trend_rank=1)
    assert late["bid"] < st_mid["bid"]
    # Streamers are $1-4 money; a pass bids nothing.
    assert 1 <= recommend_bid("streamer", 100, 6, None)["bid"] <= 4
    assert recommend_bid("pass", 100, 6, None)["bid"] == 0


def test_waiver_analysis_bars_and_tiers():
    from app.waivers import analyze
    mine = [
        {"name": "RB1", "pos": "RB", "aav": 16.0, "season": 220},
        {"name": "RB2", "pos": "RB", "aav": 8.0, "season": 120},
        {"name": "WR1", "pos": "WR", "aav": 14.0, "season": 200},
        {"name": "WR2", "pos": "WR", "aav": 9.0, "season": 130},
        {"name": "BenchRB", "pos": "RB", "aav": 3.0, "season": 60},
    ]
    cands = [
        {"name": "Breakout", "pos": "RB", "aav": 15.0, "season": 180, "trend_rank": 1},
        {"name": "Dart", "pos": "WR", "aav": 7.0, "season": 100, "trend_rank": 12},
        {"name": "Nobody", "pos": "WR", "aav": 2.0, "season": 30, "trend_rank": None},
    ]
    res = analyze(mine, cands, ["RB", "RB", "WR", "WR"], week=6,
                  faab={"enabled": True, "budget": 100, "used": 20, "remaining": 80}, waiver_position=None)
    by = {c["name"]: c for c in res["candidates"]}
    assert res["bars"]["RB"]["name"] == "RB2"                 # weakest RB starter is the bar
    assert by["Breakout"]["tier"] == "league-winner"         # +7 over the bar with a real role
    assert by["Breakout"]["faab"]["bid"] >= 32                # 40%+ of the $80 remaining
    assert by["Dart"]["tier"] == "upside" and by["Dart"]["faab"]["bid"] < 10
    assert by["Nobody"]["tier"] == "pass" and by["Nobody"]["faab"]["bid"] == 0
    assert res["drop"]["name"] == "BenchRB"
    assert res["candidates"][0]["name"] == "Breakout"


def test_trade_prompt_rules():
    from app.home import trade_prompt
    needs = {"WR": {"label": "need", "need_score": 0.2}, "RB": {"label": "surplus", "need_score": -0.2}}
    assert trade_prompt("contend", 0, 0, None, 10, 1, needs)["action"] == "hold"          # preseason
    assert trade_prompt("contend", 2, 1, 3, 10, 4, needs)["action"] == "buy"             # contender with a hole
    assert trade_prompt("contend", 1, 4, 9, 10, 6, needs)["action"] == "reassess"        # contender sinking
    assert trade_prompt("rebuild", 1, 4, 9, 10, 6, needs)["action"] == "sell"            # rebuilding, losing
    assert trade_prompt("rebuild", 5, 0, 1, 10, 6, needs)["action"] == "reassess"        # rebuilding, winning
    assert trade_prompt("middling", 1, 4, 9, 10, 6, needs)["action"] == "sell"           # no goal, out of it
    assert trade_prompt("middling", 3, 2, 4, 10, 6, needs)["action"] == "buy"            # no goal, in the hunt, has a hole
    p = trade_prompt("contend", 2, 1, 3, 10, 4, needs)
    assert p["needs"] == ["WR"] and p["surplus"] == ["RB"]
