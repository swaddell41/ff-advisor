// Mid-draft join: backfill supplies history, live feed continues from it.
// Mirrors the merge block in annotate.js applyEspn.
function merge(backfill, livePicks) {
  const merged = [], have = new Set();
  for (const b of backfill || []) {
    if (have.has(b.espn_id)) continue;
    have.add(b.espn_id); merged.push(b);
  }
  let next = merged.reduce((m, b) => Math.max(m, b.pick_no), 0);
  for (const p of livePicks) {
    const id = String(p.espn_id);
    if (have.has(id)) continue;
    have.add(id);
    merged.push({ espn_id: id, team_id: p.team_id, pick_no: ++next });
  }
  return merged.sort((a, b) => a.pick_no - b.pick_no);
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
const m = merge(backfill, live);
ok('history preserved, not lost', m.length, 16);
ok('pick numbers stay dense and correct', m.map(p => p.pick_no),
   Array.from({length:16},(_,i)=>i+1));
ok('live picks continue from the backfill, not from 1',
   m.slice(14).map(p => [p.espn_id, p.pick_no]), [['p15',15],['p16',16]]);
ok('round 1 recoverable for seating', m.filter(p => p.pick_no <= 8).map(p => p.team_id), ORDER);

// Overlap: the live feed re-reports a pick the backfill already had.
const dup = merge(backfill, [{ espn_id: 'p14', team_id: '4', pick_no: 1 },
                             { espn_id: 'p15', team_id: '8', pick_no: 2 }]);
ok('duplicate across sources counted once', dup.length, 15);
ok('duplicate does not shift numbering', dup.slice(-1)[0], {espn_id:'p15', team_id:'8', pick_no:15});

// No backfill (mock, or API unreadable): must behave exactly as before.
const none = merge([], [{espn_id:'a',team_id:'1',pick_no:1},{espn_id:'b',team_id:'2',pick_no:2}]);
ok('no backfill -> live feed unchanged', none.map(p=>p.pick_no), [1,2]);
ok('no backfill -> teams intact', none.map(p=>p.team_id), ['1','2']);

// Unmade picks in a pre-allocated array must already be filtered out.
const sparse = [{espn_id:'x',team_id:'1',pick_no:1},{espn_id:'y',team_id:'2',pick_no:2}];
ok('sparse backfill still merges', merge(sparse, [{espn_id:'z',team_id:'3',pick_no:1}]).map(p=>p.pick_no), [1,2,3]);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
