// Architecture contract test. The design rule: ONE shared decision engine;
// platforms differ only in (a) how league settings / picks are ingested and
// (b) how results are rendered into each site's DOM. This test makes the
// rule executable, because every past drift (missing teams observation,
// missing myQBLate, implicit mode) was an adapter silently not honouring
// the engine's input contract.
const fs = require('fs');
const path = require('path');
const dir = path.dirname(__filename);
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const src = read('annotate.js');

let fail = 0;
const ok = (label, pass, detail) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : ' — ' + detail}`);
};

// Slice a region by function boundaries so line numbers can't go stale.
const between = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker); const b = src.indexOf(endMarker, a + 1);
  if (a < 0 || b < 0) return null;
  return src.slice(a, b);
};
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// 1. The engine is platform-blind. From the first scoring helper to the
//    scheduler, no executable line may mention a platform.
const engine = between('function needMult', 'function scheduleScan');
ok('engine region found', !!engine, 'markers moved — update the test');
if (engine) {
  const code = stripComments(engine);
  const hits = code.match(/sleeper|espn/gi) || [];
  ok('engine has zero platform branches', hits.length === 0,
     `found ${hits.length}: ${[...new Set(hits)].join(',')}`);
}

// 2. Both adapters populate the engine's full input contract.
const CONTRACT = ['format', 'lineup', 'pickedIds', 'myCounts', 'mySlot',
                  'slotCounts', 'draftType', 'myQBLate', 'mode'];
const sleeperAdapter = between('async function detectSleeperDraft', 'async function watchEspnPicks');
const espnAdapter = between('async function watchEspnPicks', 'function setCurrentPick');
for (const [name, region] of [['sleeper', sleeperAdapter], ['espn', espnAdapter]]) {
  ok(`${name} adapter found`, !!region, 'markers moved — update the test');
  if (!region) continue;
  for (const field of CONTRACT) {
    // Plain includes, not a constructed RegExp: heredoc-written files in
    // this environment lose a backslash level, which once turned this
    // check into the regex state.formats*= and failed all 18 fields.
    ok(`${name} adapter sets state.${field}`,
       region.includes('state.' + field + ' ='),
       'engine input never populated on this platform');
  }
  // currentPick flows through the shared setter, not direct writes.
  ok(`${name} adapter drives currentPick via setCurrentPick()`,
     /setCurrentPick\(/.test(region), 'currentPick not driven');
}

// 3. Rendering surfaces hold no decision logic. If any of these tokens
//    appears outside annotate.js, someone forked the engine.
const ENGINE_TOKENS = /needMult|simulateRoom|worstCaseAtNext|expectedNextBest|computeReplacement|nextMyPickInfo|interveningSlots/;
for (const f of ['panel.js', 'overlay.js', 'content.js', 'content-espn.js', 'background.js']) {
  ok(`${f} contains no engine logic`, !ENGINE_TOKENS.test(read(f)), 'engine fork detected');
}

// 4. Exactly one recommend() definition — the single decision entry point.
const defs = (src.match(/function recommend\(/g) || []).length;
ok('exactly one recommend() definition', defs === 1, `found ${defs}`);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
