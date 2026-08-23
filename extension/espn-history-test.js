// ESPN Pick History recovery: parsing the history tab's rows and resolving
// players against the board, so picks missed during an outage in a MOCK
// (where draftDetail is never written) can be rebuilt from the page's own
// record. Lifts the shipped functions verbatim so the test cannot drift.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(path.dirname(__filename), 'annotate.js'), 'utf8');

// Both functions close with the file's first "\n  }" after their start —
// inner blocks close at deeper indentation.
const lift = (name) => {
  const a = src.indexOf('function ' + name);
  if (a < 0) throw new Error(name + ' not found — markers moved');
  const b = src.indexOf('\n  }', a);
  return eval('(' + src.slice(a, b + 4) + ')');
};
const parseCells = lift('parseEspnHistoryCells');
const resolve = lift('resolveHistoryName');

let fail = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) fail++; console.log(`${p?'PASS':'FAIL'}  ${l}: ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

// ── Row recognition and pick numbering (10-team room) ────────────────────
const rows = [
  ['1.01', 'Jahmyr Gibbs', 'RB', 'Det'],       // dotted label, separate cells
  ['1.02', 'Bijan Robinson RB Atl'],           // dotted label, composite cell
  ['R2 P5', 'George Pickens WR Pit'],          // R/P label form
  ['3.04', 'Josh Allen QB Buf'],
  ['77.2', 'a projection, not a pick'],        // round 77 → numerically rejected
  ['1.11', 'pick 11 of a 10-team round'],      // pk > teams → rejected
  ['26', 'a player-list row (rank int)'],      // not a pick label
  ['1.01', 'duplicate pick slot'],             // same pick_no → first wins
  ['on the clock', 'header noise'],
];
const parsed = parseCells(rows, 10, 170);
ok('recognises exactly the pick-labelled rows', parsed.map((r) => r.pick_no), [1, 2, 15, 24]);
ok('dotted label converts through team count', parsed.find((r) => r.pick_no === 24).rest, ['Josh Allen QB Buf']);
ok('R/P label converts identically', parsed.find((r) => r.pick_no === 15).rest, ['George Pickens WR Pit']);
ok('duplicate pick slot keeps the first row', parsed.find((r) => r.pick_no === 1).rest[0], 'Jahmyr Gibbs');
ok('row index survives for headshot-id lookup', parsed.map((r) => r.idx), [0, 1, 2, 3]);
ok('beyond the draft horizon rejected', parseCells([['30.10', 'x']], 10, 170), []);
ok('empty input', parseCells([], 10, 170), []);

// ── Player resolution ────────────────────────────────────────────────────
const BOARD = {
  'jahmyr gibbs': { name: 'Jahmyr Gibbs' },
  'bijan robinson': { name: 'Bijan Robinson' },
  'josh allen': { name: 'Josh Allen' },
  'amon-ra st. brown': { name: 'Amon-Ra St. Brown' },
};
const lookup = (s) => BOARD[String(s).toLowerCase().trim()] || null;
ok('exact cell', resolve(['Jahmyr Gibbs'], lookup).name, 'Jahmyr Gibbs');
ok('composite cell via word prefixes', resolve(['Josh Allen QB Buf'], lookup).name, 'Josh Allen');
ok('separator cell', resolve(['Bijan Robinson · RB · Atl'], lookup).name, 'Bijan Robinson');
ok('hyphenated name is not split apart', resolve(['Amon-Ra St. Brown WR Det'], lookup).name, 'Amon-Ra St. Brown');
ok('unknown name resolves to nothing', resolve(['Mystery Person RB'], lookup), null);
ok('later cell can carry the name', resolve(['RB', 'Josh Allen QB Buf'], lookup).name, 'Josh Allen');
// The recognition gate is numeric; the resolution gate is the board. A
// stat-shaped first cell ("5.8") only becomes a pick if some other cell
// uniquely names a board player — which stats tables do not.
ok('stat-shaped row dies at resolution', resolve(['52.4 pts', 'projected'], lookup), null);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
