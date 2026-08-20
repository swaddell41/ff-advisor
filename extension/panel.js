/**
 * Draft assistant side panel.
 *
 * Data flow:
 *   - Sleeper public API: draft settings + live picks (polled every 4s)
 *   - ff-advisor API: the ranked board (values, tiers, injuries), fetched
 *     once per mode/format and filtered client-side as picks come in
 *
 * Also runs as a plain web page for testing: panel.html?draft=<id>
 * (chrome.* APIs are feature-detected).
 */

const API_BASE =
  new URLSearchParams(location.search).get('api') ||
  'https://ff-advisor-sam-waddells-projects.vercel.app';
const SLEEPER = 'https://api.sleeper.app';
const POLL_MS = 4000;

const isExt = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

const state = {
  draftId: null,
  draft: null,          // Sleeper draft object
  board: null,          // ff-advisor board
  picks: [],            // Sleeper picks
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
  const urlDraft = new URLSearchParams(location.search).get('draft');
  if (urlDraft) {
    connect(urlDraft);
  } else if (isExt) {
    chrome.storage.local.get(['draftId', 'username'], (v) => {
      if (v.username) {
        state.username = v.username;
        $('username-input').value = v.username;
        resolveUser(v.username);
      }
      if (v.draftId) connect(v.draftId);
    });
    // Follow the user into new draft rooms.
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.draftId && changes.draftId.newValue !== state.draftId) {
        connect(changes.draftId.newValue);
      }
    });
  }

  $('connect').addEventListener('click', () => {
    const raw = $('draft-input').value.trim();
    const m = raw.match(/(\d{10,})/);
    if (m) connect(m[1]);
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
    render();
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

// ── Draft connection ────────────────────────────────────────────────────────

let pollTimer = null;

async function connect(draftId) {
  state.draftId = draftId;
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

  $('meta').hidden = false;
  $('draft-meta').textContent =
    `${s.teams || '?'} teams · ${s.rounds || '?'} rds · ${sf ? 'SF' : '1QB'} · ${state.draft.type || ''}`;

  await loadBoard();
  await poll();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

async function loadBoard() {
  const r = await fetch(`${API_BASE}/api/draftboard?format=${state.format}&mode=${state.mode}`);
  state.board = await r.json();
}

async function poll() {
  if (!state.draftId) return;
  try {
    const r = await fetch(`${SLEEPER}/v1/draft/${state.draftId}/picks`);
    state.picks = (await r.json()) || [];
    state.pickedIds = new Set(state.picks.map((p) => String(p.player_id)));
    const total = (state.draft.settings.teams || 0) * (state.draft.settings.rounds || 0);
    const st = state.draft.status;
    $('status').textContent =
      `pick ${state.picks.length + 1}${total ? '/' + total : ''}` + (st && st !== 'drafting' ? ` · ${st}` : '');
    render();
  } catch (e) {
    $('status').textContent = 'poll failed — retrying';
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

const POS_TARGETS = { QB: 2, RB: 5, WR: 5, TE: 2 }; // loose roster targets for need hints

function render() {
  renderMyRoster();
  renderBoard();
}

function renderMyRoster() {
  const box = $('my-roster');
  if (!state.myUserId || !state.picks.length || !state.board) {
    box.hidden = true;
    return;
  }
  const mine = state.picks.filter((p) => String(p.picked_by) === state.myUserId);
  if (!mine.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const counts = {};
  const chips = mine.map((p) => {
    const meta = p.metadata || {};
    const pos = meta.position || '?';
    counts[pos] = (counts[pos] || 0) + 1;
    return `<span class="chip">${meta.first_name ? meta.first_name[0] + '. ' : ''}${meta.last_name || p.player_id} <span class="muted">${pos}</span></span>`;
  });
  $('my-picks').innerHTML = chips.join('');

  const needs = Object.entries(POS_TARGETS)
    .filter(([pos, target]) => (counts[pos] || 0) < target)
    .map(([pos, target]) => `${pos} ${counts[pos] || 0}/${target}`);
  $('needs').textContent = needs.length ? `· thin: ${needs.join(', ')}` : '· roster balanced';
}

function renderBoard() {
  const main = $('board');
  if (!state.board) return;

  const currentPick = state.picks.length + 1;
  let players = state.board.players.filter((p) => !state.pickedIds.has(String(p.player_id)));
  if (state.tab !== 'ALL') players = players.filter((p) => p.position === state.tab);

  const rows = [];
  let lastTier = null;
  players.slice(0, 120).forEach((p) => {
    if (state.tab !== 'ALL' && p.tier !== lastTier) {
      rows.push(`<div class="tier-break">Tier ${p.tier}</div>`);
      lastTier = p.tier;
    }
    // Falling value: ranked meaningfully earlier than the current pick.
    const delta = currentPick - p.overall_rank;
    const steal = state.picks.length > 0 && delta >= 6
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
