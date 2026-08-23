// Mid-draft join: backfill supplies history, the DOM-scraped Pick History
// fills mock-draft holes, the live feed continues from both. Mirrors the
// merge block in annotate.js applyEspn (three sources, team fill-in).
function merge(backfill, domHistory, livePicks) {
  const merged = [], have = new Map(), usedPick = new Set();
  for (const b of backfill || []) {
    if (have.has(b.espn_id)) continue;
    have.set(b.espn_id, b); usedPick.add(b.pick_no); merged.push(b);
  }
  for (const b of domHistory || []) {
    if (have.has(b.espn_id) || usedPick.has(b.pick_no)) continue;
    const e = { espn_id: b.espn_id, team_id: null, pick_no: b.pick_no };
    have.set(b.espn_id, e); usedPick.add(b.pick_no); merged.push(e);
  }
  let next = merged.reduce((m, b) => Math.max(m, b.pick_no), 0);
  for (const p of livePicks) {
    const id = String(p.espn_id);
    if (have.has(id)) {
      const e = have.get(id);
      if (e.team_id == null && p.team_id != null) e.team_id = String(p.team_id);
      continue;
    }
    const e = { espn_id: id, team_id: p.team_id, pick_no: ++next };
    have.set(id, e); merged.push(e);
  }
  return merged.sort((a, b) => a.pick_no - b.pick_no);
}

// Positional team attribution for history-recovered picks (no team id):
// in a snake draft the pick number names the slot, any other pick from
// the same slot names the team. Mirrors applyEspn.
function fillTeams(merged, teams) {
  const slotOfPick = (pn) => {
    const rnd = Math.floor((pn - 1) / teams);
    const idx = (pn - 1) % teams;
    return rnd % 2 === 1 ? teams - idx : idx + 1;
  };
  const slotTeam = new Map();
  for (const p of merged) {
    if (p.team_id != null && p.pick_no != null && !slotTeam.has(slotOfPick(p.pick_no))) {
      slotTeam.set(slotOfPick(p.pick_no), String(p.team_id));
    }
  }
  for (const p of merged) {
    if (p.team_id == null && p.pick_no != null) {
      const t = slotTeam.get(slotOfPick(p.pick_no));
      if (t != null) p.team_id = t;
    }
  }
  return merged;
}
let fail = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) fail++; console.log(`${p?'PASS':'FAIL'}  ${l}: ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

// The real scenario: refresh at pick 15. ESPN knows picks 1-14; our socket
// reconnects and numbers what it sees from 1 again.
const ORDER = ['4','6','8','1','2','3','7','5'];
const backfill = Array.from({length: 14}, (_, i) => ({
  espn_id: 'p' + (i + 1), team_id: ORDER[i < 8 ? i : 15 - i], pick_no: i + 1 }));
const live = [ { espn_id: 'p15', team_id: '8', pick_no: 1 },
               { espn_id: 'p16', team_id: '4', pick_no: 2 } ];
const m = merge(backfill, [], live);
ok('history preserved, not lost', m.length, 16);
ok('pick numbers stay dense and correct', m.map(p => p.pick_no),
   Array.from({length:16},(_,i)=>i+1));
ok('live picks continue from the backfill, not from 1',
   m.slice(14).map(p => [p.espn_id, p.pick_no]), [['p15',15],['p16',16]]);
ok('round 1 recoverable for seating', m.filter(p => p.pick_no <= 8).map(p => p.team_id), ORDER);

// Overlap: the live feed re-reports a pick the backfill already had.
const dup = merge(backfill, [], [{ espn_id: 'p14', team_id: '4', pick_no: 1 },
                                 { espn_id: 'p15', team_id: '8', pick_no: 2 }]);
ok('duplicate across sources counted once', dup.length, 15);
ok('duplicate does not shift numbering', dup.slice(-1)[0], {espn_id:'p15', team_id:'8', pick_no:15});

// No backfill (mock, or API unreadable): must behave exactly as before.
const none = merge([], [], [{espn_id:'a',team_id:'1',pick_no:1},{espn_id:'b',team_id:'2',pick_no:2}]);
ok('no backfill -> live feed unchanged', none.map(p=>p.pick_no), [1,2]);
ok('no backfill -> teams intact', none.map(p=>p.team_id), ['1','2']);

// Unmade picks in a pre-allocated array must already be filtered out.
const sparse = [{espn_id:'x',team_id:'1',pick_no:1},{espn_id:'y',team_id:'2',pick_no:2}];
ok('sparse backfill still merges', merge(sparse, [], [{espn_id:'z',team_id:'3',pick_no:1}]).map(p=>p.pick_no), [1,2,3]);


// ── The v0.5.4 regression: pre-allocated draftDetail ─────────────────────
// ESPN returns EVERY pick slot from the moment a draft is created; unmade
// ones carry a sentinel playerId. The old filter compared the stringified
// id to '0', so "-1" passed and 136 phantoms were injected.
function mapBackfill(rawPicks) {
  return rawPicks
    .filter((q) => Number(q.playerId) > 0 && Number(q.overallPickNumber) > 0)
    .map((q) => ({
      espn_id: String(q.playerId),
      team_id: q.teamId != null ? String(q.teamId) : null,
      pick_no: Number(q.overallPickNumber),
    }))
    .sort((a, b) => a.pick_no - b.pick_no);
}
// An 8x17 draft that has not started: all 136 slots pre-allocated.
const unstarted = Array.from({ length: 136 }, (_, i) => ({
  playerId: -1, teamId: (i % 8) + 1, overallPickNumber: i + 1 }));
ok('unstarted draft -> empty backfill, not 136 phantoms', mapBackfill(unstarted).length, 0);
ok('the OLD filter would have let them all through',
   unstarted.filter((q) => String(q.playerId) && String(q.playerId) !== '0').length, 136);

// Partially drafted: 14 made, the rest still sentinels.
const partial = unstarted.map((q, i) =>
  i < 14 ? { ...q, playerId: 4000000 + i } : q);
ok('partial draft -> only the made picks', mapBackfill(partial).length, 14);
ok('made picks keep real overall numbers',
   mapBackfill(partial).map((p) => p.pick_no).slice(0, 3), [1, 2, 3]);

// Other sentinel shapes ESPN might use.
ok('playerId 0 filtered', mapBackfill([{playerId:0,teamId:1,overallPickNumber:1}]).length, 0);
ok('playerId null filtered', mapBackfill([{playerId:null,teamId:1,overallPickNumber:1}]).length, 0);
ok('playerId absent filtered', mapBackfill([{teamId:1,overallPickNumber:1}]).length, 0);
ok('overallPickNumber 0 filtered',
   mapBackfill([{playerId:123456,teamId:1,overallPickNumber:0}]).length, 0);

// End to end: a mid-draft refresh at pick 15 with a pre-allocated response.
const merged = merge(mapBackfill(partial), [], [{espn_id:'live1',team_id:'8',pick_no:1}]);
ok('pre-allocated response still backfills correctly', merged.length, 15);
ok('live pick continues from the real history', merged.slice(-1)[0].pick_no, 15);

// ── DOM-scraped Pick History (mock-draft refresh recovery) ───────────────
// The real scenario: 8-team mock, tap saw picks 1-14 (persisted, arrival-
// numbered correctly), refresh missed 15-17, reconnect saw two more picks
// which arrive re-numbered from 1. The Pick History scrape has everything.
const domAll = Array.from({length: 19}, (_, i) => ({
  espn_id: 'p' + (i + 1), team_id: null, pick_no: i + 1 }));
const liveAfter = [ { espn_id: 'p14', team_id: '4', pick_no: 1 },  // seen again
                    { espn_id: 'p18', team_id: '6', pick_no: 2 },  // post-refresh
                    { espn_id: 'p19', team_id: '8', pick_no: 3 } ];
const healed = merge(backfill.slice(0, 14), domAll, liveAfter);
ok('holes filled from the page history', healed.length, 19);
ok('numbering dense through the outage', healed.map(p => p.pick_no),
   Array.from({length:19},(_,i)=>i+1));
ok('post-refresh live picks keep real numbers',
   healed.filter(p => ['p18','p19'].includes(p.espn_id)).map(p => p.pick_no), [18, 19]);
ok('live duplicate fills the team id into the history entry',
   healed.find(p => p.espn_id === 'p18').team_id, '6');

// A mock with NO backfill at all: history alone rebuilds the sequence.
const mockOnly = merge([], domAll.slice(0, 16), liveAfter);
ok('mock: history is the backbone', mockOnly.map(p => p.pick_no).slice(0, 5), [1,2,3,4,5]);
ok('mock: unseen live picks continue after the history',
   [mockOnly.find(p => p.espn_id === 'p18').pick_no,
    mockOnly.find(p => p.espn_id === 'p19').pick_no], [17, 18]);

// A history row colliding with a real backfill slot must lose.
const clash = merge([{espn_id:'real', team_id:'1', pick_no:3}],
                    [{espn_id:'ghost', team_id:null, pick_no:3}], []);
ok('history never overrides the API backfill', clash.map(p => p.espn_id), ['real']);

// Positional attribution: recovered picks inherit the slot owner's team.
// 8-team snake: picks 15-17 belong to slots 2, 3 and 4 of round 2 (snake:
// pick 15 → slot 2, 16 → slot 1... compute from the mirror itself).
const attributed = fillTeams(healed, 8);
const slotOf = (pn) => { const rnd = Math.floor((pn-1)/8), idx = (pn-1)%8;
  return rnd % 2 === 1 ? 8 - idx : idx + 1; };
const expect15 = ORDER[slotOf(15) - 1];
ok('recovered pick attributed to its slot owner',
   attributed.find(p => p.pick_no === 15).team_id, expect15);
ok('every recovered pick has a team after attribution',
   attributed.filter(p => p.team_id == null).length, 0);
ok('attribution never rewrites a known team',
   attributed.find(p => p.pick_no === 1).team_id, ORDER[0]);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
