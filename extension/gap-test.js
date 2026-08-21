// Missed-pick detection: the case where an outage forces a refresh and
// picks happen while nothing is listening.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/Sam/ff-advisor/extension/annotate.js', 'utf8');
// Lift the live regex out of the source so the test cannot drift from it.
const RE = eval(src.match(/const m = t\.match\((\/.+?\/i)\);/)[1]);
const readPick = (text) => { const m = String(text).match(RE);
  const n = m ? Number(m[1]) : 0; return n > 0 && n < 1000 ? n : null; };
const gap = (domText, known) => { const p = readPick(domText);
  return p ? Math.max(0, (p - 1) - known) : 0; };

let fail = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) fail++; console.log(`${p?'PASS':'FAIL'}  ${l}: ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

// Reading ESPN's counter out of real header text.
ok('reads the live header', readPick('RND 2 OF 17 ON THE CLOCK: PICK 15 Team 8'), 15);
ok('tolerates no space', readPick('ON THE CLOCK:PICK 7'), 7);
ok('case insensitive', readPick('on the clock pick 136'), 136);
// Must never match our OWN UI, which also contains the word "pick".
ok('ignores our star strip', readPick('★ PICK: Brock Bowers 6.6k TE'), null);
ok('ignores our audit header', readPick('Why this pick — pick #15'), null);
ok('no header at all', readPick('Players Board Rules'), null);

// The arithmetic. ESPN reports the pick ON THE CLOCK, so completed = N-1.
const HDR = (n) => `ON THE CLOCK: PICK ${n}`;
ok('in sync -> no gap', gap(HDR(40), 39), 0);
ok('outage lost 4 picks', gap(HDR(40), 35), 4);
ok('first pick, nothing drafted', gap(HDR(1), 0), 0);
ok('we somehow know more -> clamped, never negative', gap(HDR(10), 20), 0);
ok('unreadable header -> cannot check, assume fine', gap('no header', 5), 0);

// A gap must suppress seating even when round 1 itself looks complete:
// the hole may be later in the draft, which corrupts every team roster.
const seated = (r1len, r1uniq, teams, g) => r1len === teams && r1uniq === teams && !g;
ok('clean round 1, no gap -> seats', seated(8, 8, 8, 0), true);
ok('clean round 1 but a known gap -> refuses', seated(8, 8, 8, 3), false);
ok('gap of 1 is still a refusal', seated(8, 8, 8, 1), false);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
