/**
 * Draft assistant side panel — Sleeper + ESPN.
 *
 * Sleeper: draft settings + live picks from the public API (polled).
 * ESPN:    picks arrive via chrome.storage, written by the content script
 *          that taps the draft room's WebSocket. Player matching runs
 *          through the espn_id on each board row.
 *
 * Board: ff-advisor API, fetched once per mode/format, filtered client-side.
 *
 * Test modes (plain web page):
 *   panel.html?draft=<sleeper_draft_id>          — real Sleeper draft
 *   panel.html?espn_sim=30                       — simulate an ESPN draft
 *   &api=http://localhost:8000                   — local backend
 */

const API_BASE =
  new URLSearchParams(location.search).get('api') ||
  'https://ff-advisor-sam-waddells-projects.vercel.app';
const SLEEPER = 'https://api.sleeper.app';
const POLL_MS = 4000;

const isExt = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

const state = {
  platform: null,       // 'sleeper' | 'espn'
  draftId: null,
  draft: null,          // Sleeper draft object
  board: null,
  espnMap: null,        // espn_id -> board player
  picks: [],            // sleeper picks (raw) — sleeper mode only
  espn: null,           // {picks:[{espn_id,team_id,pick_no}], myTeamId}
  espnUnmatched: 0,
  pickedIds: new Set(),
  mode: 'redraft',
  format: 'sf_ppr',
  tab: 'ALL',
  username: null,
  myUserId: null,
};

const $ = (id) => document.getElementById(id);

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  const qs = new URLSearchParams(location.search);
  const urlDraft = qs.get('draft');
  const espnSim = qs.get('espn_sim');

  if (espnSim) {
    await connectEspnSim(parseInt(espnSim, 10) || 24);
  } else if (urlDraft) {
    connectSleeper(urlDraft);
  } else if (isExt) {
    chrome.storage.local.get(['draftId', 'draftIdSetAt', 'username', 'espnDraft'], (v) => {
      if (v.username) {
        state.username = v.username;
        $('username-input').value = v.username;
        resolveUser(v.username);
      }
      const espnFresh =
        v.espnDraft && Date.now() - (v.espnDraft.updatedAt || 0) < 6 * 3600 * 1000;
      const espnNewer = espnFresh && (v.espnDraft.updatedAt || 0) > (v.draftIdSetAt || 0);
      if (espnNewer || (espnFresh && !v.draftId)) connectEspn(v.espnDraft);
      else if (v.draftId) connectSleeper(v.draftId);
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.draftId && changes.draftId.newValue !== state.draftId) {
        connectSleeper(changes.draftId.newValue);
      }
      if (changes.espnDraft && changes.espnDraft.newValue) {
        const d = changes.espnDraft.newValue;
        if (state.platform !== 'espn') connectEspn(d);
        else updateEspn(d);
      }
    });
  }

  $('connect').addEventListener('click', () => {
    const raw = $('draft-input').value.trim();
    const m = raw.match(/(\d{10,})/);
    if (m) connectSleeper(m[1]);
  });
  $('save-user').addEventListener('click', () => {
    const u = $('username-input').value.trim();
    if (!u) return;
    state.username = u;
    if (isExt) chrome.storage.local.set({ username: u });
    resolveUser(u);
  });
  $('mode-toggle').addEventListener('change', async (e) => {
    state.mode = e.target.checked ? 'dynasty' : 'redraft';
    await loadBoard();
    refreshPickedIds();
    render();
  });
  $('sf-toggle').addEventListener('change', async (e) => {
    state.format = e.target.checked ? 'sf_ppr' : '1qb_ppr';
    if (isExt) { try { chrome.storage.local.set({ espnSF: e.target.checked }); } catch (_) {} }
    await loadBoard();
    refreshPickedIds();
    render();
  });
  // One click, everything. Which DevTools window happens to be open should
  // never decide whether a bug can be diagnosed: the page console has no
  // chrome.storage, the service worker console has no document, and picking
  // the wrong one produces a confusing TypeError mid-draft.
  $('copy-debug').addEventListener('click', () => {
    if (!isExt) return;
    const KEYS = ['espnDraft', 'espnBackfillInfo', 'espnCmdWords',
                  'espnPickFrames', 'espnDebugFrames'];
    chrome.storage.local.get(KEYS, (v) => {
      const frames = v.espnPickFrames || [];
      const out = {
        version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || null,
        espnDraft: v.espnDraft || null,
        espnBackfillInfo: v.espnBackfillInfo || null,
        espnCmdWords: v.espnCmdWords || null,
        // Separated out: these answer a mid-draft join, and pick traffic
        // buries them fast.
        stateFrames: frames.filter((f) => /^(STATE|INIT)/i.test(f)),
        pickFrames: frames.slice(-25),
        debugFrames: (v.espnDebugFrames || []).slice(-25),
      };
      navigator.clipboard.writeText(JSON.stringify(out, null, 2));
      $('copy-debug').textContent = 'copied!';
      setTimeout(() => ($('copy-debug').textContent = 'copy diagnostics'), 1500);
    });
  });
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.pos;
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
      render();
    })
  );
}

async function resolveUser(username) {
  try {
    const r = await fetch(`${SLEEPER}/v1/user/${encodeURIComponent(username)}`);
    const u = await r.json();
    state.myUserId = u && u.user_id ? String(u.user_id) : null;
  } catch {
    state.myUserId = null;
  }
  render();
}

let boardLoadedAt = 0;

async function loadBoard() {
  const r = await fetch(`${API_BASE}/api/draftboard?format=${state.format}&mode=${state.mode}`);
  state.board = await r.json();
  boardLoadedAt = Date.now();
  state.espnMap = new Map();
  for (const p of state.board.players) {
    if (p.espn_id) state.espnMap.set(String(p.espn_id), p);
  }
}

// A panel left open across hours should pick up the daily value/player
// refresh without a reconnect.
setInterval(async () => {
  if (!state.board || Date.now() - boardLoadedAt < 60 * 60 * 1000) return;
  try {
    await loadBoard();
    refreshPickedIds();
    render();
  } catch (_) { /* keep the stale board rather than blanking */ }
}, 10 * 60 * 1000);

// ── Sleeper mode ────────────────────────────────────────────────────────────

let pollTimer = null;

async function connectSleeper(draftId) {
  state.platform = 'sleeper';
  state.draftId = draftId;
  state.espn = null;
  $('copy-debug').hidden = !isExt;
  $('status').textContent = 'connecting…';
  try {
    const r = await fetch(`${SLEEPER}/v1/draft/${draftId}`);
    if (!r.ok) throw new Error('draft not found');
    state.draft = await r.json();
  } catch (e) {
    $('status').textContent = 'draft not found';
    return;
  }

  const s = state.draft.settings || {};
  const scoring = (state.draft.metadata && state.draft.metadata.scoring_type) || '';
  const sf = (s.slots_super_flex || 0) > 0 || scoring.includes('2qb');
  const dynasty = scoring.includes('dynasty');
  state.format = sf ? 'sf_ppr' : '1qb_ppr';
  state.mode = dynasty ? 'dynasty' : 'redraft';
  $('mode-toggle').checked = state.mode === 'dynasty';
  $('sf-toggle').checked = sf;

  $('meta').hidden = false;
  $('draft-meta').textContent =
    `Sleeper · ${s.teams || '?'} tm · ${s.rounds || '?'} rds · ${sf ? 'SF' : '1QB'} · ${state.draft.type || ''}`;

  await loadBoard();
  await pollSleeper();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollSleeper, POLL_MS);
}

async function pollSleeper() {
  if (state.platform !== 'sleeper' || !state.draftId) return;
  try {
    const r = await fetch(`${SLEEPER}/v1/draft/${state.draftId}/picks`);
    state.picks = (await r.json()) || [];
    state.pickedIds = new Set(state.picks.map((p) => String(p.player_id)));
    const total = (state.draft.settings.teams || 0) * (state.draft.settings.rounds || 0);
    const st = state.draft.status;
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    // The live heartbeat proves polling is alive even between picks.
    $('status').textContent =
      `pick ${state.picks.length + 1}${total ? '/' + total : ''}` +
      (st && st !== 'drafting' ? ` · ${st}` : '') +
      ` · ✓ ${hh}:${mm}:${ss}`;
    render();
  } catch (e) {
    $('status').textContent = 'poll failed — retrying';
  }
}

// ── ESPN mode ───────────────────────────────────────────────────────────────

async function connectEspn(espnDraft) {
  state.platform = 'espn';
  state.draft = null;
  if (pollTimer) clearInterval(pollTimer);
  $('copy-debug').hidden = !isExt;

  // Restore the persisted SF preference before deciding the format.
  if (isExt) {
    try {
      await new Promise((res) => chrome.storage.local.get(['espnSF'], (v) => {
        if (v.espnSF !== undefined) $('sf-toggle').checked = !!v.espnSF;
        res();
      }));
    } catch (_) {}
  }
  state.format = $('sf-toggle').checked ? 'sf_ppr' : '1qb_ppr';
  state.mode = $('mode-toggle').checked ? 'dynasty' : 'redraft';

  $('meta').hidden = false;
  await loadBoard();
  updateEspn(espnDraft);
}

function updateEspn(espnDraft) {
  state.espn = espnDraft;
  refreshPickedIds();
  const n = espnDraft.picks.length;
  const frames = espnDraft.framesSeen || 0;
  $('draft-meta').textContent =
    `ESPN${espnDraft.leagueId ? ' · league ' + espnDraft.leagueId : ''} · ${$('sf-toggle').checked ? 'SF' : '1QB'}`;
  // Diagnostic-rich status: distinguishes "socket tap sees nothing" from
  // "frames arrive but the parser doesn't recognize picks".
  let diag;
  if (n > 0) {
    diag = `pick ${n + 1}` + (state.espnUnmatched ? ` · ${state.espnUnmatched} unmatched` : '');
  } else if (frames > 0) {
    diag = `${frames} frames seen, no picks parsed yet — if picks have happened, copy debug frames`;
  } else {
    diag = 'connected · no draft traffic seen yet (refresh the ESPN tab if the draft already started)';
  }
  $('status').textContent = diag;
  render();
}

function refreshPickedIds() {
  if (state.platform === 'espn' && state.espn && state.espnMap) {
    state.pickedIds = new Set();
    state.espnUnmatched = 0;
    for (const p of state.espn.picks) {
      const match = state.espnMap.get(String(p.espn_id));
      if (match) state.pickedIds.add(String(match.player_id));
      else state.espnUnmatched += 1;
    }
  } else if (state.platform === 'sleeper') {
    state.pickedIds = new Set(state.picks.map((p) => String(p.player_id)));
  }
}

// Offline ESPN simulation: fabricate a draft from the board's own top rows.
async function connectEspnSim(nPicks) {
  state.format = '1qb_ppr';
  state.mode = 'redraft';
  await loadBoard();
  const withEspn = state.board.players.filter((p) => p.espn_id);
  const picks = withEspn.slice(0, nPicks).map((p, i) => ({
    espn_id: String(p.espn_id),
    team_id: String((i % 10) + 1),
    pick_no: i + 1,
  }));
  await connectEspn({ leagueId: 'SIM', myTeamId: '3', picks, updatedAt: Date.now() });
}

// ── Rendering ───────────────────────────────────────────────────────────────

const POS_TARGETS = { QB: 2, RB: 5, WR: 5, TE: 2 };

function currentPickNumber() {
  if (state.platform === 'espn') return (state.espn ? state.espn.picks.length : 0) + 1;
  return state.picks.length + 1;
}

function render() {
  renderMyRoster();
  renderBoard();
}

function myPickEntries() {
  if (state.platform === 'espn') {
    if (!state.espn || !state.espn.myTeamId) return null;
    return state.espn.picks
      .filter((p) => p.team_id === String(state.espn.myTeamId))
      .map((p) => {
        const match = state.espnMap && state.espnMap.get(String(p.espn_id));
        return { name: match ? match.name : `espn:${p.espn_id}`, pos: match ? match.position : '?' };
      });
  }
  if (!state.myUserId || !state.picks.length) return null;
  return state.picks
    .filter((p) => String(p.picked_by) === state.myUserId)
    .map((p) => {
      const meta = p.metadata || {};
      return {
        name: `${meta.first_name ? meta.first_name[0] + '. ' : ''}${meta.last_name || p.player_id}`,
        pos: meta.position || '?',
      };
    });
}

function renderMyRoster() {
  const box = $('my-roster');
  const mine = myPickEntries();
  if (!mine || !mine.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const counts = {};
  $('my-picks').innerHTML = mine
    .map((p) => {
      counts[p.pos] = (counts[p.pos] || 0) + 1;
      return `<span class="chip">${p.name} <span class="muted">${p.pos}</span></span>`;
    })
    .join('');

  const needs = Object.entries(POS_TARGETS)
    .filter(([pos, target]) => (counts[pos] || 0) < target)
    .map(([pos, target]) => `${pos} ${counts[pos] || 0}/${target}`);
  $('needs').textContent = needs.length ? `· thin: ${needs.join(', ')}` : '· roster balanced';
}

function renderBoard() {
  const main = $('board');
  if (!state.board) return;

  const currentPick = currentPickNumber();
  const anyPicks = currentPick > 1;
  let players = state.board.players.filter((p) => !state.pickedIds.has(String(p.player_id)));
  if (state.tab !== 'ALL') players = players.filter((p) => p.position === state.tab);

  const rows = [];
  let lastTier = null;
  players.slice(0, 120).forEach((p) => {
    if (state.tab !== 'ALL' && p.tier !== lastTier) {
      rows.push(`<div class="tier-break">Tier ${p.tier}</div>`);
      lastTier = p.tier;
    }
    const delta = currentPick - p.overall_rank;
    const steal = anyPicks && delta >= 6
      ? `<span class="steal" title="Ranked #${p.overall_rank} overall, still available at pick ${currentPick}">+${delta}</span>`
      : '';
    const inj = p.injury_status
      ? `<span class="inj" title="${p.injury_status}">${p.injury_status[0]}</span>`
      : '';
    rows.push(`
      <div class="player">
        <span class="rank">${p.overall_rank}</span>
        <span class="name" title="${p.name} — value ${p.value}${p.dynasty_value ? ' · dynasty ' + p.dynasty_value : ''}${p.market_value ? ' · market ' + p.market_value : ''}">${p.name}</span>
        ${inj}
        ${steal}
        <span class="pos">${p.position}${p.pos_rank}</span>
        <span class="tier-chip">T${p.tier}</span>
        <span class="val">${(p.value / 1000).toFixed(1)}k</span>
      </div>`);
  });

  main.innerHTML = rows.join('') || '<p class="muted pad">No players left on the board.</p>';
}

boot();
