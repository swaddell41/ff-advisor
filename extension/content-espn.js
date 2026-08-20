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
  // Inject the page-context tap.
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject-espn.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  const params = new URLSearchParams(window.location.search);
  const leagueId = params.get('leagueId');
  const myTeamId = params.get('teamId');

  const picks = [];               // [{espn_id, team_id, pick_no}]
  const seen = new Set();         // dedupe by espn_id
  const debugFrames = [];         // ring buffer of raw frames
  let publishTimer = null;

  function publish() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      chrome.storage.local.set({
        espnDraft: {
          leagueId,
          myTeamId,
          picks: picks.slice(),
          updatedAt: Date.now(),
        },
        espnDebugFrames: debugFrames.slice(-80),
      });
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

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.source !== 'ffa-espn' || msg.type !== 'ws-frame') return;
    debugFrames.push(`${msg.direction} ${String(msg.data).slice(0, 300)}`);
    if (debugFrames.length > 200) debugFrames.shift();
    if (msg.direction === 'in') parseFrame(msg.data);
    publish();
  });

  // Announce the draft room so the panel switches to ESPN mode even before
  // any picks happen.
  publish();
})();
