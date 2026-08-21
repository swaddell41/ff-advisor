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
  const PICKISH = /SELECT|PICK|DRAFT|ROSTER|PLAYER/;

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

  function recordPick(espnId, teamId, pickNo) {
    const key = String(espnId);
    if (seen.has(key)) return;
    seen.add(key);
    picks.push({
      espn_id: key,
      team_id: teamId != null ? String(teamId) : null,
      pick_no: pickNo != null ? Number(pickNo) : picks.length + 1,
    });
    publish();
  }

  /**
   * Defensive frame parsing.
   *
   * Primary pattern: token frames like "SELECTED <teamId> <playerId> ..."
   * Heuristics for token roles when order is uncertain:
   *   - playerId: the numerically largest int (ESPN ids are 4-8 digits;
   *     team ids are tiny; pick numbers are <= ~400)
   *   - teamId:   smallest int <= 64
   *   - pickNo:   an int between 1 and 600 that isn't the team id
   * Also handles JSON frames containing playerId/teamId fields, just in
   * case ESPN modernized the protocol.
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
    if (!cmd.includes('SELECT')) return; // SELECTED / AUTOSELECTED etc.

    const ints = tokens
      .slice(1)
      .map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : null))
      .filter((n) => n !== null);
    if (!ints.length) return;

    const playerId = Math.max(...ints);
    if (playerId < 1000) return; // no plausible player id in this frame
    const small = ints.filter((n) => n !== playerId);
    const teamId = small.find((n) => n >= 1 && n <= 64);
    const pickNo = small.find((n) => n !== teamId && n >= 1 && n <= 600);
    recordPick(playerId, teamId, pickNo);
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

  document.addEventListener('ffa-espn-frame', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.detail); } catch (_) { return; }
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
  });

  // Announce the draft room so the panel switches to ESPN mode even before
  // any picks happen.
  publish();
})();
