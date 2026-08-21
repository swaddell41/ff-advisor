// Rehydration across a mid-draft refresh. Drives the real content-espn.js
// with a faked chrome.storage + CustomEvent surface.
const fs = require('fs');
const SRC = fs.readFileSync('C:/Users/Sam/ff-advisor/extension/content-espn.js', 'utf8');

function runSession({ leagueId, stored, frames, storedAgeMs = 0 }) {
  let saved = null;
  const listeners = [];
  const chrome = {
    runtime: { id: 'x' },
    storage: { local: {
      get: (keys, cb) => cb(stored ? { espnDraft: stored } : {}),
      set: (o) => { saved = o; },
    } },
  };
  const document = {
    addEventListener: (n, fn) => n === 'ffa-espn-frame' && listeners.push(fn),
  };
  const sandbox = {
    chrome, document,
    window: { location: { search: `?leagueId=${leagueId}&teamId=7` } },
    URLSearchParams, JSON, Date, Set, Object, Number, String, Array, RegExp,
    setTimeout: (fn) => fn(),          // flush the publish debounce
  };
  new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));
  for (const f of frames) {
    listeners.forEach((fn) => fn({ detail: JSON.stringify({ url: 'ws', data: f }) }));
  }
  return saved && saved.espnDraft;
}

let fail = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) fail++; console.log(`${p?'PASS':'FAIL'}  ${l}: ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

// Session 1: fresh draft, three picks observed live.
const s1 = runSession({ leagueId: '1843770352', stored: null, frames: [
  'SELECTED 7 3915416 12\n', 'SELECTED 5 4372016 11\n', 'SELECTED 5 4259545 12\n' ] });
ok('session 1 records 3 picks', s1.picks.length, 3);

// Session 2: THE BUG — refresh mid-draft, two further picks arrive.
const s2 = runSession({ leagueId: '1843770352', stored: s1, frames: [
  'SELECTED 3 4426515 4\n', 'SELECTED 1 4429795 2\n' ] });
ok('history survives the refresh', s2.picks.length, 5);
ok('old picks kept, in order', s2.picks.slice(0,3).map(p=>p.espn_id),
   ['3915416','4372016','4259545']);
ok('new picks appended', s2.picks.slice(3).map(p=>p.espn_id), ['4426515','4429795']);
ok('pick numbers stay dense', s2.picks.map(p=>p.pick_no), [1,2,3,4,5]);
ok('team ids preserved across the boundary', s2.picks.map(p=>p.team_id),
   ['7','5','5','3','1']);

// A pick replayed after the refresh must not double-count.
const s3 = runSession({ leagueId: '1843770352', stored: s1, frames: [
  'SELECTED 5 4259545 12\n', 'SELECTED 3 4426515 4\n' ] });
ok('replayed pick deduped', s3.picks.length, 4);

// A DIFFERENT draft must start clean.
const s4 = runSession({ leagueId: '999999', stored: s1, frames: ['SELECTED 2 4362628 4\n'] });
ok('different leagueId does not inherit history', s4.picks.length, 1);

// Stale state must not leak in.
const stale = Object.assign({}, s1, { updatedAt: Date.now() - 13 * 3600 * 1000 });
const s5 = runSession({ leagueId: '1843770352', stored: stale, frames: ['SELECTED 2 4362628 4\n'] });
ok('state older than 12h is discarded', s5.picks.length, 1);

// No prior state at all behaves exactly as before.
const s6 = runSession({ leagueId: '1843770352', stored: null, frames: ['SELECTED 2 4362628 4\n'] });
ok('no stored state -> unchanged behaviour', s6.picks.length, 1);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
