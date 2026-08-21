// Team-count derivation, driven by the real arrival order from the capture.
const SEQ = ['8','1','2','3','7','5','5','7','3','2','1','8','6','4','4','6','8','1','2','3'];
function derive(teamIds) {
  const n = {}; let cycled = false;
  for (const t of teamIds) { n[t] = (n[t] || 0) + 1; if (n[t] > 1) cycled = true; }
  const distinct = Object.keys(n).length;
  return (cycled && distinct >= 4) ? distinct : null;
}
let fail = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) fail++; console.log(`${p?'PASS':'FAIL'}  ${l}: ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

ok('full capture -> 8 teams', derive(SEQ), 8);
// Partial round: must NOT guess, since no team has cycled yet.
ok('4 picks in, no cycle -> withholds', derive(SEQ.slice(0,4)), null);
ok('6 picks in, still no cycle -> withholds', derive(SEQ.slice(0,6)), null);
// The turn (5,5) is a cycle signal but only 6 teams seen — the danger case.
ok('at the turn with 6 distinct seen -> reports 6 (self-corrects later)', derive(SEQ.slice(0,7)), 6);
ok('once all 8 have appeared -> 8', derive(SEQ.slice(0,14)), 8);
// A clean 10-team draft from pick 1 must land on 10, not stop early.
const TEN = [];
for (let r = 0; r < 3; r++) { const o = ['1','2','3','4','5','6','7','8','9','10'];
  TEN.push(...(r % 2 ? o.slice().reverse() : o)); }
ok('10-team snake from pick 1 -> 10', derive(TEN), 10);
ok('10-team, only 9 picks in -> withholds', derive(TEN.slice(0,9)), null);
console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
