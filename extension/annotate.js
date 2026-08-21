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
  pill.title = 'Draft assistant annotator status (click to hide)';
  pill.addEventListener('click', () => pill.remove());
  document.documentElement.appendChild(pill);
  function setPill(t) { pill.textContent = 'FFA: ' + t; }

  const state = {
    byName: new Map(),   // normalized name -> [player, ...]
    badges: new Map(),   // player_id -> Set<badge el>
    currentPick: 1,
    format: 'sf_ppr',
    mode: 'redraft',
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
    for (const p of board.players) {
      const k = norm(p.name);
      if (!state.byName.has(k)) state.byName.set(k, []);
      state.byName.get(k).push(p);
    }
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
      // poll pick count for steal deltas
      setInterval(async () => {
        try {
          const picks = await xfetch(`${SLEEPER}/v1/draft/${m[1]}/picks`);
          setCurrentPick((picks || []).length + 1);
        } catch (_) {}
      }, 5000);
    } catch (_) {}
  }

  function watchEspnPicks() {
    state.format = '1qb_ppr';
    if (!isExt) return;
    try {
    chrome.storage.local.get(['espnDraft'], (v) => {
      if (v.espnDraft) setCurrentPick(v.espnDraft.picks.length + 1);
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.espnDraft && ch.espnDraft.newValue) {
        setCurrentPick(ch.espnDraft.newValue.picks.length + 1);
      }
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
      margin-left: 5px;
      padding: 0 4px;
      border-radius: 4px;
      font: 700 10px/1.5 Menlo, monospace;
      background: rgba(15, 17, 21, 0.85);
      color: #7dd3fc;
      border: 1px solid rgba(125, 211, 252, 0.35);
      vertical-align: middle;
      white-space: nowrap;
    }
    .ffa-badge.ffa-steal { color: #4ade80; border-color: rgba(74, 222, 128, 0.45); }
    .ffa-badge.ffa-t1 { color: #facc15; border-color: rgba(250, 204, 21, 0.45); }
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
    el.textContent = badgeText(p);
    const delta = state.currentPick - p.overall_rank;
    el.classList.toggle('ffa-steal', state.currentPick > 1 && delta >= 6);
    el.classList.toggle('ffa-t1', p.tier === 1 && !(state.currentPick > 1 && delta >= 6));
  }

  function annotate(el, p) {
    const b = document.createElement('span');
    b.className = 'ffa-badge';
    b.__ffaPlayer = p;
    b.title = `${p.name} — our #${p.overall_rank} overall, ${p.position}${p.pos_rank} tier ${p.tier}` +
      (p.dynasty_value ? ` · dynasty ${p.dynasty_value}` : '') +
      (p.market_value ? ` · market ${p.market_value}` : '') +
      (p.injury_status ? ` · ${p.injury_status}` : '');
    updateBadge(b);
    el.appendChild(b);
    el.dataset.ffaTagged = '1';
    if (!state.badges.has(p.player_id)) state.badges.set(p.player_id, new Set());
    state.badges.get(p.player_id).add(b);
  }

  // ── Scanning ──────────────────────────────────────────────────────────
  function scan() {
    if (!state.byName.size) return;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.dataset && node.dataset.ffaTagged) return NodeFilter.FILTER_REJECT;
        if (node.classList && node.classList.contains('ffa-badge')) return NodeFilter.FILTER_REJECT;
        if (node.childElementCount > 0) return NodeFilter.FILTER_SKIP;
        const t = node.textContent;
        if (!t || t.length < 4 || t.length > 32) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    let n = 0;
    while ((node = walker.nextNode()) && n < 20000) {
      n += 1;
      const matches = state.byName.get(norm(node.textContent.trim()));
      if (!matches) continue;
      // Ambiguous names: skip unless exactly one candidate (safe default).
      if (matches.length === 1) annotate(node, matches[0]);
    }
    setPill(`${state.byName.size} players on board · ${state.badges.size} matched on page` +
      (state.badges.size === 0 ? ' — no names matched yet (scrolling the player list helps)' : ''));
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 400);
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  (async function boot() {
    try {
      if (isSleeper) await detectSleeperDraft();
      else watchEspnPicks();
      await loadBoard();
    } catch (e) {
      setPill('board fetch FAILED — ' + e.message);
      return;
    }
    scan();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setInterval(scan, 4000); // safety net for virtualized lists
  })();
})();
