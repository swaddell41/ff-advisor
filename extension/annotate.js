/**
 * In-row annotation: writes OUR numbers into the draft site's own player
 * rows. Wherever the page renders a known player's full name, a compact
 * badge is appended right next to it:
 *
 *     Bijan Robinson  [9.8k T1 ↑12]
 *      value on the active board · position tier · steal delta when the
 *      player is ranked well ahead of the current pick
 *
 * Site-agnostic by design: instead of depending on Sleeper's or ESPN's
 * CSS classes (which change without notice), we scan leaf DOM nodes whose
 * text exactly matches a player name from our board. A MutationObserver
 * plus a slow safety interval keeps up with virtualized lists.
 *
 * Standalone test: any page that defines window.__ffaAnnotateTest = {api}
 * can load this file directly (chrome.* is feature-detected).
 */

(function () {
  if (window.__ffaAnnotateInstalled) return;
  window.__ffaAnnotateInstalled = true;

  const isExt = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const TEST = window.__ffaAnnotateTest || null;
  const API_BASE = (TEST && TEST.api) || 'https://ff-advisor-sam-waddells-projects.vercel.app';
  const SLEEPER = 'https://api.sleeper.app';

  const isSleeper = location.hostname.includes('sleeper.com');

  // All network goes through the background worker when running as an
  // extension — page CSP (Sleeper/ESPN restrict connect-src) blocks direct
  // content-script fetches.
  function xfetch(url) {
    if (!isExt || !chrome.runtime || !chrome.runtime.sendMessage || TEST) {
      return fetch(url).then((r) => r.json());
    }
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'ffa-fetch', url }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'fetch failed'));
          resolve(resp.json);
        });
      } catch (e) { reject(e); }
    });
  }

  // On-page status pill: makes the annotator's state visible instead of
  // failing silently. Click to dismiss.
  const pill = document.createElement('div');
  pill.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:2147483645;' +
    'background:rgba(15,17,21,.92);color:#8b93a5;border:1px solid #2a2f3a;' +
    'border-radius:6px;padding:3px 8px;font:11px Menlo,monospace;cursor:pointer';
  pill.textContent = 'FFA: loading board…';
  pill.title = 'Draft assistant status — click for the legend';
  pill.addEventListener('click', () => toggleHelp());
  document.documentElement.appendChild(pill);
  function setPill(t) { pill.textContent = 'FFA: ' + t; }

  // Always-visible recommendation strip — the board's best picks for your
  // roster, regardless of where the list is scrolled. Click to jump to the
  // top player's row when it's rendered.
  const reco = document.createElement('div');
  reco.style.cssText = 'position:fixed;bottom:34px;left:10px;z-index:2147483645;' +
    'background:rgba(15,17,21,.95);color:#e6e8ee;border:1px solid rgba(250,204,21,.5);' +
    'border-radius:6px;padding:4px 9px;font:11px Menlo,monospace;cursor:pointer;display:none';
  reco.title = 'Best picks for your roster right now (click to jump to the top player if visible)';
  document.documentElement.appendChild(reco);
  reco.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id === 'ffa-why') { toggleAudit(); return; }
    if (!state.myCounts && !state.myUserId) {
      const u = window.prompt('Your Sleeper username (for roster-aware recommendations):');
      if (u && u.trim()) {
        try { chrome.storage.local.set({ username: u.trim() }); } catch (_) {}
        resolveMyUserId();
      }
      return;
    }
    const els = reco.__topPid && state.badges.get(reco.__topPid);
    const live = els && [...els].find((e) => e.isConnected);
    if (live) live.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  // ── Pick audit panel: the full reasoning behind the current ★ pick ───
  const auditEl = document.createElement('div');
  auditEl.style.cssText = 'position:fixed;bottom:62px;left:10px;z-index:2147483646;width:430px;' +
    'max-height:60vh;overflow-y:auto;background:#0f1115;color:#e6e8ee;border:1px solid #2a2f3a;' +
    'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:11px/1.5 Menlo,monospace;' +
    'padding:10px 12px;display:none';
  document.documentElement.appendChild(auditEl);
  function toggleAudit() {
    if (auditEl.style.display === 'none') { renderAudit(); auditEl.style.display = 'block'; }
    else auditEl.style.display = 'none';
  }

  const kfmt = (v) => (v / 1000).toFixed(1) + 'k';
  function renderAudit() {
    const a = state.audit;
    if (!a) { auditEl.innerHTML = 'No recommendation computed yet.'; return; }
    const gray = 'color:#8b93a5';
    let h = '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
      `<strong>⚖ Why this pick — pick #${a.pick}</strong>` +
      '<span id="ffa-audit-x" style="cursor:pointer;color:#8b93a5">✕</span></div>';

    // Roster & open slots
    if (a.counts) {
      const c = (x) => a.counts[x] || 0;
      const opens = [];
      if (a.dedicatedOpen) {
        for (const [pos, n] of Object.entries(a.dedicatedOpen)) if (n > 0) opens.push(`${n} ${pos}`);
      }
      if (a.flexOpen > 0) opens.push(`${a.flexOpen} FLEX`);
      h += `<div style="${gray}">roster: ` +
        ['QB', 'RB', 'WR', 'TE'].map((x) => c(x) + x).join(' ') +
        ` · phase: <b style="color:#e6e8ee">${a.phase}</b>` +
        (opens.length ? ` · open slots: <b style="color:#e6e8ee">${opens.join(', ')}</b>` : '') +
        '</div>';
    } else {
      h += `<div style="color:#f87171">roster unknown — click the strip to set your username</div>`;
    }

    // Lookahead context
    if (a.la) {
      h += `<div style="${gray};margin-bottom:6px">your next pick: <b style="color:#e6e8ee">#${a.la.next}</b>` +
        ` — the room takes ${a.la.removals} players before then</div>`;
    } else {
      h += `<div style="${gray};margin-bottom:6px">lookahead off — draft slot unknown (ESPN or no draft order)</div>`;
    }

    // Per-position: best now vs likely-there-later vs full-run worst case
    const anyWorst = a.positions.some((r) => r.worst);
    h += '<table style="width:100%;border-collapse:collapse;margin-bottom:6px">' +
      `<tr style="${gray};text-align:left"><th></th><th>best now</th><th>at your next pick</th>` +
      (anyWorst ? '<th>if a run</th>' : '') + '<th>vanishes</th></tr>';
    for (const row of a.positions) {
      if (!row.now) continue;
      const dropTxt = row.drop >= 300
        ? `<b style="color:#f97316">−${kfmt(row.drop)}</b>`
        : `<span style="${gray}">−${kfmt(row.drop)}</span>`;
      const held = !row.eligible
        ? ` <span style="${gray}">(held: can't fill an open slot)</span>`
        : '';
      const runHot = row.worst && row.nb && (row.nb.value - row.worst.value) >= 400;
      h += `<tr><td><b>${row.pos}</b></td>` +
        `<td>${row.now.name} ${kfmt(row.now.value)}</td>` +
        `<td>${row.nb ? row.nb.name + ' ' + kfmt(row.nb.value) : '<span style="' + gray + '">—</span>'}</td>` +
        (anyWorst
          ? `<td>${row.worst
              ? `<span style="color:${runHot ? '#f87171' : '#8b93a5'}">${row.worst.name} ${kfmt(row.worst.value)}</span>`
              : `<span style="${gray}">—</span>`}</td>`
          : '') +
        `<td>${dropTxt}${held}</td></tr>`;
    }
    h += '</table>';

    // Top-3 score breakdown
    h += `<div style="${gray};margin-bottom:2px">score = (points over replacement + value vanishing by your next pick + 3% tiebreak) × need:</div>`;
    a.top.forEach((t, i) => {
      const star = i === 0 ? '<span style="color:#facc15">★</span> ' : `${i + 1}. `;
      const parts = [];
      if (a.phase === 'bench') {
        parts.push(`${kfmt(t.value)} value`);
        if (t.drop > 0) parts.push(`+${kfmt(t.drop)} vanishing`);
      } else {
        parts.push(`${kfmt(t.vorp)} over ${t.pos} line` +
          (a.repl && a.repl[t.pos] ? ` (${kfmt(a.repl[t.pos])})` : ''));
        if (t.drop > 0) parts.push(`+${kfmt(t.drop)} vanishing`);
      }
      h += `<div>${star}<b>${t.name}</b> ${t.pos}${t.posRank || ''} — ` +
        `${parts.join(' ')} × ${t.mult.toFixed(2)} need = <b>${Math.round(t.score)}</b></div>`;
    });

    // Rules in effect
    const rules = [];
    if (a.phase === 'filling starters') rules.push('players who can\'t fill an open starting slot are excluded');
    if (a.phase === 'bench') {
      if (a.teams >= 12) {
        rules.push(`${a.teams}-team league: thinner waiver wire — one backup-QB dart allowed (insurance ×0.4)`);
      } else if (a.myQBLate) {
        rules.push('late-round QB1: one upside backup-QB dart allowed (insurance ×0.3)');
      } else {
        rules.push('QB2/TE2 held to ×0.12: this wire is rich enough to stream — bench spots go to RB/WR upside');
      }
    }
    if (a.teFilled) rules.push('TE slot filled — TE2s don\'t qualify for flex (their price is slot scarcity, not points)');
    if (a.usedGatedFallback) rules.push('NO eligible starter-fillers left on the board — showing held players as fallback');
    if (a.la && a.rosterAware) {
      rules.push('room model: each team before your next pick takes its best-value NEED ' +
        '(we track every roster); "if a run" = every team that could start the position takes it');
    } else if (a.la) {
      rules.push('room model: top values go first; QBs capped at 1/3 of picks in 1QB rooms (rosters unknown)');
    }
    if (rules.length) {
      h += `<div style="${gray};margin-top:6px">rules in effect: ${rules.join(' · ')}</div>`;
    }
    auditEl.innerHTML = h;
    const x = auditEl.querySelector('#ffa-audit-x');
    if (x) x.addEventListener('click', () => (auditEl.style.display = 'none'));
  }

  // ── Explainer sidebar (auto-opens on load; pill toggles it) ──────────
  const HELP_KEY = 'ffaHideHelp';
  let helpEl = null;

  function buildHelp() {
    const el = document.createElement('div');
    el.id = 'ffa-help';
    el.style.cssText =
      'position:fixed;top:70px;right:12px;width:270px;z-index:2147483645;' +
      'background:#0f1115;color:#e6e8ee;border:1px solid #2a2f3a;border-radius:10px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.5);font:12px/1.55 Menlo,monospace;padding:12px 14px';
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<strong style="font-size:13px">⚡ What the numbers mean</strong>' +
        '<span id="ffa-help-x" style="cursor:pointer;color:#8b93a5">✕</span>' +
      '</div>' +
      '<div style="margin-bottom:8px"><span class="ffa-badge">1.8k T3 ↑11</span></div>' +
      '<div style="color:#8b93a5;margin-bottom:8px">' +
        '<b style="color:#e6e8ee">1.8k</b> — our value for this player on a 0–10k scale ' +
        '(blend of RosterAudit + real-trade market data, refreshed daily; redraft values in seasonal drafts).<br>' +
        '<b style="color:#e6e8ee">T3</b> — tier at the position. Big value gaps set the tier breaks; ' +
        'drafting before a tier ends beats reaching into the next one.<br>' +
        '<b style="color:#e6e8ee">↑11</b> — falling value: ranked 11 picks earlier than where the draft is now.' +
      '</div>' +
      '<div style="margin-bottom:6px"><span class="ffa-badge ffa-best">★ 5.2k T1</span> ' +
        '<span style="color:#8b93a5">our top pick for YOUR roster — weighs points over replacement ' +
        'AND what will be gone by your next turn; until your lineup is full, only players who can ' +
        'fill an open starting slot are recommended. Click <b style="color:#7dd3fc">why?</b> on the ' +
        'strip for the full reasoning behind the current pick.</span></div>' +
      '<div style="margin-bottom:6px"><span class="ffa-badge ffa-good">3.1k T2</span> ' +
        '<span style="color:#8b93a5">next-best two options</span></div>' +
      '<div style="margin-bottom:8px"><span class="ffa-badge ffa-steal">2.0k T3 ↑9</span> ' +
        '<span style="color:#8b93a5">green = value falling to you</span></div>' +
      '<div style="color:#8b93a5;margin-bottom:10px">Hover any badge for full detail. ' +
        'No badge = outside our ~190 ranked players.</div>' +
      '<label style="color:#8b93a5;display:block;margin-bottom:8px;cursor:pointer">' +
        '<input type="checkbox" id="ffa-help-hide" style="vertical-align:middle"> don\'t show automatically</label>' +
      '<div id="ffa-help-ok" style="text-align:center;border:1px solid #2a2f3a;border-radius:6px;' +
        'padding:5px;cursor:pointer;color:#7dd3fc">Got it</div>';
    document.documentElement.appendChild(el);
    el.querySelector('#ffa-help-x').addEventListener('click', () => (el.style.display = 'none'));
    el.querySelector('#ffa-help-ok').addEventListener('click', () => (el.style.display = 'none'));
    el.querySelector('#ffa-help-hide').addEventListener('change', (e) => {
      try { localStorage.setItem(HELP_KEY, e.target.checked ? '1' : ''); } catch (_) {}
    });
    try {
      el.querySelector('#ffa-help-hide').checked = localStorage.getItem(HELP_KEY) === '1';
    } catch (_) {}
    return el;
  }

  function toggleHelp(force) {
    if (!helpEl) helpEl = buildHelp();
    const show = force !== undefined ? force : helpEl.style.display === 'none';
    helpEl.style.display = show ? 'block' : 'none';
  }

  let autoShowHelp = true;
  try { autoShowHelp = localStorage.getItem(HELP_KEY) !== '1'; } catch (_) {}

  const state = {
    byName: new Map(),   // normalized name -> [player, ...]
    byEspn: new Map(),   // espn_id -> player
    badges: new Map(),   // player_id -> Set<badge el>
    pickedIds: new Set(),// sleeper ids already drafted
    allPlayers: [],      // full board, for global recommendations
    lineup: { teams: 10, qb: 1, rb: 2, wr: 2, te: 1, flex: 1, sf: 0, k: 0, dst: 0, rounds: 15 },
    repl: null,          // replacement-level value per position (VORP baseline)
    myCounts: null,      // {QB: n, RB: n, ...} — my roster so far (null = unknown)
    myUserId: null,      // sleeper user id (from stored username)
    currentPick: 1,
    format: 'sf_ppr',
    mode: 'redraft',
    mySlot: null,        // my draft slot (1-based) — enables lookahead
    draftType: 'snake',  // 'snake' | 'linear'
    slotCounts: null,    // draft_slot -> {QB:n,...} EVERY team's roster — enables run modeling
    audit: null,         // last recommend()'s reasoning, for the audit panel
  };

  // ── Name normalization ────────────────────────────────────────────────
  const SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b/g;
  function norm(s) {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(SUFFIXES, '')
      .replace(/[^a-z]/g, '');
  }

  // ── Board ─────────────────────────────────────────────────────────────
  async function loadBoard() {
    const board = await xfetch(`${API_BASE}/api/draftboard?format=${state.format}&mode=${state.mode}`);
    state.byName.clear();
    state.byEspn.clear();
    state.allPlayers = board.players;
    for (const p of board.players) {
      const k = norm(p.name);
      if (!state.byName.has(k)) state.byName.set(k, []);
      state.byName.get(k).push(p);
      if (p.espn_id) state.byEspn.set(String(p.espn_id), p);
    }
    computeReplacement();
  }

  // VORP baselines: the value of the player at "replacement level" for each
  // position — the best guy that's effectively free given how many starters
  // the league consumes. Draft worth = value ABOVE that line, which is why a
  // backup QB (QB13 is free) must lose to a weekly-starting RB.
  function computeReplacement() {
    const L = state.lineup;
    const baselineRank = {
      QB: Math.round(L.teams * (L.qb + L.sf)) + 2,
      RB: Math.round(L.teams * (L.rb + L.flex * 0.45)) + 2,
      WR: Math.round(L.teams * (L.wr + L.flex * 0.45)) + 2,
      TE: Math.round(L.teams * L.te) + 2,
    };
    const repl = {};
    for (const pos of Object.keys(baselineRank)) {
      const group = state.allPlayers.filter((p) => p.position === pos);
      const idx = Math.min(baselineRank[pos] - 1, group.length - 1);
      repl[pos] = idx >= 0 ? group[idx].value : 0;
    }
    state.repl = repl;
  }

  function detectMyIdentity() {
    // Sleeper's web app stores the logged-in user's id in plain
    // localStorage — same origin as this content script, so identity is
    // zero-setup. (No tokens read; just the public user id.)
    if (isSleeper) {
      try {
        const raw = localStorage.getItem('user_id');
        if (raw) {
          const id = JSON.parse(raw);
          if (id) { state.myUserId = String(id); return; }
        }
      } catch (_) {}
    }
    resolveMyUserId();
  }

  async function resolveMyUserId() {
    if (!isExt) return;
    try {
      chrome.storage.local.get(['username'], async (v) => {
        if (!v.username) return;
        try {
          const u = await xfetch(`${SLEEPER}/v1/user/${encodeURIComponent(v.username)}`);
          if (u && u.user_id) state.myUserId = String(u.user_id);
        } catch (_) {}
      });
    } catch (_) {}
  }

  // ── Draft context (format/mode + current pick for steal deltas) ──────
  async function detectSleeperDraft() {
    const m = location.pathname.match(/\/draft\/\w+\/(\d+)/);
    if (!m) return;
    try {
      const d = await xfetch(`${SLEEPER}/v1/draft/${m[1]}`);
      const s = d.settings || {};
      const scoring = (d.metadata && d.metadata.scoring_type) || '';
      state.format = (s.slots_super_flex || 0) > 0 || scoring.includes('2qb') ? 'sf_ppr' : '1qb_ppr';
      state.mode = scoring.includes('dynasty') ? 'dynasty' : 'redraft';
      state.draftType = d.type || 'snake';
      if (state.myUserId && d.draft_order && d.draft_order[state.myUserId]) {
        state.mySlot = d.draft_order[state.myUserId];
      }
      state.lineup = {
        teams: s.teams || 10,
        qb: s.slots_qb ?? 1,
        rb: s.slots_rb ?? 2,
        wr: s.slots_wr ?? 2,
        te: s.slots_te ?? 1,
        flex: (s.slots_flex ?? 1) + (s.slots_wr_rb ?? 0) + (s.slots_wr_rb_te ?? 0),
        sf: s.slots_super_flex ?? 0,
        k: s.slots_k ?? 0,
        dst: s.slots_def ?? 0,
        rounds: s.rounds ?? 15,
      };
      computeReplacement();
      // Pick polling: a steady timer PLUS immediate refreshes when the page
      // mutates (a pick removes rows instantly, so the DOM is our event
      // source) — recommendations react within a beat of any pick.
      const pollPicks = async () => {
        lastPickPoll = Date.now();
        try {
          const picks = await xfetch(`${SLEEPER}/v1/draft/${m[1]}/picks`);
          state.pickedIds = new Set((picks || []).map((p) => String(p.player_id)));
          // Every team's roster by draft slot — feeds the run model (which
          // positions the teams picking before my next turn still need).
          const slotCounts = {};
          for (const p of picks || []) {
            const s = p.draft_slot;
            if (!s) continue;
            const pos = (p.metadata && p.metadata.position) || '?';
            (slotCounts[s] = slotCounts[s] || {})[pos] = (slotCounts[s][pos] || 0) + 1;
          }
          state.slotCounts = slotCounts;
          if (state.myUserId) {
            const counts = {};
            let qbRound = null;
            for (const p of picks || []) {
              if (String(p.picked_by) !== state.myUserId) continue;
              const pos = (p.metadata && p.metadata.position) || '?';
              counts[pos] = (counts[pos] || 0) + 1;
              if (pos === 'QB' && qbRound === null) {
                qbRound = Math.ceil((p.pick_no || 1) / (state.lineup.teams || 10));
              }
            }
            state.myCounts = counts;
            // A cheap/late QB1 justifies ONE upside backup ("pair a mid-tier
            // QB1 with a high-upside dart"); an early QB1 doesn't.
            state.myQBLate = qbRound !== null && qbRound >= 8;
          }
          setCurrentPick((picks || []).length + 1);
          recommend();
        } catch (_) {}
      };
      pickPollTrigger = pollPicks;
      setInterval(pollPicks, 4000);
      pollPicks();
    } catch (_) {}
  }

  async function watchEspnPicks() {
    state.format = '1qb_ppr';

    // Superflex detection for real ESPN leagues: their lineup settings are
    // readable in-session (the page's own API, cookies included). Slot 7 is
    // OP (QB-eligible superflex); QB slot count > 1 also means 2QB.
    const leagueId = new URLSearchParams(location.search).get('leagueId');
    if (leagueId && leagueId !== '0') {
      try {
        const year = new Date().getFullYear();
        const r = await fetch(
          `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${leagueId}?view=mSettings`,
          { credentials: 'include' }
        );
        if (r.ok) {
          const j = await r.json();
          const slots = (j.settings && j.settings.rosterSettings && j.settings.rosterSettings.lineupSlotCounts) || {};
          if ((slots['7'] || 0) > 0 || (slots['0'] || 0) > 1) state.format = 'sf_ppr';
          state.lineup = {
            teams: (j.settings && j.settings.size) || 10,
            qb: slots['0'] || 1,
            rb: slots['2'] || 2,
            wr: slots['4'] || 2,
            te: slots['6'] || 1,
            flex: slots['23'] || 1,
            sf: slots['7'] || 0,
            k: slots['17'] || 0,
            dst: slots['16'] || 0,
            rounds: 16,
          };
          computeReplacement();
        }
      } catch (_) { /* mocks / blocked — fall through */ }
    }

    if (!isExt) return;
    // Panel's SF toggle (persisted) overrides when league detection had
    // nothing to say (e.g. mock lobby drafts).
    try {
      await new Promise((res) => chrome.storage.local.get(['espnSF'], (v) => {
        if (state.format === '1qb_ppr' && v.espnSF) state.format = 'sf_ppr';
        res();
      }));
    } catch (_) {}
    try {
    const applyEspn = (d) => {
      state.pickedIds = new Set(
        d.picks.map((p) => state.byEspn.get(String(p.espn_id)))
          .filter(Boolean).map((p) => String(p.player_id))
      );
      if (d.myTeamId) {
        const counts = {};
        for (const p of d.picks) {
          if (p.team_id !== String(d.myTeamId)) continue;
          const bp = state.byEspn.get(String(p.espn_id));
          if (bp && bp.position) counts[bp.position] = (counts[bp.position] || 0) + 1;
        }
        state.myCounts = counts;
      }
      setCurrentPick(d.picks.length + 1);
      recommend();
    };
    chrome.storage.local.get(['espnDraft'], (v) => {
      if (v.espnDraft) applyEspn(v.espnDraft);
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.espnDraft && ch.espnDraft.newValue) applyEspn(ch.espnDraft.newValue);
    });
    } catch (_) { /* orphaned after extension reload */ }
  }

  function setCurrentPick(n) {
    if (n === state.currentPick) return;
    state.currentPick = n;
    for (const [pid, els] of state.badges) {
      for (const el of els) updateBadge(el);
    }
  }

  // ── Badges ────────────────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
    .ffa-badge {
      display: inline-block;
      margin-left: 4px;
      padding: 0 3px;
      border-radius: 4px;
      font: 700 9px/1.5 Menlo, monospace;
      background: rgba(15, 17, 21, 0.85);
      color: #7dd3fc;
      border: 1px solid rgba(125, 211, 252, 0.35);
      vertical-align: middle;
      white-space: nowrap;
    }
    .ffa-badge.ffa-overlay {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      margin-left: 0;
      background: rgba(15, 17, 21, 0.95);
      z-index: 5;
    }
    .ffa-badge.ffa-steal { color: #4ade80; border-color: rgba(74, 222, 128, 0.45); }
    .ffa-badge.ffa-t1 { color: #facc15; border-color: rgba(250, 204, 21, 0.45); }
    .ffa-badge.ffa-best {
      color: #0f1115 !important;
      background: #facc15 !important;
      border-color: #facc15 !important;
      box-shadow: 0 0 8px rgba(250, 204, 21, 0.75);
    }
    .ffa-badge.ffa-best::before { content: '★  '; }
    .ffa-badge.ffa-good {
      border-color: rgba(74, 222, 128, 0.9) !important;
      box-shadow: 0 0 5px rgba(74, 222, 128, 0.45);
    }
  `;
  document.documentElement.appendChild(css);

  function badgeText(p) {
    const delta = state.currentPick - p.overall_rank;
    const steal = state.currentPick > 1 && delta >= 6 ? ` ↑${delta}` : '';
    return `${(p.value / 1000).toFixed(1)}k T${p.tier}${steal}`;
  }

  function updateBadge(el) {
    const p = el.__ffaPlayer;
    if (!p) return;
    el.textContent = el.dataset.compact
      ? `${(p.value / 1000).toFixed(1)}k`
      : badgeText(p);
    const delta = state.currentPick - p.overall_rank;
    el.classList.toggle('ffa-steal', state.currentPick > 1 && delta >= 6);
    el.classList.toggle('ffa-t1', p.tier === 1 && !(state.currentPick > 1 && delta >= 6));
  }

  const processed = new WeakSet();

  // The row element a name lives in, or null if the site has no semantic
  // row. ESPN renders the player table as real <tr>s; returning null
  // elsewhere keeps Sleeper on its original, known-good code path rather
  // than guessing at a row boundary with an ancestor walk.
  function rowOf(node) {
    const el = node.parentElement;
    return el ? el.closest('tr,li,[role="row"]') : null;
  }

  // Detach a badge AND forget it. state.badges backs both the "matched on
  // page" count and the ★ flash, so leaked nodes inflate the pill and make
  // the flash target elements that are no longer on screen.
  function dropBadge(b) {
    const p = b.__ffaPlayer;
    if (p) {
      const set = state.badges.get(p.player_id);
      if (set) {
        set.delete(b);
        if (!set.size) state.badges.delete(p.player_id);
      }
    }
    b.remove();
  }

  // Virtualized rows get torn out wholesale and their badges go with them.
  function pruneBadges() {
    for (const [pid, set] of state.badges) {
      for (const b of set) if (!b.isConnected) set.delete(b);
      if (!set.size) state.badges.delete(pid);
    }
  }

  function annotateAfter(textNode, p) {
    const b = document.createElement('span');
    b.className = 'ffa-badge';
    b.__ffaPlayer = p;
    b.title = `${p.name} — our #${p.overall_rank} overall, ${p.position}${p.pos_rank} tier ${p.tier}` +
      (p.dynasty_value ? ` · dynasty ${p.dynasty_value}` : '') +
      (p.market_value ? ` · market ${p.market_value}` : '') +
      (p.injury_status ? ` · ${p.injury_status}` : '');
    updateBadge(b);
    const parent = textNode.parentNode;
    parent.insertBefore(b, textNode.nextSibling);

    // Preferred placement: the short SECOND line of the cell (position/team
    // metadata, e.g. "WR · DEN") — it has free space to its right and never
    // collides with the name or the site's row buttons. Detected as a
    // sibling element rendered below the name's line.
    const parentEl = textNode.parentElement;
    if (parentEl) {
      const nameRect = b.getBoundingClientRect();
      for (const el of parentEl.children) {
        if (el === b || (el.classList && el.classList.contains('ffa-badge'))) continue;
        const er = el.getBoundingClientRect();
        if (er.width > 0 && er.top >= nameRect.bottom - 2) {
          b.style.marginLeft = '6px';
          el.appendChild(b);
          const er2 = el.getBoundingClientRect();
          if (b.getBoundingClientRect().right > er2.right + 1) {
            b.dataset.compact = '1';   // crowded line → value only
            updateBadge(b);
          }
          if (!state.badges.has(p.player_id)) state.badges.set(p.player_id, new Set());
          state.badges.get(p.player_id).add(b);
          return;
        }
      }
    }

    // Fallback: if an ellipsizing ancestor is truncating, take the badge out
    // of the text flow and park it just past that cell's right edge.
    let anc = textNode.parentElement;
    for (let i = 0; i < 3 && anc; i += 1, anc = anc.parentElement) {
      const cs = getComputedStyle(anc);
      const clips = cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden' || cs.overflowX === 'hidden';
      if (clips && anc.scrollWidth > anc.clientWidth + 1) {
        let host = anc.parentElement || anc;
        for (let j = 0; j < 2 && host.parentElement; j += 1) {
          const hcs = getComputedStyle(host);
          if (hcs.overflow !== 'hidden' && hcs.overflowX !== 'hidden') break;
          host = host.parentElement;
        }
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        b.classList.add('ffa-overlay');
        host.appendChild(b);
        const hostRect = host.getBoundingClientRect();
        const cellRect = anc.getBoundingClientRect();
        b.style.left = Math.round(cellRect.right - hostRect.left + 4) + 'px';
        break;
      }
    }

    if (!state.badges.has(p.player_id)) state.badges.set(p.player_id, new Set());
    state.badges.get(p.player_id).add(b);
  }

  // ── Scanning ──────────────────────────────────────────────────────────
  function scan() {
    if (!state.byName.size) return;
    // Walk TEXT nodes, not leaf elements: draft sites render the player
    // name as a bare text node next to sibling elements (metadata, icons),
    // so no single element's full text equals the name.
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(t) {
        const s = t.nodeValue;
        if (!s) return NodeFilter.FILTER_SKIP;
        const len = s.trim().length;
        if (len < 4 || len > 32) return NodeFilter.FILTER_SKIP;
        const p = t.parentElement;
        if (!p) return NodeFilter.FILTER_SKIP;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('ffa-badge')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let t;
    let n = 0;
    while ((t = walker.nextNode()) && n < 30000) {
      n += 1;
      const matches = state.byName.get(norm(t.nodeValue.trim()));
      if (!matches || matches.length !== 1) continue; // ambiguous names skipped
      const p = matches[0];

      // Reconcile against the ROW, not a memo of the text node. ESPN's
      // player table is React-virtualized and breaks text-node memoization
      // two ways: (1) a re-render swaps in a fresh text node while keeping
      // the sibling element our badge was appended to, so the WeakSet sees
      // a "new" name and appends a SECOND badge beside the surviving one;
      // (2) scrolling RECYCLES a whole row for a different player, carrying
      // the previous occupant's badge with it (this is why one stale value
      // appeared to repeat down a run of adjacent rows). Both are invisible
      // to the WeakSet, so ask what the row actually holds right now.
      const row = rowOf(t);
      if (row) {
        let reused = false;
        for (const b of row.querySelectorAll('.ffa-badge')) {
          const bp = b.__ffaPlayer;
          if (!reused && bp && String(bp.player_id) === String(p.player_id)) {
            updateBadge(b);   // right player, still attached — just refresh
            reused = true;
          } else {
            dropBadge(b);     // duplicate, or left over from a recycled row
          }
        }
        if (reused) { processed.add(t); continue; }
      }

      if (processed.has(t)) continue;
      processed.add(t);
      annotateAfter(t, p);
    }
    pruneBadges();
    setPill(`${state.byName.size} players on board · ${state.badges.size} matched on page` +
      (state.badges.size === 0 ? ' — no names matched yet (scrolling the player list helps)' : ''));
    recommend();
  }

  // How much you still want another player at this position, given what
  // you've drafted. 1.0 = full appetite; filled positions decay hard so a
  // third QB never outstars a needed RB.
  function needMult(pos) {
    if (!state.myCounts) return 1.0;
    const n = state.myCounts[pos] || 0;
    const sf = state.format.startsWith('sf');
    if (pos === 'QB') {
      const table = sf ? [1.1, 1.0, 0.5, 0.15] : [1.0, 0.3, 0.1];
      return table[Math.min(n, table.length - 1)];
    }
    if (pos === 'TE') {
      const table = [1.0, 0.4, 0.15];
      return table[Math.min(n, table.length - 1)];
    }
    // RB / WR: gentle decay — depth still matters
    const table = [1.0, 1.0, 1.0, 0.95, 0.85, 0.7, 0.5];
    return table[Math.min(n, table.length - 1)];
  }

  // ── Lookahead: what will still be there at MY next pick? ─────────────
  // Static VORP says who's best *today*; drafts are won on drop-offs — the
  // value that vanishes between now and your next turn. A position on a
  // flat shelf (RB26≈RB28) can wait; a position about to cliff can't.
  function pickSlot(pn) {
    const t = state.lineup.teams;
    const rnd = Math.floor((pn - 1) / t);
    const idx = (pn - 1) % t;
    return state.draftType === 'snake' && rnd % 2 === 1 ? t - idx : idx + 1;
  }

  // Returns {next, removals}: my next pick number and how many players the
  // room takes off the board before it. null if my slot is unknown.
  function nextMyPickInfo() {
    if (!state.mySlot || !state.lineup.teams) return null;
    const last = (state.lineup.rounds || 15) * state.lineup.teams;
    let removals = 0;
    for (let pn = state.currentPick; pn <= last; pn++) {
      if (pickSlot(pn) === state.mySlot) {
        if (pn === state.currentPick) continue; // that's THIS pick
        return { next: pn, removals };
      }
      removals += 1;
    }
    return null;
  }

  // FALLBACK room model (used when we don't know opponents' rosters, e.g.
  // ESPN): the room takes our board's top values — except QBs in 1QB
  // rooms, which real drafters take far slower than value boards rank
  // them (capped at 1/3 of the run).
  function expectedNextBest(avail, removals) {
    const qbCap = state.format.startsWith('sf') ? Infinity : Math.ceil(removals / 3);
    const gone = new Set();
    let qbs = 0;
    for (const p of avail) {
      if (gone.size >= removals) break;
      if (p.position === 'QB') {
        if (qbs >= qbCap) continue;
        qbs += 1;
      }
      gone.add(p.player_id);
    }
    const best = {};
    for (const p of avail) {
      if (gone.has(p.player_id)) continue;
      if (!(p.position in best)) best[p.position] = p;
    }
    return best;
  }

  // Can a team with roster `c` start another player at `pos`? Same
  // starters-first rules we apply to ourselves, assumed of opponents.
  // Once their lineup is full they hunt RB/WR upside.
  function teamCanStart(c, pos) {
    const L = state.lineup;
    const ded = {
      QB: (L.qb + L.sf) - (c.QB || 0),
      RB: L.rb - (c.RB || 0),
      WR: L.wr - (c.WR || 0),
      TE: L.te - (c.TE || 0),
    };
    const flexUsed = Math.max(0, (c.RB || 0) - L.rb) +
      Math.max(0, (c.WR || 0) - L.wr) + Math.max(0, (c.TE || 0) - L.te);
    const flexOpen = Math.max(0, L.flex - flexUsed);
    const anyOpen = flexOpen > 0 || Object.values(ded).some((n) => n > 0);
    if (!anyOpen) return pos === 'RB' || pos === 'WR';
    return (ded[pos] || 0) > 0 || (flexOpen > 0 && (pos === 'RB' || pos === 'WR'));
  }

  // The draft slots (teams) picking between now and my next turn, in order.
  function interveningSlots(la) {
    const slots = [];
    for (let pn = state.currentPick; pn < la.next; pn++) {
      const s = pickSlot(pn);
      if (s === state.mySlot) continue; // my own current pick
      slots.push(s);
    }
    return slots;
  }

  // Roster-aware room simulation: each intervening pick belongs to a real
  // team whose roster we KNOW. Each takes the best value among positions
  // they can still start — so runs emerge naturally: six QB-needy teams
  // means six QBs likely gone, not the flat value-order guess. Returns
  // expected best-per-position at my next pick, or null without rosters.
  function simulateRoom(avail, la) {
    if (!state.slotCounts || !Object.keys(state.slotCounts).length) return null;
    const sim = {};
    const counts = (s) => (sim[s] = sim[s] || { ...(state.slotCounts[s] || {}) });
    const gone = new Set();
    for (const s of interveningSlots(la)) {
      const c = counts(s);
      let take = avail.find((p) => !gone.has(p.player_id) && teamCanStart(c, p.position));
      if (!take) take = avail.find((p) => !gone.has(p.player_id));
      if (!take) break;
      gone.add(take.player_id);
      c[take.position] = (c[take.position] || 0) + 1;
    }
    const best = {};
    for (const p of avail) {
      if (gone.has(p.player_id)) continue;
      if (!(p.position in best)) best[p.position] = p;
    }
    return best;
  }

  // Worst case per position: assume EVERY intervening team that could
  // start that position takes it — the full run. A bound, not a forecast;
  // shown in the audit and behind the strip's run warning.
  function worstCaseAtNext(avail, la) {
    if (!state.slotCounts || !Object.keys(state.slotCounts).length) return null;
    const slots = interveningSlots(la);
    const res = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      let n = 0;
      for (const s of slots) {
        if (teamCanStart(state.slotCounts[s] || {}, pos)) n += 1;
      }
      const grp = avail.filter((p) => p.position === pos);
      res[pos] = grp.length ? grp[Math.min(n, grp.length - 1)] : null;
    }
    return res;
  }

  // Global recommendation: scored over the ENTIRE board (not just rows the
  // site happens to have rendered), shown in the fixed strip; badges get
  // starred too whenever their rows are in the DOM.
  function recommend() {
    document.querySelectorAll('.ffa-badge.ffa-best, .ffa-badge.ffa-good')
      .forEach((el) => el.classList.remove('ffa-best', 'ffa-good'));

    // Once your TE slot is filled, another TE can only see the field via
    // FLEX — where he competes with RB/WRs, not other TEs. His baseline
    // becomes the flex line (much higher than the near-free TE12 line),
    // which is why mid-tier TE2s stop being recommended while a truly
    // elite faller can still clear the bar. Same logic guards QB via the
    // need multiplier (QBs have no flex path at all).
    const teFilled = state.myCounts && ((state.myCounts.TE || 0) >= state.lineup.te);

    // Starters-first gate: while ANY starting slot (dedicated or flex) is
    // open, players who cannot fill one — e.g. a backup QB in a 1QB league —
    // are EXCLUDED from the recommendation, not just penalized. A soft
    // penalty leaks in the endgame: when every remaining flex-eligible
    // player sits below the replacement line (VORP 0, score = 3% value
    // noise), a gated QB's residual VORP survives even a 0.15 multiplier
    // and tops the strip. Once your lineup is full, the gate lifts and
    // bench value (QB insurance, RB depth) competes on normal terms.
    const L = state.lineup;
    const C = state.myCounts;
    let startersOpen = false;
    let canStart = () => true;
    let dedicatedOpen = null;
    let flexOpen = 0;
    if (C && L) {
      const cnt = (x) => C[x] || 0;
      dedicatedOpen = {
        QB: Math.max(0, (L.qb + L.sf) - cnt('QB')),
        RB: Math.max(0, L.rb - cnt('RB')),
        WR: Math.max(0, L.wr - cnt('WR')),
        TE: Math.max(0, L.te - cnt('TE')),
      };
      const flexUsed =
        Math.max(0, cnt('RB') - L.rb) + Math.max(0, cnt('WR') - L.wr) + Math.max(0, cnt('TE') - L.te);
      flexOpen = Math.max(0, L.flex - flexUsed);
      startersOpen = flexOpen > 0 || Object.values(dedicatedOpen).some((n) => n > 0);
      // TE2s don't count as flex-fillers: elite-TE market value is
      // scarcity premium for the TE SLOT, not weekly points — a second TE
      // produces roughly flex-line numbers while costing a premium pick.
      canStart = (pos) =>
        (dedicatedOpen[pos] || 0) > 0 ||
        (flexOpen > 0 && (pos === 'RB' || pos === 'WR' || (pos === 'TE' && !teFilled)));
    }

    // Two scoring regimes — starter value and bench value are different
    // quantities:
    //   STARTERS PHASE: value over replacement (VBD) — how much better than
    //     the free alternative at the slot you'd start him in.
    //   BENCH PHASE: ceiling — late market value proxies upside for RB/WR
    //     lottery tickets (their VORP is ~0 by definition, which is exactly
    //     why VORP is the wrong currency here). Spare QBs/TEs are insurance,
    //     worth a small fraction, which naturally schedules them into the
    //     final rounds next to K/DST — where best practice puts them.
    const benchPhase = C && L && !startersOpen;

    // Lookahead: the slice of a player's value that will be GONE by my next
    // turn. When two open slots compete, "take A now + B next" vs "B now +
    // A next" reduces exactly to comparing drop-offs — so drop shares the
    // score with VORP: VORP says how good he is, drop says how little of
    // him survives waiting. A flat shelf (RB26≈RB28) can wait; a cliff
    // (WR19→WR26) can't.
    const avail = state.allPlayers.filter((p) => !state.pickedIds.has(String(p.player_id)));
    const la = nextMyPickInfo();
    let nextBest = {};
    let worstBest = null;
    let rosterAware = false;
    if (la) {
      const sim = simulateRoom(avail, la);
      if (sim) {
        nextBest = sim;
        worstBest = worstCaseAtNext(avail, la);
        rosterAware = true;
      } else {
        nextBest = expectedNextBest(avail, la.removals);
      }
    }
    const dropOf = (p) => {
      if (!la) return 0;
      const nb = nextBest[p.position];
      return Math.max(0, p.value - (nb ? nb.value : 0));
    };

    const cands = [];
    const gated = []; // can't fill an open starting slot; only shown if nobody can
    for (const p of avail) {
      let score;
      let vorp = 0;
      let drop = 0;
      let mult = 1;
      if (benchPhase) {
        const spareQB = p.position === 'QB' && (C.QB || 0) >= (L.qb + L.sf);
        const spareTE = p.position === 'TE' && teFilled;
        if (spareQB || spareTE) {
          // Insurance weight. Research consensus: in 10-team 1QB leagues the
          // QB/TE wire is rich — stream, don't roster (weight 0.12 ≈ never).
          // Two evidence-backed exceptions, for the FIRST backup QB only:
          // 12+-team leagues (wire thins out) and a late-round QB1 ("pair a
          // cheap QB1 with an upside dart"). TE2 gets no exception.
          mult = 0.12;
          const firstBackupQB = spareQB && (C.QB || 0) === (L.qb + L.sf);
          if (firstBackupQB && L.teams >= 12) mult = 0.4;
          else if (firstBackupQB && state.myQBLate) mult = 0.3;
          score = p.value * mult;
        } else {
          mult = needMult(p.position);
          drop = dropOf(p);
          score = (p.value + drop) * mult;
        }
      } else {
        let repl = (state.repl && state.repl[p.position]) || 0;
        if (p.position === 'TE' && teFilled && state.repl) {
          repl = Math.max(repl, state.repl.RB || 0, state.repl.WR || 0);
        }
        vorp = Math.max(0, p.value - repl);
        drop = dropOf(p);
        mult = needMult(p.position);
        score = (vorp + drop + p.value * 0.03) * mult;
        if (startersOpen && !canStart(p.position)) {
          gated.push({ p, score: score * 0.15, vorp, drop, mult });
          continue;
        }
      }
      cands.push({ p, score, vorp, drop, mult });
    }
    // Fallback: if no eligible starter-fillers remain on the board (e.g. an
    // open TE slot with every ranked TE drafted), show the gated pool
    // rather than a blank strip.
    const pool = cands.length ? cands : gated;
    pool.sort((a, b) => b.score - a.score);
    const top = pool.slice(0, 3);

    // Audit trail: everything that went into this recommendation, rendered
    // on demand by the "why?" panel.
    state.audit = {
      pick: state.currentPick,
      la,
      phase: !C ? 'roster unknown' : (benchPhase ? 'bench' : 'filling starters'),
      counts: C ? { ...C } : null,
      dedicatedOpen,
      flexOpen,
      repl: state.repl ? { ...state.repl } : null,
      teFilled: !!teFilled,
      rosterAware,
      teams: L ? L.teams : null,
      myQBLate: !!state.myQBLate,
      positions: ['RB', 'WR', 'TE', 'QB'].map((pos) => {
        const now = avail.find((p) => p.position === pos) || null;
        const nb = (la && nextBest[pos]) || null;
        const wc = (worstBest && worstBest[pos]) || null;
        return {
          pos,
          now,
          nb,
          worst: wc,
          drop: now && nb ? Math.max(0, now.value - nb.value) : 0,
          eligible: benchPhase || !C ? true : canStart(pos),
        };
      }),
      top: top.map((c) => ({
        name: c.p.name, pos: c.p.position, posRank: c.p.pos_rank,
        value: c.p.value, vorp: c.vorp || 0, drop: c.drop || 0,
        mult: c.mult == null ? 1 : c.mult, score: c.score,
      })),
      usedGatedFallback: !cands.length && !!gated.length,
    };
    if (auditEl && auditEl.style.display !== 'none') renderAudit();

    top.forEach((c, i) => {
      const els = state.badges.get(c.p.player_id);
      if (!els) return;
      for (const el of els) {
        if (!el.isConnected) continue;
        el.classList.add(i === 0 ? 'ffa-best' : 'ffa-good');
      }
    });

    if (top.length && state.currentPick > 1) {
      const fmt = (c) => `${c.p.name} ${(c.p.value / 1000).toFixed(1)}k ${c.p.position}`;
      let roster;
      if (state.myCounts) {
        const cnt = (x) => state.myCounts[x] || 0;
        const totalMine = Object.values(state.myCounts).reduce((a, b) => a + b, 0);
        const remaining = Math.max(0, (state.lineup.rounds || 15) - totalMine);
        const reserve = Math.max(0, (state.lineup.k || 0) - cnt('K')) +
                        Math.max(0, (state.lineup.dst || 0) - (cnt('DEF') + cnt('DST')));
        let phase = startersOpen ? 'filling starters' : 'bench phase';
        if (!startersOpen && reserve > 0 && remaining <= reserve) {
          phase = '<span style="color:#facc15">time for K/DST (not on our board)</span>';
        } else if (reserve > 0) {
          phase += `, save ${reserve} for K/DST`;
        }
        roster = ' · <span style="color:#8b93a5">' +
          ['QB', 'RB', 'WR', 'TE'].map((x) => cnt(x) + x).join(' ') +
          ` · ${remaining} picks left · ${phase}</span>`;
      } else {
        roster = ' · <span style="color:#f87171">roster unknown — click to set username</span>';
      }
      const topDrop = top[0].drop || 0;
      const dropNote = topDrop >= 300
        ? `<span style="color:#f97316"> −${(topDrop / 1000).toFixed(1)}k if you wait</span>`
        : '';
      // Run-risk warning: a position I still need but am NOT taking now,
      // where the full-run worst case sits far below the expected outcome.
      let runWarn = '';
      if (worstBest && !benchPhase) {
        let worstPos = null;
        let gap = 0;
        for (const pos of ['QB', 'RB', 'WR', 'TE']) {
          if (pos === top[0].p.position || !canStart(pos)) continue;
          const e = nextBest[pos];
          const w = worstBest[pos];
          if (e && w && e.value - w.value > gap) { gap = e.value - w.value; worstPos = pos; }
        }
        if (worstPos && gap >= 400) {
          runWarn = ` · <span style="color:#f87171">⚠ ${worstPos} run risk: could fall to ` +
            `${worstBest[worstPos].name} ${kfmt(worstBest[worstPos].value)}</span>`;
        }
      }
      reco.innerHTML =
        '<span style="color:#facc15">★ PICK: ' + fmt(top[0]) + '</span>' + dropNote + runWarn +
        (top[1] ? '<span style="color:#8b93a5"> · then ' + top.slice(1).map(fmt).join(' · ') + '</span>' : '') +
        roster +
        ' · <span id="ffa-why" style="color:#7dd3fc;text-decoration:underline;cursor:pointer">why?</span>';
      reco.__topPid = top[0].p.player_id;
      reco.style.display = 'block';
    } else {
      reco.style.display = 'none';
    }
  }

  let pickPollTrigger = null;
  let lastPickPoll = 0;

  let scanScheduled = false;
  function scheduleScan() {
    if (pickPollTrigger && Date.now() - lastPickPoll > 1200) pickPollTrigger();
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 400);
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  (async function boot() {
    detectMyIdentity();
    try {
      if (isSleeper) await detectSleeperDraft();
      else await watchEspnPicks();
      await loadBoard();
    } catch (e) {
      setPill('board fetch FAILED — ' + e.message);
      return;
    }
    if (autoShowHelp) toggleHelp(true);
    scan();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setInterval(scan, 4000); // safety net for virtualized lists
  })();
})();
