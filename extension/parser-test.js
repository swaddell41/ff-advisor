// Replays the exact frames captured live (league 1356040896) through the
// rewritten parser, asserting against the snake order reconstructed from them.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/Sam/ff-advisor/extension/content-espn.js', 'utf8');

// Lift parseFrame + recordPick out of the IIFE so we can drive them directly.
const picks = [], seen = new Set();
const body = src.slice(src.indexOf('function recordPick'), src.indexOf('function scanJson'));
const mod = new Function('picks', 'seen', 'publish', body + '; return {parseFrame, recordPick};')
  (picks, seen, () => {});

const FRAMES = [
  "SELECTED 8 4426348 1\n",  "SELECTING 1 30000\n",
  "SELECTED 1 4429795 2\n",  "SELECTING 2 30000\n",
  "SELECTED 2 4362628 4\n",  "SELECTING 3 30000\n",
  "SELECTED 3 4426515 4\n",  "SELECTING 7 30000\n",
  "SELECTED 7 4430807 2 {5CCE998B-D9EE-4E34-8E99-8BD9EE7E3414}\n", "SELECTING 5 30000\n",
  "SELECTED 5 4430878 4\n",  "SELECTING 5 30000\n",
  "SELECTED 5 4040715 1\n",  "SELECTING 7 30000\n",
  "SELECTED 7 3117251 3 {5CCE998B-D9EE-4E34-8E99-8BD9EE7E3414}\n", "SELECTING 3 30000\n",
  "SELECTED 3 4241389 5\n",  "SELECTING 2 30000\n",
  "SELECTED 2 4242335 2\n",  "SELECTING 1 30000\n",
  "SELECTED 1 4429160 3\n",  "SELECTING 8 30000\n",
  "SELECTED 8 4431452 8\n",  "SELECTING 6 30000\n",
  "SELECTED 6 4374302 4\n",  "SELECTING 4 30000\n",
  "SELECTED 4 3915511 8\n",  "SELECTING 4 30000\n",
  "SELECTED 4 4426502 4\n",  "SELECTING 6 30000\n",
  "SELECTED 6 4379399 2\n",  "SELECTING 8 30000\n",
  "SELECTED 8 4262921 4\n",  "SELECTING 1 30000\n",
  "SELECTED 1 4689114 1\n",  "SELECTING 2 30000\n",
  "SELECTED 2 4428331 5\n",  "SELECTING 3 30000\n",
  "SELECTED 3 4361307 6\n",  "SELECTING 7 30000\n",
  // Noise that must never register a pick:
  "AUTOSUGGEST 4426348\n", "CLOCK 0 26251\n", "AUTODRAFT 7 false\n",
  "JOINED 7 {5CCE998B-D9EE-4E34-8E99-8BD9EE7E3414}\n",
  "TOKEN 1:1790779115:7:{5CCE998B-D9EE-4E34-8E99-8BD9EE7E3414}:1265301395\n",
  "PONG PING%201787317546151\n",
];
FRAMES.forEach((f) => mod.parseFrame(f));

let fail = 0;
const ok = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${pass ? '' : ' want ' + JSON.stringify(want)}`);
};

ok('no phantom: 30000 never recorded', picks.some(p => p.espn_id === '30000'), false);
ok('20 SELECTED frames -> 20 picks', picks.length, 20);
ok('pick_no is dense 1..20', picks.map(p => p.pick_no), Array.from({length:20},(_,i)=>i+1));
ok('teams read positionally', picks.slice(0,5).map(p => p.team_id), ['8','1','2','3','7']);
ok('memberId token ignored (team 7 pick intact)',
   picks.find(p => p.espn_id === '4430807'), {espn_id:'4430807', team_id:'7', pick_no:5});
ok('n==teamId no longer invents a number (SELECTED 2 4242335 2)',
   picks.find(p => p.espn_id === '4242335').pick_no, 10);

// The capture begins MID-ROUND (the ring buffer kept only the last 40
// frames), so pick_no 1..20 is an arrival sequence, not true overall pick
// numbers. Assert the snake structurally instead: picks 7-14 are one
// complete round, and the rounds either side are its mirror.
const t = picks.map((p) => p.team_id);
const mid = t.slice(6, 14);                 // one full round of 8
ok('picks 7-14 are a complete round (8 distinct teams)',
   [...new Set(mid)].length, 8);
ok('the round order', mid, ['5','7','3','2','1','8','6','4']);
const mirror = mid.slice().reverse();       // 4,6,8,1,2,3,7,5
ok('picks 15-20 are the head of the mirrored round', t.slice(14, 20), mirror.slice(0, 6));
ok('picks 1-6 are the tail of the mirrored round', t.slice(0, 6), mirror.slice(2));
ok('turn: team 5 picks back-to-back at the boundary', [t[5], t[6]], ['5','5']);
ok('turn: team 4 picks back-to-back at the boundary', [t[13], t[14]], ['4','4']);

// Consequence of a mid-round join: the seating guard MUST refuse, because
// arrival-order pick 1..8 straddles a round boundary and repeats a team.
ok('mid-join is detected: first 8 arrivals are not 8 distinct teams',
   [...new Set(t.slice(0, 8))].length !== 8, true);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
