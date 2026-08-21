/**
 * Content script for ESPN draft rooms (real leagues AND the mock lobby).
 *
 * - Injects the WebSocket tap into the page context.
 * - Parses pick events out of the relayed frames — defensively, since the
 *   protocol is undocumented. Known shape (community-observed): text frames
 *   of space-separated tokens starting with a command word, picks announced
 *   with "SELECTED" carrying teamId, playerId and pick number.
 * - Publishes state to chrome.storage.local so the side panel renders it.
 * - Keeps a ring buffer of raw frames (espnDebugFrames) so a mock draft can
 *   calibrate the parser if ESPN's format differs from expectations.
 */

(function () {
  // The WebSocket tap (inject-espn.js) runs as a MAIN-world content script
  // declared in the manifest — synchronously, before any page code, so
  // sockets opened early are still wrapped.

  const params = new URLSearchParams(window.location.search);
  const leagueId = params.get('leagueId');
  const myTeamId = params.get('teamId');

  const picks = [];               // [{espn_id, team_id, pick_no}]
  const seen = new Set();         // dedupe by espn_id
  const debugFrames = [];         // ring buffer of raw frames (noise filtered)
  const pickFrames = [];          // frames whose command word looks pick-ish
  const cmdSeen = Object.create(null); // command word -> count
  let framesSeen = 0;             // total WS frames observed (diagnostic)
  let oversize = 0;               // frames the relay dropped for being too big
  let publishTimer = null;

  // Frames that must never reach the debug ring. ESPN sends CLOCK roughly
  // every 5s plus PONG heartbeats, and multiplexes Disney Streaming edge
  // events (delivery receipts) over the same socket. At 80 slots that
  // traffic evicts a pick frame within about a minute, which is why the
  // first live export came back with no SELECTED frames in it at all.
  const NOISE_CMD = /^(CLOCK|PONG|PING|AUTOSUGGEST|TOKEN)$/;

  // Deliberately broad: we do not yet know ESPN's real command word for a
  // pick, so capture anything plausibly related into a ring that the noise
  // filter can never flush.
  const PICKISH = /SELECT|PICK|DRAFT|ROSTER|PLAYER|STATE|INIT/;

  function publish() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      try { chrome.runtime && chrome.runtime.id; } catch (_) { return; }
      try {
        chrome.storage.local.set({
        espnDraft: {
          leagueId,
          myTeamId,
          picks: picks.slice(),
          framesSeen,
          oversize,
          updatedAt: Date.now(),
        },
        espnDebugFrames: debugFrames.slice(-80),
        // Survives noise: whatever ESPN actually calls a pick lands here.
        espnPickFrames: pickFrames.slice(-40),
        // Census of every command word seen. Cheap protocol discovery — it
        // names the pick command even if we never catch its payload.
        espnCmdWords: Object.assign({}, cmdSeen),
      });
      } catch (_) { /* orphaned after extension reload */ }
    }, 250);
  }

  function recordPick(espnId, teamId) {
    const key = String(espnId);
    if (seen.has(key)) return;
    seen.add(key);
    picks.push({
      espn_id: key,
      team_id: teamId != null ? String(teamId) : null,
      // Overall pick number from ARRIVAL ORDER — the only trustworthy
      // source. The frame's trailing token is not a pick number; see
      // parseFrame. Caveat: picks that happened before we connected arrive
      // via STATE, not SELECTED, so a mid-draft join undercounts until
      // that frame is parsed too.
      pick_no: picks.length + 1,
    });
    publish();
  }

  /**
   * ESPN's draft protocol, captured live from a mock (league 1356040896):
   *
   *   SELECTED  <teamId> <playerId> <n> [memberId]   a pick
   *   SELECTING <teamId> 30000                       team is on the clock
   *   AUTOSUGGEST <playerId>                         what autopick would take
   *   CLOCK 0 <msRemaining>                          pick timer
   *   INIT / STATE / JOINED / TOKEN / AUTODRAFT / PONG
   *
   * memberId is present only on the logged-in user's own picks.
   *
   * Two things the original heuristic parser got wrong, both fixed here:
   *
   * 1. cmd.includes('SELECT') also matches SELECTING, whose 30000 (the
   *    pick clock in ms) became Math.max(...ints) and was recorded as a
   *    player id. That was the phantom pick. Match SELECTED exactly.
   *
   * 2. The trailing <n> is NOT a pick number and NOT a round. Across a
   *    captured round it varies per pick — team 8 reported 1, then 8, then
   *    4 on consecutive turns — so its meaning is unknown. Worse, when it
   *    happened to equal the team id ("SELECTED 2 4242335 2") the old
   *    `find(n => n !== teamId)` returned undefined and silently fell back
   *    to picks.length + 1, inventing pick numbers that were never real.
   *
   * Pick order therefore comes from frame ARRIVAL order, which is
   * authoritative: the capture reconstructed a clean 8-team snake from it.
   * Tokens are read positionally now rather than by size heuristics.
   */
  function parseFrame(text) {
    if (!text) return;

    // JSON shape
    if (text[0] === '{' || text[0] === '[') {
      try {
        const obj = JSON.parse(text);
        scanJson(obj);
      } catch (_) { /* not JSON after all */ }
      return;
    }

    const tokens = text.trim().split(/\s+/);
    const cmd = (tokens[0] || '').toUpperCase();
    // Exactly SELECTED (or AUTOSELECTED, unobserved but cheap to allow) —
    // NOT a substring test, which swallowed SELECTING.
    if (!/^(AUTO)?SELECTED$/.test(cmd)) return;

    const teamId = /^\d+$/.test(tokens[1] || '') ? tokens[1] : null;
    const playerId = /^\d+$/.test(tokens[2] || '') ? tokens[2] : null;
    // Positional, not "largest int wins". A player id is 4-7 digits; the
    // floor keeps a malformed frame from registering a junk pick.
    if (!playerId || Number(playerId) < 1000) return;
    recordPick(playerId, teamId);
  }

  function scanJson(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(scanJson); return; }
    const pid = obj.playerId || obj.player_id;
    if (pid) {
      recordPick(pid, obj.teamId ?? obj.team_id ?? null, obj.overallPickNumber ?? obj.pickNumber ?? null);
    }
    Object.values(obj).forEach((v) => { if (v && typeof v === 'object') scanJson(v); });
  }

  function handleFrame(detail) {
    let msg;
    try { msg = JSON.parse(detail); } catch (_) { return; }
    if (msg && msg.oversize) { oversize += 1; publish(); return; }
    if (!msg || typeof msg.data !== 'string') return;
    framesSeen += 1;

    const text = msg.data;
    const isJson = text[0] === '{' || text[0] === '[';
    const cmd = isJson ? '<json>' : (text.trim().split(/\s+/)[0] || '').toUpperCase();
    cmdSeen[cmd] = (cmdSeen[cmd] || 0) + 1;

    // Disney edge events are JSON but never draft data.
    const dss = isJson && text.indexOf('"urn:dss:') !== -1;
    if (!isJson && PICKISH.test(cmd)) {
      pickFrames.push(text.slice(0, 1000));
      if (pickFrames.length > 80) pickFrames.shift();
    }
    if (!NOISE_CMD.test(cmd) && !dss) {
      // 1000 not 300: the old cap truncated JSON frames mid-object, which
      // hid whatever fields came after the first ~300 characters.
      debugFrames.push(`in ${text.slice(0, 1000)}`);
      if (debugFrames.length > 200) debugFrames.shift();
    }

    parseFrame(text);
    publish();
  }

  // Rehydrate the previous session's picks BEFORE processing any frame.
  //
  // The tap only ever sees picks made after it connects, so without this a
  // refresh or an extension reload mid-draft drops the entire pick history
  // and the board shows already-drafted players as available for the rest
  // of the draft.
  //
  // This is the only source that works for a MOCK: ESPN's draftDetail API
  // is never written to by a practice draft (it reports the parent
  // league's real, unstarted draft — every slot playerId -1), and the INIT
  // frame that does carry live state is an opaque base64 binary blob. We
  // already observed every pick; the only thing missing was remembering.
  //
  // Scoped to the same leagueId so joining a different draft starts clean,
  // and time-boxed so a stale draft from days ago cannot leak in.
  let hydrated = false;
  const pending = [];

  function hydrate(done) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return done();
      chrome.storage.local.get(['espnDraft'], (v) => {
        try {
          const prev = v && v.espnDraft;
          const FRESH_MS = 12 * 3600 * 1000;
          if (prev && String(prev.leagueId) === String(leagueId)
              && Array.isArray(prev.picks)
              && Date.now() - (prev.updatedAt || 0) < FRESH_MS) {
            for (const p of prev.picks) {
              const key = String(p.espn_id);
              if (!key || seen.has(key)) continue;
              seen.add(key);
              picks.push({
                espn_id: key,
                team_id: p.team_id != null ? String(p.team_id) : null,
                pick_no: picks.length + 1,
              });
            }
          }
        } catch (_) { /* corrupt stored state must not block the draft */ }
        done();
      });
    } catch (_) { done(); }
  }

  // Frames arriving before hydration finishes are queued, not dropped:
  // storage is async but the socket is not, and a pick landing in that
  // window would otherwise be lost or ordered ahead of the history.
  document.addEventListener('ffa-espn-frame', (ev) => {
    if (!hydrated) { pending.push(ev.detail); return; }
    handleFrame(ev.detail);
  });

  hydrate(() => {
    hydrated = true;
    for (const d of pending.splice(0)) handleFrame(d);
    publish();
  });

  // Announce the draft room so the panel switches to ESPN mode even before
  // any picks happen.
  publish();
})();
