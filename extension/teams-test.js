// observedTeamCount / applyTeamCount, lifted verbatim from annotate.js and
// driven with BOTH platforms' data shapes. Sleeper is the reference
// implementation, so its cases are regression tests first and foremost.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/Sam/ff-advisor/extension/annotate.js', 'utf8');
const body = src.slice(src.indexOf('function observedTeamCount'), src.indexOf('// ── Draft context'));
const state = { lineup: { teams: 10 } };
const { observedTeamCount, applyTeamCount } = new Function('state', 'computeReplacement',
  body + '; return {observedTeamCount, applyTeamCount};')(state, () => {});

let fail = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) fail++; console.log(`${p?'PASS':'FAIL'}  ${l}: ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

// ── ESPN: team_id, from the real captured arrival order (8-team snake) ──
const ESPN = ['8','1','2','3','7','5','5','7','3','2','1','8','6','4','4','6','8','1','2','3'];
ok('ESPN capture -> 8', observedTeamCount(ESPN), 8);
ok('ESPN partial round withholds', observedTeamCount(ESPN.slice(0,6)), null);
ok('ESPN once every team seen -> 8', observedTeamCount(ESPN.slice(0,14)), 8);

// ── Sleeper: draft_slot is a NUMBER, not a string — must not double-count ──
const snake = (teams, rounds) => { const out = [];
  for (let r = 0; r < rounds; r++) { const o = Array.from({length: teams}, (_, i) => i + 1);
    out.push(...(r % 2 ? o.reverse() : o)); } return out; };
ok('Sleeper 12-team numeric slots -> 12', observedTeamCount(snake(12, 3)), 12);
ok('Sleeper 10-team -> 10', observedTeamCount(snake(10, 2)), 10);
ok('Sleeper mixed number/string keys do not double-count',
   observedTeamCount([1, '1', 2, '2', 3, '3', 4, '4', 1, 2, 3, 4]), 4);
ok('Sleeper round 1 only (no cycle) withholds', observedTeamCount(snake(12, 1)), null);
ok('Sleeper linear draft (same order each round) -> 12',
   observedTeamCount([...Array(12).keys()].map(i=>i+1).concat([...Array(12).keys()].map(i=>i+1))), 12);

// ── Robustness ──
ok('empty feed withholds', observedTeamCount([]), null);
ok('nulls / blanks ignored', observedTeamCount([null, '', undefined, 1, 2, 3, 4, 1]), 4);
ok('3 teams is below the floor', observedTeamCount([1,2,3,1,2,3]), null);
ok('sparse slots (a team never picked) counts only who appeared',
   observedTeamCount([1,2,4,5,1,2,4,5]), 4);

// ── applyTeamCount: only overrides on a real disagreement ──
state.lineup.teams = 10;
ok('adopts observed 8 over configured 10', [applyTeamCount(8), state.lineup.teams], [true, 8]);
ok('no-op when they agree', [applyTeamCount(8), state.lineup.teams], [false, 8]);
ok('no-op on null (not yet confident) — keeps configured',
   [applyTeamCount(null), state.lineup.teams], [false, 8]);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
