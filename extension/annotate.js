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
  function xfetch(url, creds) {
    if (!isExt || !chrome.runtime || !chrome.runtime.sendMessage || TEST) {
      return fetch(url, creds ? { credentials: 'include' } : undefined).then((r) => r.json());
    }
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'ffa-fetch', url, creds: !!creds }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'fetch failed'));
          resolve(resp.json);
        });
      } catch (e) { reject(e); }
    });
  }

  // ── Scoreboard-graphite design tokens (claude.ai/design "Draft Advisor
  // Panel", direction 4a): warm graphite panels, amber accent, square
  // corners, mono everywhere. oklch is fine — Chrome-only surface.
  const UI = {
    panelBg: 'oklch(0.2 0.008 70)',
    footBg: 'oklch(0.14 0.008 70)',
    line: 'oklch(0.28 0.01 70)',    // hairlines inside the panel
    line2: 'oklch(0.3 0.01 70)',    // slightly brighter hairline
    border: 'oklch(0.34 0.012 70)', // outer frame
    amber: 'oklch(0.78 0.15 75)',   // accent block bg
    amberDark: 'oklch(0.2 0.03 75)',// text on amber
    amberText: 'oklch(0.8 0.13 75)',
    amberSoft: 'oklch(0.42 0.07 75)',
    bright: 'oklch(0.95 0.005 80)',
    text: 'oklch(0.9 0.008 80)',
    mid: 'oklch(0.72 0.02 70)',
    dim: 'oklch(0.6 0.02 70)',
    faint: 'oklch(0.58 0.02 70)',
    red: 'oklch(0.76 0.15 30)',
    redDim: 'oklch(0.68 0.08 30)',
    redSoft: 'oklch(0.38 0.06 30)',
    redCell: 'oklch(0.3 0.05 30)',
    mono: "'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace",
    sans: "'IBM Plex Sans',system-ui,-apple-system,sans-serif",
    shadow: '0 16px 36px -20px oklch(0.2 0.02 70 / 0.6), 0 8px 30px rgba(0,0,0,.45)',
  };
  const LBL = `font-family:${UI.mono};font-size:9px;letter-spacing:0.12em;color:${UI.dim}`;

  // On-page status pill: makes the annotator's state visible instead of
  // failing silently. Click to dismiss.
  const pill = document.createElement('div');
  pill.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:2147483645;' +
    `background:${UI.footBg};color:${UI.dim};border:1px solid ${UI.border};` +
    `padding:3px 8px;font:11px ${UI.mono};cursor:pointer`;
  pill.setAttribute('data-ffa-own', '');
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
    `background:${UI.footBg};color:${UI.text};border:1px solid ${UI.border};` +
    `box-shadow:${UI.shadow};font:11px/1 ${UI.mono};cursor:pointer;display:none;` +
    'align-items:stretch;flex-wrap:wrap;max-width:calc(100vw - 20px)';
  reco.setAttribute('data-ffa-own', '');
  reco.title = 'Best picks for your roster right now (click to jump to the top player if visible)';
  document.documentElement.appendChild(reco);
  reco.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id === 'ffa-why') { toggleAudit(); return; }
    // Username lookup is a Sleeper concept; on ESPN the team is detected
    // from the user's own picks, so prompting here would mislead.
    if (isSleeper && !state.myCounts && !state.myUserId) {
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
  // Tabbed scoreboard panel (design 4a): VERDICT / WAIT COST / UNTIL #n.
  const auditEl = document.createElement('div');
  auditEl.style.cssText = 'position:fixed;bottom:78px;left:10px;z-index:2147483646;' +
    'width:640px;max-width:calc(100vw - 20px);max-height:72vh;overflow-y:auto;' +
    `background:${UI.panelBg};color:${UI.text};border:1px solid ${UI.border};` +
    `box-shadow:${UI.shadow};font:11px/1.5 ${UI.mono};display:none`;
  auditEl.setAttribute('data-ffa-own', '');
  document.documentElement.appendChild(auditEl);
  let auditTab = 'verdict';
  auditEl.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ffa-tab]');
    if (t) { auditTab = t.getAttribute('data-ffa-tab'); renderAudit(); }
  });
  function toggleAudit() {
    const open = auditEl.style.display === 'none';
    if (open) { renderAudit(); auditEl.style.display = 'block'; }
    else auditEl.style.display = 'none';
    const w = reco.querySelector('#ffa-why');
    if (w) w.textContent = open ? 'hide' : 'why?';
  }

  const kfmt = (v) => (v / 1000).toFixed(1) + 'k';
  // Last name, sans suffixes — the footer bar speaks in surnames.
  const lastName = (name) => {
    const parts = String(name).trim().split(/\s+/)
      .filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w));
    return parts[parts.length - 1] || String(name);
  };

  function renderAudit() {
    const a = state.audit;
    if (!a || !a.top || !a.top.length) {
      auditEl.innerHTML = `<div style="padding:14px 16px;color:${UI.dim}">No recommendation computed yet.</div>`;
      return;
    }
    const tab = (id, label) => {
      const on = auditTab === id;
      return `<div data-ffa-tab="${id}" style="font-family:${UI.mono};font-size:10px;font-weight:600;` +
        `letter-spacing:0.14em;padding:9px 14px;cursor:pointer;` +
        `background:${on ? UI.line : 'transparent'};color:${on ? UI.bright : UI.dim}">${label}</div>`;
    };
    let h = `<div style="display:flex;align-items:stretch;border-bottom:1px solid ${UI.line2}">` +
      tab('verdict', 'VERDICT') + tab('wait', 'WAIT COST') +
      tab('until', a.la ? `UNTIL #${a.la.next}` : 'ROSTER') +
      '<div style="flex:1"></div>' +
      `<div style="font-family:${UI.mono};font-size:10px;letter-spacing:0.08em;color:${UI.faint};` +
      `padding:10px 14px;display:flex;align-items:center">PICK #${a.pick}` +
      (a.round ? ` · RND ${a.round}` : '') + '</div></div>';

    if (auditTab === 'wait') h += waitTabHtml(a);
    else if (auditTab === 'until') h += untilTabHtml(a);
    else h += verdictTabHtml(a);
    auditEl.innerHTML = h;
  }

  // VERDICT: the pick as a scoreboard hero — position block, name, stat
  // strip, and what the next-best lineups finish at.
  function verdictTabHtml(a) {
    const t0 = a.top[0];
    const bench = a.phase === 'bench';
    let h = `<div style="display:flex;align-items:stretch;border-bottom:1px solid ${UI.line}">` +
      `<div style="background:${UI.amber};color:${UI.amberDark};width:84px;flex:0 0 auto;` +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px 0">' +
        `<div style="font-family:${UI.mono};font-size:24px;font-weight:600;line-height:1">${t0.pos}</div>` +
        (t0.posRank
          ? `<div style="font-family:${UI.mono};font-size:10px;letter-spacing:0.08em;opacity:0.75">RANK ${t0.posRank}</div>`
          : '') +
      '</div>' +
      '<div style="flex:1;padding:15px 18px;min-width:0">' +
        `<div style="font-family:${UI.sans};font-size:26px;font-weight:700;color:oklch(0.97 0.005 80);` +
        `letter-spacing:-0.01em;text-transform:uppercase;line-height:1.1">${t0.name}</div>` +
        `<div style="font-family:${UI.mono};font-size:11px;color:${UI.mid};margin-top:5px">` +
          [t0.team, kfmt(t0.value),
           t0.plan == null ? null : `finishes starters ${kfmt(t0.plan)}`,
           `score ${Math.round(t0.score)}`].filter(Boolean).join(' · ') +
        '</div></div></div>';
    if (!a.counts) {
      h += `<div style="padding:10px 18px;border-bottom:1px solid ${UI.line};color:${UI.red}">` +
        'roster unknown — click the bar to set your username</div>';
    }

    const cells = [];
    if (bench) cells.push(['VALUE', kfmt(t0.value), UI.bright]);
    else cells.push(['OVER LINE', '+' + kfmt(t0.vorp), UI.bright]);
    cells.push(['IF YOU WAIT', '−' + kfmt(t0.drop || 0), (t0.drop || 0) >= 300 ? UI.red : UI.dim]);
    cells.push(['NEED', '×' + t0.mult.toFixed(2), UI.bright]);
    if (a.repl && a.repl[t0.pos] != null) cells.push([`${t0.pos} LINE`, kfmt(a.repl[t0.pos]), 'oklch(0.8 0.01 80)']);
    h += `<div style="display:grid;grid-template-columns:repeat(${cells.length},1fr);border-bottom:1px solid ${UI.line}">` +
      cells.map(([label, val, color], i) =>
        `<div style="padding:12px 14px;${i < cells.length - 1 ? `border-right:1px solid ${UI.line};` : ''}">` +
        `<div style="${LBL}">${label}</div>` +
        `<div style="font-family:${UI.mono};font-size:17px;color:${color};margin-top:4px">${val}</div></div>`
      ).join('') + '</div>';

    if (a.top.length > 1) {
      h += `<div style="padding:13px 18px 16px"><div style="${LBL};margin-bottom:9px">IF NOT HIM</div>`;
      const base = t0.plan == null ? t0.score : t0.plan;
      a.top.slice(1).forEach((t, i) => {
        const ref = t.plan == null ? t.score : t.plan;
        const pct = base > 0 ? Math.max(6, Math.min(100, Math.round((ref / base) * 100))) : 0;
        const fill = i === 0 ? 'oklch(0.55 0.06 75)' : 'oklch(0.48 0.04 75)';
        const right = t.plan == null
          ? kfmt(t.value)
          : `${kfmt(t.plan)} <span style="color:${UI.dim};font-size:10px">−${kfmt(Math.max(0, base - t.plan))}</span>`;
        h += '<div style="display:flex;align-items:center;gap:12px;padding:7px 0">' +
          `<div style="font-family:${UI.mono};font-size:11px;color:${UI.dim};width:10px;flex:0 0 auto">${i + 2}</div>` +
          `<div style="font-family:${UI.mono};font-size:12px;color:${UI.text};width:190px;flex:0 0 auto;` +
          `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.name} ${t.pos}${t.posRank || ''} ${kfmt(t.value)}</div>` +
          `<div style="flex:1;height:6px;background:${UI.line}"><div style="width:${pct}%;height:100%;background:${fill}"></div></div>` +
          `<div style="font-family:${UI.mono};font-size:12px;color:${UI.text};width:84px;flex:0 0 auto;text-align:right">${right}</div>` +
          '</div>';
      });
      h += '</div>';
    }
    return h;
  }

  // WAIT COST: per-position — best now vs expected at my next pick vs the
  // full-run worst case, sorted by how much value vanishes.
  function waitTabHtml(a) {
    const t0 = a.top[0];
    const rows = a.positions.filter((r) => r.now).slice()
      .sort((x, y) => (y.drop || 0) - (x.drop || 0));
    const anyWorst = rows.some((r) => r.worst);
    const cols = anyWorst ? '32px 1fr 1fr 1fr 56px' : '32px 1fr 1fr 72px';
    let h = '<div style="padding:15px 18px 16px">' +
      `<div style="display:grid;grid-template-columns:${cols};gap:8px;font-family:${UI.mono};font-size:9px;` +
      `letter-spacing:0.1em;color:${UI.dim};padding-bottom:9px;border-bottom:1px solid ${UI.line2}">` +
      `<div></div><div>BEST NOW</div><div>${a.la ? 'AT #' + a.la.next : 'LATER'}</div>` +
      (anyWorst ? '<div>IF A RUN</div>' : '') +
      '<div style="text-align:right">VANISH</div></div>' +
      `<div style="display:grid;grid-template-columns:${cols};gap:13px 8px;align-items:center;` +
      `padding-top:13px;font-family:${UI.mono};font-size:12px">`;
    for (const r of rows) {
      const drop = r.drop || 0;
      const dropColor = drop >= 800 ? UI.red : drop >= 300 ? UI.amberText : UI.dim;
      const runHot = r.worst && r.nb && (r.nb.value - r.worst.value) >= 400;
      const held = r.eligible ? '' : ` <span style="color:${UI.faint};font-size:10px">held</span>`;
      h += `<div style="color:${r.pos === t0.pos ? UI.amberText : 'oklch(0.82 0.01 80)'};font-weight:600">${r.pos}</div>` +
        `<div style="color:${UI.bright}">${r.now.name} ${kfmt(r.now.value)}${held}</div>` +
        `<div style="color:${UI.mid}">${r.nb ? r.nb.name + ' ' + kfmt(r.nb.value) : '—'}</div>` +
        (anyWorst
          ? `<div style="color:${r.worst ? (runHot ? UI.redDim : UI.mid) : UI.faint}">` +
            `${r.worst ? r.worst.name + ' ' + kfmt(r.worst.value) : '—'}</div>`
          : '') +
        `<div style="text-align:right;color:${dropColor};font-weight:600">−${kfmt(drop)}</div>`;
    }
    h += '</div>';

    const rules = ['Score = (points over replacement + vanishing + 3% tiebreak) × need.'];
    if (a.phase === 'filling starters') rules.push('Players who can\'t fill an open starting slot are excluded.');
    if (a.phase === 'bench') {
      if (a.teams >= 12) rules.push(`${a.teams}-team league: thinner wire — one backup-QB dart allowed (×0.4).`);
      else if (a.myQBLate) rules.push('Late-round QB1: one upside backup-QB dart allowed (×0.3).');
      else rules.push('QB2/TE2 held to ×0.12 — this wire is rich enough to stream.');
    }
    if (a.teFilled) rules.push('TE slot filled: TE2s don\'t qualify for flex (their price is slot scarcity, not points).');
    if (a.usedGatedFallback) rules.push('No eligible starter-fillers left — showing held players as fallback.');
    if (a.la && a.rosterAware) {
      rules.push('Room model: each team before your next pick takes its best-value need (we track every roster); ' +
        '"if a run" = every team that could start the position takes it.');
    } else if (a.la) {
      rules.push('Room model: top values go first; QBs capped at 1/3 of picks in 1QB rooms (rosters unknown).');
    }
    h += `<div style="font-family:${UI.mono};font-size:10px;line-height:1.6;color:${UI.dim};` +
      `margin-top:15px;padding-top:12px;border-top:1px solid ${UI.line2}">${rules.join(' ')}</div></div>`;
    return h;
  }

  // UNTIL #n: the picks between my turns as a timeline of the room model's
  // expected takes, plus roster and board state.
  function untilTabHtml(a) {
    const t0 = a.top[0];
    let h = '<div style="padding:15px 18px 16px">';
    if (a.la) {
      h += '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px">' +
        `<div style="${LBL}">${a.la.removals} PLAYERS GO BEFORE YOU</div>` +
        (a.runRisk
          ? `<div style="font-family:${UI.mono};font-size:10px;color:${UI.amberText}">⚠ ${a.runRisk.pos} run risk</div>`
          : '') +
        '</div>';
      if (a.timeline) {
        const byPick = new Map(a.timeline.map((t) => [t.pick, t.pos]));
        const cells = [];
        for (let pn = a.pick; pn <= a.la.next; pn++) {
          let bar; let label; let labelColor; let extra = '';
          if (pn === a.pick) {
            bar = UI.amber; label = `${pn} you`; labelColor = UI.amberText;
          } else if (pn === a.la.next) {
            bar = 'oklch(0.5 0.1 75)'; label = `${pn} you`; labelColor = UI.amberText;
            extra = 'border:1px dashed oklch(0.82 0.14 75);box-sizing:border-box;';
          } else {
            const pos = byPick.get(pn);
            const row = pos && a.positions.find((r) => r.pos === pos);
            if (pos && pos === t0.pos) {
              bar = UI.redSoft; label = `${pn} ${pos}`; labelColor = 'oklch(0.72 0.09 30)';
            } else if (row && row.eligible) {
              bar = UI.amberSoft; label = `${pn} ${pos}`; labelColor = 'oklch(0.75 0.09 75)';
            } else {
              bar = UI.line; label = `${pn}`; labelColor = UI.faint;
            }
          }
          cells.push('<div style="display:flex;flex-direction:column;gap:5px;align-items:center;min-width:0">' +
            `<div style="width:100%;height:28px;background:${bar};${extra}"></div>` +
            `<div style="font-family:${UI.mono};font-size:9px;color:${labelColor};white-space:nowrap">${label}</div></div>`);
        }
        h += `<div style="display:grid;grid-template-columns:repeat(${cells.length},1fr);gap:5px">` +
          cells.join('') + '</div>';
        const risky = a.positions.filter((r) =>
          r.eligible && r.now && r.nb && r.worst && (r.nb.value - r.worst.value) >= 400);
        h += `<div style="font-family:${UI.mono};font-size:10px;line-height:1.6;color:${UI.dim};margin-top:12px">` +
          'Cells are the room model\'s expected takes (red = your pick\'s position). ' +
          (risky.length
            ? 'If a full run: ' + risky.map((r) => `${r.now.name} → ${r.worst.name} ${kfmt(r.worst.value)}`).join(' · ') + '.'
            : 'No position looks run-prone before your next turn.') +
          '</div>';
      } else {
        h += `<div style="font-family:${UI.mono};font-size:10px;color:${UI.dim};margin-bottom:4px">` +
          'Rosters unknown — room modeled as top values going first.</div>';
      }
    } else {
      h += `<div style="color:${UI.dim};margin-bottom:4px">lookahead off — draft slot unknown (ESPN or no draft order)</div>`;
    }

    h += `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:15px;` +
      `padding-top:13px;border-top:1px solid ${UI.line2}">`;
    h += `<div><div style="${LBL};margin-bottom:8px">YOUR ROSTER</div>`;
    if (a.counts) {
      h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px">';
      for (const pos of ['QB', 'RB', 'WR', 'TE']) {
        const need = a.dedicatedOpen && (a.dedicatedOpen[pos] || 0) > 0;
        h += `<div style="text-align:center;padding:8px 0;background:${need ? UI.redCell : UI.line}">` +
          `<div style="font-family:${UI.mono};font-size:15px;font-weight:600;` +
          `color:${need ? 'oklch(0.86 0.1 30)' : 'oklch(0.92 0.008 80)'}">${a.counts[pos] || 0}</div>` +
          `<div style="font-family:${UI.mono};font-size:9px;` +
          `color:${need ? 'oklch(0.74 0.05 30)' : 'oklch(0.68 0.02 70)'}">${pos}</div></div>`;
      }
      h += '</div>';
    } else {
      h += `<div style="color:${UI.red};font-size:11px">unknown — click the bar to set your username</div>`;
    }
    h += '</div>';

    const opens = [];
    if (a.dedicatedOpen) {
      for (const [pos, n] of Object.entries(a.dedicatedOpen)) if (n > 0) opens.push(n + pos);
    }
    if (a.flexOpen > 0) opens.push(a.flexOpen + 'FLEX');
    const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px;` +
      `font-family:${UI.mono};font-size:11px"><span style="color:oklch(0.66 0.02 70)">${k}</span>` +
      `<span style="color:oklch(0.92 0.008 80);text-align:right">${v}</span></div>`;
    h += `<div><div style="${LBL};margin-bottom:8px">BOARD</div>` +
      '<div style="display:flex;flex-direction:column;gap:6px">' +
      row('players on board', a.boardCount != null ? a.boardCount : '—') +
      row('matched on page', a.matchedCount != null ? a.matchedCount : '—') +
      row('open slots', a.counts ? (opens.length ? opens.join(' ') : 'none — bench') : '—') +
      (a.roster
        ? row('picks left', a.roster.remaining + (a.roster.reserve > 0 ? ` (save ${a.roster.reserve} K/DST)` : ''))
        : '') +
      '</div></div></div></div>';
    return h;
  }

  // ── Explainer sidebar (auto-opens on load; pill toggles it) ──────────
  const HELP_KEY = 'ffaHideHelp';
  let helpEl = null;

  function buildHelp() {
    const el = document.createElement('div');
    el.id = 'ffa-help';
    el.setAttribute('data-ffa-own', '');
    el.style.cssText =
      'position:fixed;top:70px;right:12px;width:280px;z-index:2147483645;' +
      `background:${UI.panelBg};color:${UI.text};border:1px solid ${UI.border};` +
      `box-shadow:${UI.shadow};font:12px/1.55 ${UI.mono};padding:0`;
    el.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;` +
      `padding:9px 14px;border-bottom:1px solid ${UI.line2}">` +
        `<span style="font-size:10px;font-weight:600;letter-spacing:0.14em;color:${UI.bright}">WHAT THE NUMBERS MEAN</span>` +
        `<span id="ffa-help-x" style="cursor:pointer;color:${UI.dim}">✕</span>` +
      '</div>' +
      '<div style="padding:12px 14px">' +
      '<div style="margin-bottom:8px"><span class="ffa-badge">1.8k T3 ↑11</span></div>' +
      `<div style="color:${UI.dim};margin-bottom:8px">` +
        `<b style="color:${UI.bright}">1.8k</b> — our value for this player on a 0–10k scale ` +
        '(blend of RosterAudit + real-trade market data, refreshed daily; redraft values in seasonal drafts).<br>' +
        `<b style="color:${UI.bright}">T3</b> — tier at the position. Big value gaps set the tier breaks; ` +
        'drafting before a tier ends beats reaching into the next one.<br>' +
        `<b style="color:${UI.bright}">↑11</b> — falling value: ranked 11 picks earlier than where the draft is now.` +
      '</div>' +
      '<div style="margin-bottom:6px"><span class="ffa-badge ffa-best">★ 5.2k T1</span> ' +
        `<span style="color:${UI.dim}">our top pick for YOUR roster — weighs points over replacement ` +
        'AND what will be gone by your next turn; until your lineup is full, only players who can ' +
        `fill an open starting slot are recommended. Click <b style="color:${UI.amberText}">why?</b> on the ` +
        'bar for the full reasoning behind the current pick.</span></div>' +
      '<div style="margin-bottom:6px"><span class="ffa-badge ffa-good">3.1k T2</span> ' +
        `<span style="color:${UI.dim}">next-best two options</span></div>` +
      '<div style="margin-bottom:8px"><span class="ffa-badge ffa-steal">2.0k T3 ↑9</span> ' +
        `<span style="color:${UI.dim}">green = value falling to you</span></div>` +
      `<div style="color:${UI.dim};margin-bottom:10px">Hover any badge for full detail. ` +
        'No badge = outside our ~190 ranked players.</div>' +
      `<label style="color:${UI.dim};display:block;margin-bottom:8px;cursor:pointer">` +
        '<input type="checkbox" id="ffa-help-hide" style="vertical-align:middle"> don\'t show automatically</label>' +
      `<div id="ffa-help-ok" style="text-align:center;border:1px solid ${UI.border};` +
        `padding:6px;cursor:pointer;color:${UI.amberText};font-weight:600;font-size:10px;letter-spacing:0.1em">GOT IT</div>` +
      '</div>';
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
    domHistory: null,    // ESPN Pick History scrape: [{espn_id, team_id:null, pick_no}]
    espnReapply: null,   // set by the ESPN adapter; re-runs applyEspn after a scrape
    espnGapSeen: false,  // gap observed and not yet provably healed (survives a pause)
    rosterHelp: 'roster unknown — click to set username', // platform-accurate bar hint
    updatingPid: null,   // top pick whose row vanished — data is catching up
    updatingSince: 0,
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

  // ESPN's own pick counter, read from the draft room header ("ON THE
  // CLOCK: PICK 15"). A cross-check on how many picks we believe have
  // happened — never a data source. Requires the "ON THE CLOCK" prefix so
  // our own strip ("* PICK: ...") cannot match itself.
  function espnPickFromDom() {
    try {
      const t = ((document.body && document.body.textContent) || '').slice(0, 20000);
      const m = t.match(/ON THE CLOCK\D{0,24}?(\d{1,3})/i);
      const n = m ? Number(m[1]) : 0;
      return n > 0 && n < 1000 ? n : null;
    } catch (_) { return null; }
  }

  // ── DOM sampling (diagnostics) ────────────────────────────────────────
  // Capture a small structural sample of the draft room so its markup can
  // be analysed offline. Stored rather than logged, so it exports from the
  // side panel's "copy diagnostics" button with no console involved.
  //
  // Two things need this: ESPN's Pick History tab, which is the page's own
  // complete record of who has been drafted (and therefore the only
  // recoverable source for picks missed during an outage in a mock), and
  // the player-row markup for badge placement.
  //
  // Read-only, truncated, and throttled — it must never cost anything on
  // a page we do not own.
  // Group rows by a coarse signature (cell count + the shape of the first
  // cell) and return one example of each. Guarantees every table on the
  // page is represented regardless of DOM order or how many rows it has.
  function shapeSig(cells) {
    const first = cells[0] || '';
    const kind = /^\d+$/.test(first) ? 'int'
      : /^\d{1,2}\.\d{1,2}$/.test(first) ? 'dotted'
      : /^R\d/i.test(first) ? 'round'
      : /^\d/.test(first) ? 'numish' : 'text';
    return `${cells.length}:${kind}`;
  }

  let lastDomSample = 0;
  function captureDomSample() {
    if (!isExt) return;
    const now = Date.now();
    if (now - lastDomSample < 8000) return;
    lastDomSample = now;
    try {
      const clip = (el, n) => (el && el.outerHTML ? el.outerHTML.slice(0, n) : null);
      const txt = (el) => (el && el.textContent ? el.textContent.trim().slice(0, 120) : '');
      // ONLY cellContent: [role="gridcell"] is its parent, so matching both
      // returned every value twice ("69","69","Luther Burden III...",...).
      const cellsOf = (r) => [...r.querySelectorAll('.public_fixedDataTableCell_cellContent')]
        .map(txt).filter(Boolean).slice(0, 8);

      // ESPN's main tables are FixedDataTable: divs with role=row /
      // role=gridcell, NOT <tr>. The only <tr> on the page belong to the
      // sidebar (pick queue, roster), which is why an earlier sample of
      // <tr> captured nothing useful.
      const roleRows = [...document.querySelectorAll('[role="row"]')];
      const sampleShapes = (rows) => {
        const seen = new Map();
        for (const r of rows) {
          const c = cellsOf(r);
          if (!c.length) continue;
          const sig = shapeSig(c);
          if (seen.has(sig)) { seen.get(sig).count += 1; continue; }
          seen.set(sig, { sig, count: 1, cells: c, html: clip(r, 700) });
          if (seen.size >= 8) break;
        }
        return [...seen.values()];
      };
      const active = document.querySelector('[role="tab"][aria-selected="true"]');

      const sample = {
        at: now,
        activeTab: txt(active) || null,
        roleRowCount: roleRows.length,
        trCount: document.querySelectorAll('tr').length,
        // One row of each distinct SHAPE, not the first N. Every tab's
        // table is in the DOM at once and the player list comes first, so
        // slicing the top rows only ever sampled that one — the pick
        // history sat further down, unsampled, even with its tab active.
        shapes: sampleShapes(roleRows),
      };
      try { chrome.storage.local.set({ espnDomSample: sample }); } catch (_) {}

      // Pick history is only in the DOM while its tab is open, and that is
      // a moment we cannot schedule. So recognise it whenever it appears
      // and keep it STICKY — the user opens the tab once, whenever suits
      // them, and the sample survives going back to the player list.
      //
      // Recognised on the FIRST cell alone being a pick label ("1.04",
      // "R1"). Matching anywhere in the row would misfire on ordinary
      // decimal stats — an earlier heuristic matched a 77.2 projection.
      // "77.2" fits any loose round.pick pattern (77 and 2 are both 1-2
      // digits) and is a points projection, not a pick — the same false
      // positive that spoiled the previous heuristic. Bound it NUMERICALLY
      // instead: no draft has a round 77.
      const isPickLabel = (t) => {
        const dot = /^(\d{1,2})\.(\d{1,2})$/.exec(t);
        if (dot) {
          const rd = Number(dot[1]); const pk = Number(dot[2]);
          return rd >= 1 && rd <= 30 && pk >= 1 && pk <= 32;
        }
        const rp = /^R(\d{1,2})(?:\s*P(\d{1,2}))?$/i.exec(t);
        return !!rp && Number(rp[1]) >= 1 && Number(rp[1]) <= 30;
      };
      const histRows = roleRows.filter((r) => {
        const c = cellsOf(r);
        return c.length >= 2 && isPickLabel(c[0]);
      });
      if (histRows.length >= 2) {
        chrome.storage.local.get(['espnHistorySample'], (v) => {
          const prev = v && v.espnHistorySample;
          // Keep the richest capture seen, so a half-rendered virtualised
          // list cannot overwrite a good one.
          if (prev && (prev.rowCount || 0) > histRows.length) return;
          try {
            chrome.storage.local.set({ espnHistorySample: {
              at: now,
              activeTab: txt(active) || null,
              rowCount: histRows.length,
              rows: histRows.slice(0, 3).map((r) => clip(r, 1100)),
              cells: histRows.slice(0, 12).map((r) => cellsOf(r)),
            } });
          } catch (_) {}
        });
      }
    } catch (_) { /* diagnostics must never break the page */ }
  }

  // ── ESPN Pick History recovery ────────────────────────────────────────
  // In a MOCK draft, picks missed during an outage (refresh, socket drop)
  // are unrecoverable from the API: draftDetail is never written and the
  // INIT frame is opaque binary. But ESPN's own Pick History tab renders
  // the complete record. When the room reports more picks than we know
  // (state.espnGap), the pill asks the user to open that tab once; while
  // its rows are in the DOM we read them and merge the recovered picks
  // back into the adapter (which re-applies via state.espnReapply).
  //
  // Deliberately NOT persisted: a stored history from mock A would poison
  // mock B (same storage, different rooms). The DOM is re-scrapable on
  // demand, so a second refresh just re-prompts.

  // Rows-of-cell-texts → [{pick_no, rest, idx}]. A live capture (paused
  // mock, v0.8.0) showed the real Pick History labels its rows with PLAIN
  // OVERALL pick integers ("1".."13", continuing across "Round N" section
  // headers) — not the "3.04" style the sticky sampler guessed at (which
  // is why that sampler never fired). Integers are only safe because the
  // caller scopes rows to tables under a PICK/PLAYER/TEAM header — the
  // player list also starts rows with an integer (the rank), but its
  // header has no TEAM column. Dotted and R#P# forms are kept for other
  // room skins. (Lifted verbatim by espn-history-test.js.)
  function parseEspnHistoryCells(rows, teams, maxPick) {
    const out = new Map();
    for (let i = 0; i < (rows || []).length; i++) {
      const cells = rows[i];
      if (!cells || cells.length < 2) continue;
      const label = String(cells[0]).trim();
      let pick_no = 0;
      const dot = /^(\d{1,2})\.(\d{1,2})$/.exec(label);
      const rp = /^R(\d{1,2})\s*P(\d{1,2})$/i.exec(label);
      const whole = /^#?(\d{1,3})$/.exec(label);
      if (dot || rp) {
        const m = dot || rp;
        const rd = Number(m[1]);
        const pk = Number(m[2]);
        if (rd < 1 || rd > 30 || pk < 1 || pk > teams) continue;
        pick_no = (rd - 1) * teams + pk;
      } else if (whole) {
        pick_no = Number(whole[1]);
      } else continue;
      if (pick_no < 1 || pick_no > maxPick) continue;
      if (out.has(pick_no)) continue;
      out.set(pick_no, { rest: cells.slice(1), idx: i });
    }
    return [...out.entries()]
      .map(([pick_no, r]) => ({ pick_no, rest: r.rest, idx: r.idx }))
      .sort((a, b) => a.pick_no - b.pick_no);
  }

  // Which board player does a history row name? Cells carry composites
  // ("Josh Allen QB Buf"), so try the full text, then separator-trimmed
  // and word-prefix candidates. Splits only on separators that never occur
  // INSIDE a name — a hyphen split would break Amon-Ra St. Brown.
  // (Lifted verbatim by espn-history-test.js.)
  function resolveHistoryName(cells, lookup) {
    for (const cell of cells) {
      const t = String(cell).trim();
      if (t.length < 4 || t.length > 120) continue;
      const cands = [t];
      const cut = t.split(/[·•|,]|\s{2,}/)[0].trim();
      if (cut && cut !== t) cands.push(cut);
      const words = t.split(/\s+/);
      for (let n = Math.min(5, words.length - 1); n >= 2; n--) {
        cands.push(words.slice(0, n).join(' '));
      }
      for (const c of cands) {
        if (c.length < 4) continue;
        const p = lookup(c);
        if (p) return p;
      }
    }
    return null;
  }

  // Live-debugging breadcrumbs: the content script's world is unreachable
  // from the page console, so the interesting counters are stamped onto
  // <html> where any console (or agent) can read them.
  function stamp(attr, val) {
    try {
      if (document.documentElement.getAttribute(attr) !== val) {
        document.documentElement.setAttribute(attr, val);
      }
    } catch (_) {}
  }

  let lastHistScrape = 0;
  function scrapeEspnHistory() {
    if (isSleeper || !state.byName.size) return;
    // Only worth the DOM sweep when there is a gap to heal (or a previous
    // harvest to keep fresh) — a pre-gap harvest would be thrown away
    // anyway, since recovered history is deliberately not persisted.
    if (!state.espnGap && !state.espnGapSeen && !state.domHistory) {
      stamp('data-ffa-hist', 'idle');
      return;
    }
    const now = Date.now();
    if (now - lastHistScrape < 2000) return;
    lastHistScrape = now;
    try {
      const teams = state.lineup.teams || 10;
      const maxPick = (state.lineup.rounds || 17) * teams;

      // Anchor on the history table's own header: a row whose cells read
      // PICK / PLAYER / TEAM (each round section repeats it). Scoping rows
      // to those tables is what makes integer pick labels safe.
      const rowEls = [];
      const seenTables = new Set();
      const seenRows = new Set();
      const heads = [...document.querySelectorAll('th,td,div,span')].filter((e) =>
        e.childElementCount === 0 && /^pick$/i.test((e.textContent || '').trim()));
      for (const h of heads) {
        const headerRow = h.closest('tr,[role="row"]') || h.parentElement;
        if (!headerRow) continue;
        const ht = (headerRow.textContent || '').toUpperCase();
        if (!ht.includes('PLAYER') || !ht.includes('TEAM')) continue;
        const table = headerRow.closest('table,[role="table"],[role="grid"]') || headerRow.parentElement;
        if (!table || seenTables.has(table)) continue;
        seenTables.add(table);
        let rlist = [...table.querySelectorAll('tr,[role="row"]')];
        if (!rlist.length && headerRow.parentElement) rlist = [...headerRow.parentElement.children];
        for (const r of rlist) {
          if (r === headerRow || seenRows.has(r)) continue;
          seenRows.add(r);
          rowEls.push(r);
        }
      }
      if (!rowEls.length) { stamp('data-ffa-hist', 'no-rows'); return; }

      const cellRows = rowEls.map((r) => {
        let cs = [...r.querySelectorAll('.public_fixedDataTableCell_cellContent')];
        if (!cs.length) cs = [...r.querySelectorAll('td,th')];
        if (!cs.length) cs = [...r.children];
        return cs.map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 8);
      });
      const parsed = parseEspnHistoryCells(cellRows, teams, maxPick);
      if (!parsed.length) { stamp('data-ffa-hist', `rows:${rowEls.length} parsed:0`); return; }

      // Identify the player: headshot id (…/full/<id>.png) first, then an
      // exact board-name TEXT NODE inside the row (the badge scanner
      // already proves names render as exact text nodes there), then the
      // composite-cell heuristic as a last resort.
      const lookup = (s) => {
        const m = state.byName.get(norm(String(s)));
        return m && m.length === 1 ? m[0] : null;
      };
      const playerIn = (row) => {
        const img = row.querySelector('img[src*="/full/"]');
        const m = img && /\/full\/(\d+)\./.exec(img.getAttribute('src') || '');
        if (m) {
          const p = state.byEspn.get(m[1]);
          if (p) return p;
        }
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let t;
        let found = null;
        while ((t = walker.nextNode())) {
          const s = (t.nodeValue || '').trim();
          if (s.length < 4 || s.length > 32) continue;
          const pe = t.parentElement;
          if (pe && pe.closest('.ffa-badge')) continue;
          const p = lookup(s);
          if (p) {
            if (found && found !== p) return null; // two names in one row — distrust
            found = p;
          }
        }
        return found;
      };

      const picks = [];
      for (const row of parsed) {
        const p = playerIn(rowEls[row.idx]) || resolveHistoryName(row.rest, lookup);
        if (p && p.espn_id) {
          picks.push({ espn_id: String(p.espn_id), team_id: null, pick_no: row.pick_no });
        }
      }
      if (!picks.length) {
        stamp('data-ffa-hist', `rows:${rowEls.length} parsed:${parsed.length} picks:0`);
        return;
      }
      const prev = state.domHistory || [];
      const grown = picks.length !== prev.length ||
        picks.some((p, i) => !prev[i] || prev[i].espn_id !== p.espn_id || prev[i].pick_no !== p.pick_no);
      state.domHistory = picks;
      stamp('data-ffa-hist', `rows:${rowEls.length} parsed:${parsed.length} picks:${picks.length} ` +
        `grown:${grown} reapply:${!!state.espnReapply}`);
      // While a gap persists, re-apply on every scrape — not only when the
      // scrape output changes. A reapply missed once (for any reason) must
      // not latch the recovery off forever behind an unchanged `grown`.
      if ((grown || state.espnGap) && state.espnReapply) state.espnReapply();
    } catch (e) {
      stamp('data-ffa-hist', 'err:' + String((e && e.message) || e).slice(0, 120));
      /* recovery must never break the page */
    }
  }

  // ── League size, observed ─────────────────────────────────────────────
  // The draft that is actually running is the authority on how many teams
  // are in it — not a settings field, which can be stale, absent (ESPN
  // mocks expose no league API) or simply wrong.
  //
  // Every team picks exactly once per round, so the number of distinct
  // teams IS the league size. Trusted only once some team has picked
  // TWICE: that proves a full cycle completed and therefore that every
  // team has already appeared. Without that check a partial first round
  // would report a count that is merely "how many have picked so far".
  //
  // Shared by both platforms so they cannot drift — Sleeper passes
  // draft_slot, ESPN passes team_id.
  function observedTeamCount(keys) {
    const n = Object.create(null);
    let cycled = false;
    for (const k of keys) {
      if (k == null || k === '') continue;
      const key = String(k);
      n[key] = (n[key] || 0) + 1;
      if (n[key] > 1) cycled = true;
    }
    const distinct = Object.keys(n).length;
    // Floor of 4: fewer than that is not a real draft, and guards against a
    // malformed feed collapsing replacement levels to nonsense.
    return cycled && distinct >= 4 ? distinct : null;
  }

  // Adopt an observed count when it disagrees with whatever settings said.
  function applyTeamCount(observed) {
    if (!observed || observed === state.lineup.teams) return false;
    state.lineup = Object.assign({}, state.lineup, { teams: observed });
    computeReplacement();
    return true;
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
      state.rosterHelp = 'roster unknown — click to set username';
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
          // The running draft outranks settings.teams. Applied before the
          // block below, which uses lineup.teams to date my QB1's round.
          applyTeamCount(observedTeamCount((picks || []).map((p) => p.draft_slot)));
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
          // Lift the bar's "updating…" state once the vanished player
          // actually shows up in the API data, or write it off as a false
          // alarm (a scrolled-away row) after a few seconds.
          if (state.updatingPid &&
              (state.pickedIds.has(String(state.updatingPid)) ||
               Date.now() - state.updatingSince > 5000)) {
            state.updatingPid = null;
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
    // No username concept here — the team is recognized from the user's
    // own SELECTED frames (memberId rides only on own picks).
    state.rosterHelp = 'roster unknown — it registers on your first pick';
    // Explicit, not defaulted: Sam's ESPN leagues are seasonal, so the
    // board must price off redraft values (fc_redraft). If an ESPN dynasty
    // league ever matters, detect it here — the engine itself is mode-blind
    // and only the board fetch cares.
    state.mode = 'redraft';

    // Read the panel's persisted SF toggle FIRST so the mock fallback below
    // knows whether to shape a superflex lineup. A readable league overrides
    // it straight after — real settings beat a manual switch.
    if (isExt) {
      try {
        await new Promise((res) => chrome.storage.local.get(['espnSF'], (v) => {
          if (v.espnSF) state.format = 'sf_ppr';
          res();
        }));
      } catch (_) { /* orphaned after extension reload */ }
    }

    // Superflex detection for real ESPN leagues: their lineup settings are
    // readable in-session. Slot 7 is OP (QB-eligible superflex); QB slot
    // count > 1 also means 2QB.
    const qs = new URLSearchParams(location.search);
    const leagueId = qs.get('leagueId');
    // Prefer the URL's seasonId over the calendar year — an offseason draft
    // runs for NEXT season, and asking for the wrong year returns nothing.
    const season = qs.get('seasonId') || String(new Date().getFullYear());
    let leagueOk = false;
    if (leagueId && leagueId !== '0') {
      try {
        // Via the background proxy (page CSP blocks content-script fetches),
        // with creds so private leagues answer instead of 401ing.
        const j = await xfetch(
          `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mSettings`,
          true
        );
        const slots = (j && j.settings && j.settings.rosterSettings
          && j.settings.rosterSettings.lineupSlotCounts) || null;
        if (slots) {
          const n = (id) => slots[id] || 0;
          if (n('7') > 0 || n('0') > 1) state.format = 'sf_ppr';
          state.lineup = {
            teams: (j.settings && j.settings.size) || 10,
            qb: n('0') || 1,
            rb: n('2'),
            wr: n('4'),
            te: n('6'),
            // 23 = FLEX (RB/WR/TE), 3 = RB/WR, 5 = WR/TE. All three behave
            // as flex for replacement-level purposes.
            flex: n('23') + n('3') + n('5'),
            sf: n('7'),
            k: n('17'),
            dst: n('16'),
            // Rounds = every roster spot the draft actually fills: all
            // lineup slots INCLUDING bench (20), excluding IR (21) since
            // that is never drafted into. This was hardcoded to 16, which
            // silently mis-sized snake math, replacement baselines and the
            // "picks left" counter in any league that wasn't 16 rounds.
            rounds: Object.keys(slots).reduce((t, id) => (id === '21' ? t : t + n(id)), 0) || 16,
          };
          leagueOk = true;
          computeReplacement();
        }
      } catch (_) { /* mock lobby, logged out, or blocked — fallback below */ }
    }

    // Backfill for a mid-draft join. Our WebSocket tap only sees picks made
    // AFTER it connects: everything earlier arrives in ESPN's STATE frame,
    // which we do not parse. So reloading the extension or refreshing the
    // tab mid-draft would silently drop all pick history — the board would
    // show drafted players as available for the rest of the draft.
    //
    // ESPN's own draft-detail view is the fix, and a better one than
    // parsing STATE: it is format-independent, survives any protocol
    // change, and carries REAL overall pick numbers rather than the arrival
    // order we have to infer from frames. Fetched once at startup; the live
    // feed takes over from there.
    // Backfill for picks we never saw. The tap only observes picks made
    // while it is connected, so anything that happens during an outage —
    // socket drop, hung page, extension reload — is invisible to it. And a
    // refresh is usually PROVOKED by such an outage, so the missing window
    // is exactly the one that matters.
    //
    // Re-polled rather than fetched once, so a real league self-heals any
    // gap within one interval. Returns nothing for a practice draft (which
    // never writes to draftDetail), which is what pick persistence and the
    // gap detector below are for.
    state.espnBackfill = [];
    let backfillInfo = { tried: false };
    const fetchBackfill = async () => {
      if (!leagueId || leagueId === '0') return;
      try {
        const j = await xfetch(
          `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mDraftDetail`,
          true
        );
        const dd = (j && j.draftDetail) || null;
        const raw = (dd && dd.picks) || [];
        // draftDetail is PRE-ALLOCATED for the entire draft: an 8-team,
        // 17-round league returns all 136 entries from the moment it is
        // created, unmade picks carrying playerId -1. Test the NUMERIC
        // value — a string compare against '0' lets "-1" through.
        const made = raw.filter(
          (q) => Number(q.playerId) > 0 && Number(q.overallPickNumber) > 0
        );
        state.espnBackfill = made
          .map((q) => ({
            espn_id: String(q.playerId),
            team_id: q.teamId != null ? String(q.teamId) : null,
            pick_no: Number(q.overallPickNumber),
          }))
          .sort((a, b) => a.pick_no - b.pick_no);
        backfillInfo = {
          tried: true,
          hasDraftDetail: !!dd,
          drafted: dd ? dd.drafted : null,
          rawPicks: raw.length,
          usable: state.espnBackfill.length,
          unmadeIds: [...new Set(
            raw.filter((q) => !(Number(q.playerId) > 0)).map((q) => q.playerId)
          )].slice(0, 5),
        };
      } catch (e) {
        backfillInfo = { tried: true, error: String((e && e.message) || e) };
      }
      if (isExt) {
        try { chrome.storage.local.set({ espnBackfillInfo: backfillInfo }); } catch (_) {}
      }
    };
    await fetchBackfill();
    // Cheap (one request), and the only thing that can recover picks lost
    // to an outage in a real league. Re-applies through the adapter — the
    // old pickPollTrigger call was Sleeper-only and always null here, so
    // re-polled backfill silently waited for the next frame to matter.
    setInterval(() => {
      fetchBackfill().then(() => { if (state.espnReapply) state.espnReapply(); });
    }, 20000);

    // Mock-lobby fallback. Without it the lineup keeps the Sleeper-flavoured
    // defaults (15 rounds, no K/DST), so replacement levels and every snake
    // calculation are wrong for the whole draft.
    if (!leagueOk) {
      state.lineup = {
        teams: 10, qb: 1, rb: 2, wr: 2, te: 1, flex: 1,
        sf: state.format === 'sf_ppr' ? 1 : 0, k: 1, dst: 1, rounds: 16,
      };
      computeReplacement();
    }

    if (!isExt) return;
    try {
    state.draftType = 'snake';   // ESPN mocks and redraft leagues are snake

    let lastEspnDraft = null;
    const applyEspn = (d) => {
      lastEspnDraft = d;
      // Merge the backfill under the live feed. Backfilled picks carry real
      // overall numbers from ESPN; live picks continue from the highest of
      // them, since content-espn.js can only number by arrival order and
      // restarts at 1 on every reconnect. Between them sits the DOM-scraped
      // Pick History (mocks only): real pick numbers, no team ids — a live
      // duplicate fills the team id in rather than being dropped.
      const merged = [];
      const have = new Map();       // espn_id -> merged entry
      const usedPick = new Set();   // real pick numbers already occupied
      for (const b of state.espnBackfill || []) {
        if (have.has(b.espn_id)) continue;
        have.set(b.espn_id, b);
        usedPick.add(b.pick_no);
        merged.push(b);
      }
      for (const b of state.domHistory || []) {
        if (have.has(b.espn_id) || usedPick.has(b.pick_no)) continue;
        const e = { espn_id: b.espn_id, team_id: null, pick_no: b.pick_no };
        have.set(b.espn_id, e);
        usedPick.add(b.pick_no);
        merged.push(e);
      }
      let next = merged.reduce((m, b) => Math.max(m, b.pick_no), 0);
      for (const p of d.picks) {
        const id = String(p.espn_id);
        if (have.has(id)) {           // already known from backfill/history
          const e = have.get(id);
          if (e.team_id == null && p.team_id != null) e.team_id = String(p.team_id);
          continue;
        }
        const e = { espn_id: id, team_id: p.team_id, pick_no: ++next };
        have.set(id, e);
        merged.push(e);
      }
      merged.sort((a, b) => a.pick_no - b.pick_no);

      // The running draft outranks settings.size, and is the ONLY source in
      // a mock, where the league API exposes nothing. A live capture was an
      // 8-team draft against our 10-team default — which alone would have
      // kept the seating guard below from ever engaging.
      applyTeamCount(observedTeamCount(merged.map((p) => p.team_id)));

      const teams = state.lineup.teams || 10;

      // History-recovered picks carry no team id, but in a snake draft the
      // pick number determines the slot, and any other pick from the same
      // slot names the team — attribute them positionally so roster counts
      // and the run model see the recovered picks too. When numbering is
      // still gapped this can misattribute, but the seating guard refuses
      // in exactly that case, so nothing downstream trusts it.
      const slotOfPick = (pn) => {
        const rnd = Math.floor((pn - 1) / teams);
        const idx = (pn - 1) % teams;
        return rnd % 2 === 1 ? teams - idx : idx + 1;
      };
      const slotTeam = new Map();
      for (const p of merged) {
        if (p.team_id != null && p.pick_no != null && !slotTeam.has(slotOfPick(p.pick_no))) {
          slotTeam.set(slotOfPick(p.pick_no), String(p.team_id));
        }
      }
      for (const p of merged) {
        if (p.team_id == null && p.pick_no != null) {
          const t = slotTeam.get(slotOfPick(p.pick_no));
          if (t != null) p.team_id = t;
        }
      }

      // Phantom guard. The frame parser is heuristic and demonstrably
      // records the occasional non-pick — a live capture had a 30000 (a
      // pick-clock value) recorded as a player id, giving team 5 two picks
      // in round 1. A team drafts at most once per round, so a repeated
      // (team, round) is proof of a phantom.
      //
      // Resolve collisions in favour of the entry that MATCHES the board
      // rather than the one that arrived first: the phantom often lands
      // first, and naive first-wins dedupe would drop the real pick.
      const bySlot = new Map();
      const order = [];
      for (const p of merged) {
        const bp = state.byEspn.get(String(p.espn_id)) || null;
        if (p.team_id == null || p.pick_no == null) { order.push({ p, bp }); continue; }
        const key = `${p.team_id}|${Math.ceil(Number(p.pick_no) / teams)}`;
        const prev = bySlot.get(key);
        if (!prev) {
          const entry = { p, bp };
          bySlot.set(key, entry);
          order.push(entry);            // entry is mutated in place below,
        } else if (!prev.bp && bp) {    // so `order` keeps arrival order
          prev.p = p; prev.bp = bp;     // while upgrading phantom -> real
        }
      }

      state.pickedIds = new Set(
        order.filter((e) => e.bp).map((e) => String(e.bp.player_id))
      );

      // Draft slot from round 1: teams pick in slot order and the picks
      // array preserves arrival order, so the Nth distinct team to pick in
      // round 1 holds slot N.
      //
      // Only trust it once round 1 is exactly complete. This doubles as a
      // check on state.lineup.teams, which is the input most likely to be
      // wrong: a mock we could not read settings for defaults to 10, and a
      // live capture turned out to be an 8-team league. If teams is wrong
      // the round-1 slice cannot come out exactly right, the guard fails,
      // and we fall back to the value-order model rather than seating every
      // team wrongly and skewing every lookahead number in the draft.
      // Truth-check against ESPN's own counter. If the room says pick 40
      // and we know of 36, four picks happened while we were not listening
      // — during an outage, or before we ever connected. A refresh is
      // usually PROVOKED by such an outage, so this is the common case
      // rather than an edge one.
      //
      // We cannot recover them from here, but we must not pretend the
      // board is complete. The run model reads every team's roster, so a
      // hole makes it confidently wrong rather than merely incomplete —
      // worse than no run model at all. Degrade instead, and say so.
      const domPick = espnPickFromDom();
      state.espnGap = domPick ? Math.max(0, (domPick - 1) - order.length) : 0;
      // Sticky across a pause: the "ON THE CLOCK" header can leave the DOM
      // (paused draft), which would read as "no gap" while picks are still
      // missing. Only a READABLE header showing no gap clears the flag.
      if (state.espnGap > 0) state.espnGapSeen = true;
      else if (domPick) state.espnGapSeen = false;

      const r1 = order.filter((e) => Number(e.p.pick_no) <= teams && e.p.team_id != null)
        .map((e) => String(e.p.team_id));
      const r1uniq = [...new Set(r1)];
      const seated = r1.length === teams && r1uniq.length === teams && !state.espnGap;

      if (seated) {
        const slotOf = new Map(r1uniq.map((t, i) => [t, i + 1]));
        const mine = slotOf.get(String(d.myTeamId));
        state.mySlot = mine || null;

        // Every team's roster keyed by draft slot — this is what the run
        // model consumes (simulateRoom / worstCaseAtNext). Until now ESPN
        // left it null and silently fell back to expectedNextBest, which
        // has no run awareness at all.
        const slotCounts = {};
        for (const e of order) {
          if (!e.bp || !e.bp.position || e.p.team_id == null) continue;
          const slot = slotOf.get(String(e.p.team_id));
          if (!slot) continue;
          (slotCounts[slot] = slotCounts[slot] || {})[e.bp.position] =
            (slotCounts[slot][e.bp.position] || 0) + 1;
        }
        state.slotCounts = slotCounts;
      } else {
        state.mySlot = null;
        state.slotCounts = null;
      }

      if (d.myTeamId) {
        const counts = {};
        let qbRound = null;
        for (const e of order) {
          if (String(e.p.team_id) !== String(d.myTeamId)) continue;
          if (!e.bp || !e.bp.position) continue;
          counts[e.bp.position] = (counts[e.bp.position] || 0) + 1;
          if (e.bp.position === 'QB' && qbRound === null) {
            qbRound = Math.ceil(Number(e.p.pick_no) / teams) || null;
          }
        }
        state.myCounts = counts;
        // Mirrors the Sleeper path: a cheap/late QB1 justifies ONE upside
        // backup, an early QB1 does not.
        state.myQBLate = qbRound !== null && qbRound >= 8;
      }

      // Deduped count, not d.picks.length — the raw length includes
      // phantoms, which was inflating currentPick and producing absurd
      // falling-value deltas on the badges.
      setCurrentPick(order.length + 1);
      stamp('data-ffa-apply', `live:${d.picks.length} backfill:${(state.espnBackfill || []).length} ` +
        `dom:${(state.domHistory || []).length} merged:${merged.length} order:${order.length} gap:${state.espnGap}`);
      stamp('data-ffa-merge', JSON.stringify(merged.map((p) =>
        `${p.pick_no}:${p.espn_id}:${p.team_id}${state.byEspn.get(String(p.espn_id)) ? '' : ':NOBOARD'}`)));
      stamp('data-ffa-live', JSON.stringify(d.picks.map((p) => `${p.pick_no}:${p.espn_id}:${p.team_id}`)));
      recommend();
    };
    chrome.storage.local.get(['espnDraft'], (v) => {
      // Run even with nothing stored: the gap check needs a baseline, and
      // a mid-draft install with zero seen picks is exactly a full gap.
      applyEspn(v.espnDraft || { picks: [], myTeamId: null });
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.espnDraft && ch.espnDraft.newValue) applyEspn(ch.espnDraft.newValue);
    });
    // Re-run the pipeline when the Pick History scrape recovers picks —
    // even if no espnDraft was ever stored (a refresh before any frame).
    state.espnReapply = () => applyEspn(lastEspnDraft || { picks: [], myTeamId: null });
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
  // Scoreboard-graphite badge styling (design 4a): square corners, warm
  // graphite ground, amber accent for the recommended picks, warm green
  // for value falling to you.
  const css = document.createElement('style');
  css.textContent = `
    .ffa-badge {
      display: inline-block;
      margin-left: 4px;
      padding: 0 4px;
      font: 600 9px/1.6 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.02em;
      background: oklch(0.2 0.008 70 / 0.92);
      color: oklch(0.8 0.01 80);
      border: 1px solid oklch(0.34 0.012 70);
      vertical-align: middle;
      white-space: nowrap;
    }
    .ffa-badge.ffa-overlay {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      margin-left: 0;
      background: oklch(0.16 0.008 70 / 0.96);
      z-index: 5;
    }
    .ffa-badge.ffa-picked { opacity: 0.55; }
    .ffa-badge.ffa-steal { color: oklch(0.8 0.14 150); border-color: oklch(0.55 0.09 150 / 0.6); }
    .ffa-badge.ffa-t1 { color: oklch(0.8 0.13 75); border-color: oklch(0.6 0.1 75 / 0.55); }
    .ffa-badge.ffa-best {
      color: oklch(0.2 0.03 75) !important;
      background: oklch(0.78 0.15 75) !important;
      border-color: oklch(0.78 0.15 75) !important;
      box-shadow: 0 0 8px oklch(0.78 0.15 75 / 0.6);
    }
    .ffa-badge.ffa-best::before { content: '★  '; }
    .ffa-badge.ffa-good {
      border-color: oklch(0.78 0.15 75 / 0.85) !important;
      color: oklch(0.85 0.12 75) !important;
      box-shadow: 0 0 5px oklch(0.78 0.15 75 / 0.4);
    }
  `;
  document.documentElement.appendChild(css);

  function badgeText(p) {
    // A drafted player keeps his value/tier (useful in Pick History rows)
    // but loses the ↑falling-value arrow — "ranked earlier than where the
    // draft is now" is a stale claim about someone already taken.
    if (state.pickedIds.has(String(p.player_id))) {
      return `${(p.value / 1000).toFixed(1)}k T${p.tier}`;
    }
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
    const picked = state.pickedIds.has(String(p.player_id));
    const delta = state.currentPick - p.overall_rank;
    el.classList.toggle('ffa-picked', picked);
    el.classList.toggle('ffa-steal', !picked && state.currentPick > 1 && delta >= 6);
    el.classList.toggle('ffa-t1', !picked && p.tier === 1 && !(state.currentPick > 1 && delta >= 6));
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
        // Never match names inside our own panels — the audit panel renders
        // bare player names, which would otherwise self-badge.
        if (p.closest && p.closest('[data-ffa-own]')) return NodeFilter.FILTER_REJECT;
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
        // Careful with OTHER players' badges here. On ESPN a row holds one
        // player, but on Sleeper rowOf() can resolve to a container naming
        // several — and dropping everything that isn't THIS player nuked
        // teammates' badges one scan at a time until none were left (their
        // text nodes were already memoized, so they never came back).
        // A different player's badge is stale ONLY if that player is no
        // longer named in the row — which is what a recycled row looks
        // like, and never true in a multi-player container.
        let reused = false;
        const rowText = row.textContent || '';
        for (const b of row.querySelectorAll('.ffa-badge')) {
          const bp = b.__ffaPlayer;
          if (!bp) { dropBadge(b); continue; }
          if (String(bp.player_id) === String(p.player_id)) {
            if (reused) { dropBadge(b); continue; }  // true duplicate
            updateBadge(b);   // right player, still attached — refresh
            reused = true;
            continue;
          }
          if (!rowText.includes(bp.name)) dropBadge(b);
        }
        if (reused) { processed.add(t); continue; }
      }

      if (processed.has(t)) continue;
      processed.add(t);
      annotateAfter(t, p);
    }
    pruneBadges();
    captureDomSample();
    scrapeEspnHistory();

    // The pill is a WARNING surface, not a status readout: board/matching
    // counts live in the audit panel's BOARD card now, so healthy states
    // show nothing at all.
    if (state.espnGap) {
      setPill(`⚠ ${state.espnGap} pick${state.espnGap === 1 ? '' : 's'} missed — ` +
        'open the Pick History tab to recover');
      pill.style.display = 'block';
    } else if (state.byName.size && state.badges.size === 0) {
      setPill('no names matched yet — scrolling the player list helps');
      pill.style.display = 'block';
    } else {
      pill.style.display = 'none';
    }

    // Sleeper removes a drafted player's row the moment the pick happens,
    // while our API poll lags a beat behind — so a vanished top-pick row
    // means the bar is stale. Flag it (the bar renders "updating…") and
    // poll immediately instead of waiting out the throttle.
    if (isSleeper && reco.style.display !== 'none' && reco.__topPid) {
      const els = state.badges.get(reco.__topPid);
      const connected = !!(els && [...els].some((e) => e.isConnected));
      if (connected) {
        reco.__topSeen = true;
      } else if (reco.__topSeen) {
        reco.__topSeen = false;
        state.updatingPid = reco.__topPid;
        state.updatingSince = Date.now();
        if (pickPollTrigger) pickPollTrigger();
      }
    }
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
    const takes = []; // {pick, pos} per intervening pick — the audit timeline
    for (let pn = state.currentPick; pn < la.next; pn++) {
      const s = pickSlot(pn);
      if (s === state.mySlot) continue; // my own current pick
      const c = counts(s);
      let take = avail.find((p) => !gone.has(p.player_id) && teamCanStart(c, p.position));
      if (!take) take = avail.find((p) => !gone.has(p.player_id));
      if (!take) break;
      gone.add(take.player_id);
      c[take.position] = (c[take.position] || 0) + 1;
      takes.push({ pick: pn, pos: take.position });
    }
    const best = {};
    for (const p of avail) {
      if (gone.has(p.player_id)) continue;
      if (!(p.position in best)) best[p.position] = p;
    }
    return { best, takes };
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
    let roomTakes = null;
    if (la) {
      const sim = simulateRoom(avail, la);
      if (sim) {
        nextBest = sim.best;
        roomTakes = sim.takes;
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
    // ── Roster-completion plan ────────────────────────────────────────
    // The greedy score is one-pick myopic: deferring a position is cheap
    // on every individual turn and expensive in aggregate, because drop
    // only measures value vanishing by the NEXT pick. Offline replay vs
    // the prod board (strategy-test.js) showed exactly that failure: in a
    // 2RB/3WR/1FLEX lineup the greedy line opened WR-TE-WR-WR-WR and
    // finished ~700 starter-value behind an RB-early line.
    //
    // So the leaders are re-ranked by what the STARTING LINEUP finishes
    // as: take the candidate, then fill my remaining starter slots at my
    // actual future picks (snake math) from a need-aware room projection,
    // and score the finished starters. Bench phase keeps the plain score —
    // there is no lineup left to complete.
    if (!benchPhase && C && state.mySlot && la && cands.length > 1) {
      const myPicks = [];
      const horizon = (L.rounds || 15) * L.teams;
      for (let pn = state.currentPick + 1; pn <= horizon && myPicks.length < 8; pn++) {
        if (pickSlot(pn) === state.mySlot) myPicks.push(pn);
      }
      const planValue = (cand) => {
        // Project the room NEED-AWARE, not by value order. TEs and QBs sit
        // low in a value-ordered pool, so value-order removal believes they
        // survive many rounds — while a room where someone still needs a TE
        // takes him. First plan draft made exactly that error: it deferred
        // TE past a round where the (need-aware) room drained the tier, and
        // finished ~900 starter-value worse. Same room model as
        // simulateRoom, walked pick-by-pick to my horizon.
        const counts = Object.assign({}, C);
        counts[cand.p.position] = (counts[cand.p.position] || 0) + 1;
        const taken = new Set([String(cand.p.player_id)]);
        const roomC = {};
        for (const k in (state.slotCounts || {})) roomC[k] = Object.assign({}, state.slotCounts[k]);
        let total = cand.p.value;
        const last = myPicks[myPicks.length - 1];
        for (let pn = state.currentPick + 1; pn <= last; pn++) {
          const slot = pickSlot(pn);
          if (slot === state.mySlot) {
            const cnt = (x) => counts[x] || 0;
            const ded = {
              QB: (L.qb + L.sf) - cnt('QB'), RB: L.rb - cnt('RB'),
              WR: L.wr - cnt('WR'), TE: L.te - cnt('TE'),
            };
            const fu = Math.max(0, cnt('RB') - L.rb) + Math.max(0, cnt('WR') - L.wr) +
              Math.max(0, cnt('TE') - L.te);
            const fo = Math.max(0, L.flex - fu);
            if (fo <= 0 && !Object.values(ded).some((n) => n > 0)) break;
            const teF = cnt('TE') >= L.te;
            let choice = null;
            for (const q of avail) {
              if (taken.has(String(q.player_id))) continue;
              const ok = (ded[q.position] || 0) > 0 ||
                (fo > 0 && (q.position === 'RB' || q.position === 'WR' ||
                            (q.position === 'TE' && !teF)));
              if (ok) { choice = q; break; }
            }
            if (!choice) break;
            taken.add(String(choice.player_id));
            total += choice.value;
            counts[choice.position] = (counts[choice.position] || 0) + 1;
          } else {
            const c = roomC[slot] = roomC[slot] || {};
            let pick = null;
            let fallback = null;
            for (const q of avail) {
              if (taken.has(String(q.player_id))) continue;
              if (!fallback) fallback = q;
              if (teamCanStart(c, q.position)) { pick = q; break; }
            }
            pick = pick || fallback;
            if (pick) {
              taken.add(String(pick.player_id));
              c[pick.position] = (c[pick.position] || 0) + 1;
            }
          }
        }
        return total;
      };
      cands.sort((a, b) => b.score - a.score);
      for (let i = 0; i < Math.min(8, cands.length); i++) cands[i].plan = planValue(cands[i]);
    }

    const pool = cands.length ? cands : gated;
    // Leaders rank by completed-lineup value when a plan exists; the greedy
    // score orders everyone else and breaks ties.
    pool.sort((a, b) => ((b.plan == null ? -1 : b.plan) - (a.plan == null ? -1 : a.plan)) || (b.score - a.score));
    const top = pool.slice(0, 3);

    // Run risk: a position I still need but am NOT taking now, where the
    // full-run worst case sits far below the expected outcome.
    let runRisk = null;
    if (worstBest && !benchPhase && top.length) {
      let gap = 0;
      for (const pos of ['QB', 'RB', 'WR', 'TE']) {
        if (pos === top[0].p.position || !canStart(pos)) continue;
        const e = nextBest[pos];
        const w = worstBest[pos];
        if (e && w && e.value - w.value > gap) {
          gap = e.value - w.value;
          runRisk = { pos, name: w.name, value: w.value };
        }
      }
      if (gap < 400) runRisk = null;
    }

    // Roster meta, shared by the footer bar and the panel's board card.
    let rosterMeta = null;
    if (C) {
      const cnt = (x) => C[x] || 0;
      const totalMine = Object.values(C).reduce((s, n) => s + n, 0);
      const remaining = Math.max(0, (L.rounds || 15) - totalMine);
      const reserve = Math.max(0, (L.k || 0) - cnt('K')) +
        Math.max(0, (L.dst || 0) - (cnt('DEF') + cnt('DST')));
      rosterMeta = {
        remaining,
        reserve,
        kdstNow: !startersOpen && reserve > 0 && remaining <= reserve,
      };
    }

    // Audit trail: everything that went into this recommendation, rendered
    // on demand by the "why?" panel.
    state.audit = {
      pick: state.currentPick,
      round: L && L.teams ? Math.ceil(state.currentPick / L.teams) : null,
      la,
      runRisk,
      roster: rosterMeta,
      timeline: roomTakes,
      boardCount: state.allPlayers.length,
      matchedCount: state.badges.size,
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
        team: c.p.team || '', value: c.p.value, vorp: c.vorp || 0, drop: c.drop || 0,
        mult: c.mult == null ? 1 : c.mult, score: c.score,
        plan: c.plan == null ? null : Math.round(c.plan),
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

    // Footer bar (design 4a): amber star block, wait cost, runners-up,
    // picks left, and the why?/hide panel toggle.
    if (top.length && state.currentPick > 1) {
      const a = state.audit;
      const t0 = a.top[0];
      // A pick just landed on the page but the data hasn't caught up yet —
      // say so instead of advertising a possibly-taken player.
      const updating = state.updatingPid != null &&
        Date.now() - state.updatingSince < 5000;
      if (state.updatingPid && !updating) state.updatingPid = null;
      const seg = (html, color) =>
        `<span style="padding:11px 13px;display:flex;align-items:center;white-space:nowrap;color:${color}">${html}</span>`;
      let h;
      if (updating) {
        h = `<span id="ffa-star" style="background:${UI.line};color:${UI.mid};padding:11px 13px;` +
          'display:flex;align-items:center;font-size:12px;font-weight:600;letter-spacing:0.06em;white-space:nowrap">' +
          '⟳ UPDATING…</span>';
      } else {
        h = `<span id="ffa-star" style="background:${UI.amber};color:${UI.amberDark};padding:11px 13px;` +
          'display:flex;align-items:center;font-size:12px;font-weight:600;letter-spacing:0.02em;white-space:nowrap">' +
          `★ ${lastName(t0.name).toUpperCase()} ${kfmt(t0.value)} ${t0.pos}</span>`;
        if ((t0.drop || 0) >= 300) h += seg(`−${kfmt(t0.drop)} if you wait`, UI.red);
        if (a.runRisk) h += seg(`⚠ ${a.runRisk.pos} run risk`, UI.amberText);
        if (a.top.length > 1) {
          h += seg('then ' + a.top.slice(1).map((t) => `${lastName(t.name)} ${kfmt(t.value)}`).join(' · '), UI.mid);
        }
      }
      if (a.roster) {
        h += a.roster.kdstNow
          ? seg('time for K/DST — not on our board', UI.amberText)
          : seg(`${a.roster.remaining} left` +
              (a.roster.reserve > 0 ? ` · save ${a.roster.reserve} K/DST` : ''), UI.dim);
      } else {
        h += seg(state.rosterHelp, UI.red);
      }
      h += '<span style="flex:1"></span>' +
        `<span id="ffa-why" style="padding:11px 14px;display:flex;align-items:center;white-space:nowrap;` +
        `color:${UI.amberText};border-left:1px solid ${UI.line2}">` +
        (auditEl.style.display !== 'none' ? 'hide' : 'why?') + '</span>';
      reco.innerHTML = h;
      reco.__topPid = top[0].p.player_id;
      reco.style.display = 'flex';
    } else {
      reco.style.display = 'none';
    }
  }

  let pickPollTrigger = null;
  let lastPickPoll = 0;

  let scanScheduled = false;
  function scheduleScan() {
    // 600ms, not 1200: the page mutates every second anyway (pick clock),
    // so this bounds pick-to-bar latency at ~0.6s + API lag while staying
    // far under Sleeper's documented rate guidance.
    if (pickPollTrigger && Date.now() - lastPickPoll > 600) pickPollTrigger();
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
