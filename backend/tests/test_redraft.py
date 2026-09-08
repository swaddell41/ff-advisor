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
