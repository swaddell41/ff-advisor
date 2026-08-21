// Reproduces the Sleeper regression: a row containing MORE THAN ONE player.
// Models the old (v0.4.5) and new reconciliation side by side.
const mkBadge = (p) => ({ __ffaPlayer: p, dropped: false });
const P = (id, name) => ({ player_id: id, name });

function makeRow(players, badges) {
  return { players, badges,
    get textContent() { return this.players.map((x) => x.name).join(' '); },
    querySelectorAll() { return this.badges.filter((b) => !b.dropped); } };
}

// OLD: anything that is not the first match for THIS player gets dropped.
function scanOld(row, p) {
  let reused = false;
  for (const b of row.querySelectorAll()) {
    const bp = b.__ffaPlayer;
    if (!reused && bp && String(bp.player_id) === String(p.player_id)) { reused = true; }
    else { b.dropped = true; }
  }
  return reused;
}
// NEW: a different player's badge is stale only if that player is no longer
// named in the row — which is exactly what a recycled row looks like.
function scanNew(row, p) {
  let reused = false;
  const rowText = row.textContent || '';
  for (const b of row.querySelectorAll()) {
    const bp = b.__ffaPlayer;
    if (!bp) { b.dropped = true; continue; }
    if (String(bp.player_id) === String(p.player_id)) {
      if (reused) b.dropped = true; else reused = true;
      continue;
    }
    if (!rowText.includes(bp.name)) b.dropped = true;
  }
  return reused;
}

let fail = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) fail++; console.log(`${p?'PASS':'FAIL'}  ${l}: ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

const A = P('1','Justin Jefferson'), B = P('2','CeeDee Lamb'), C = P('3','Ja\'Marr Chase');

// SLEEPER SHAPE: one row, three players, each with a badge.
const alive = (row) => row.badges.filter((b) => !b.dropped).length;
const oldRow = makeRow([A,B,C], [mkBadge(A), mkBadge(B), mkBadge(C)]);
scanOld(oldRow, A);
ok('OLD: scanning one player nukes the others (the regression)', alive(oldRow), 1);

const newRow = makeRow([A,B,C], [mkBadge(A), mkBadge(B), mkBadge(C)]);
scanNew(newRow, A); scanNew(newRow, B); scanNew(newRow, C);
ok('NEW: all three survive a multi-player row', alive(newRow), 3);

// ESPN SHAPE: the recycled row this logic exists to fix must still work.
const recycled = makeRow([B], [mkBadge(A), mkBadge(B)]);  // A left over from before
ok('NEW: reuses the badge for the current player', scanNew(recycled, B), true);
ok('NEW: stale badge from a recycled row is dropped', alive(recycled), 1);
ok('NEW: the survivor is the right player', recycled.badges.find(b=>!b.dropped).__ffaPlayer.name, 'CeeDee Lamb');

// DUPLICATE: the original bug — same player badged twice in one row.
const dup = makeRow([A], [mkBadge(A), mkBadge(A)]);
scanNew(dup, A);
ok('NEW: duplicate for the same player collapses to one', alive(dup), 1);

// A badge with no player attached is always junk.
const orphan = makeRow([A], [{ __ffaPlayer: null, dropped: false }, mkBadge(A)]);
scanNew(orphan, A);
ok('NEW: orphaned badge dropped', alive(orphan), 1);

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
