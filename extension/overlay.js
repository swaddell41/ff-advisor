/**
 * In-page overlay: embeds the assistant directly into the draft screen
 * (Sleeper and ESPN) as a floating, draggable, collapsible card, instead of
 * requiring the Chrome side panel. The card is an iframe onto panel.html,
 * so every working piece — Sleeper polling, the ESPN socket tap state,
 * board rendering — is reused exactly as-is.
 *
 * Position and collapsed state persist via chrome.storage.
 */

(function () {
  if (window.top !== window) return;          // main frame only
  const stale = document.getElementById('ffa-overlay');
  if (stale) stale.remove();                  // replace an orphaned card after extension reload

  // When the extension is reloaded, this script becomes an orphan: the DOM
  // stays but every chrome.* call throws "Extension context invalidated".
  // Guard all chrome usage and tear the card down instead of erroring.
  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  };
  function safeStore(obj) {
    if (!alive()) { teardown(); return; }
    try { chrome.storage.local.set(obj); } catch (_) { teardown(); }
  }
  function teardown() {
    const el = document.getElementById('ffa-overlay');
    if (el) el.remove();
  }

  const WIDTH = 360;
  const HEIGHT = Math.min(680, Math.round(window.innerHeight * 0.85));

  // Scoreboard-graphite skin (claude.ai/design "Draft Advisor Panel" 4a):
  // warm graphite, amber accent, square corners, mono type.
  const root = document.createElement('div');
  root.id = 'ffa-overlay';
  Object.assign(root.style, {
    position: 'fixed',
    top: '70px',
    right: '12px',
    width: WIDTH + 'px',
    zIndex: 2147483646,
    overflow: 'hidden',
    boxShadow: '0 16px 36px -20px oklch(0.2 0.02 70 / 0.6), 0 8px 30px rgba(0,0,0,0.45)',
    border: '1px solid oklch(0.34 0.012 70)',
    background: 'oklch(0.14 0.008 70)',
    fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
  });

  // Header / drag handle
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: 'oklch(0.2 0.008 70)',
    borderBottom: '1px solid oklch(0.3 0.01 70)',
    color: 'oklch(0.95 0.005 80)',
    fontSize: '10px',
    fontWeight: '600',
    letterSpacing: '0.14em',
    cursor: 'move',
    userSelect: 'none',
  });
  header.innerHTML = '<span><span style="color:oklch(0.8 0.13 75)">★</span> DRAFT ASSISTANT</span>';

  const buttons = document.createElement('span');
  const mkBtn = (label, title) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      background: 'transparent',
      border: 'none',
      color: 'oklch(0.6 0.02 70)',
      cursor: 'pointer',
      fontSize: '13px',
      marginLeft: '8px',
      fontFamily: 'inherit',
    });
    b.addEventListener('mouseenter', () => (b.style.color = 'oklch(0.8 0.13 75)'));
    b.addEventListener('mouseleave', () => (b.style.color = 'oklch(0.6 0.02 70)'));
    return b;
  };
  const collapseBtn = mkBtn('—', 'Collapse');
  const closeBtn = mkBtn('✕', 'Hide (click the extension icon to reopen)');
  buttons.appendChild(collapseBtn);
  buttons.appendChild(closeBtn);
  header.appendChild(buttons);

  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('panel.html');
  Object.assign(frame.style, {
    width: '100%',
    height: HEIGHT + 'px',
    border: 'none',
    display: 'block',
    background: 'oklch(0.14 0.008 70)',
  });

  root.appendChild(header);
  root.appendChild(frame);
  document.documentElement.appendChild(root);

  // ── Collapse / close ──────────────────────────────────────────────────
  let collapsed = false;
  function setCollapsed(v) {
    collapsed = v;
    frame.style.display = v ? 'none' : 'block';
    collapseBtn.textContent = v ? '▢' : '—';
    collapseBtn.title = v ? 'Expand' : 'Collapse';
    safeStore({ overlayCollapsed: v });
  }
  collapseBtn.addEventListener('click', () => setCollapsed(!collapsed));
  closeBtn.addEventListener('click', () => {
    root.style.display = 'none';
    safeStore({ overlayHidden: true });
  });

  // Reopen when the toolbar icon is clicked (background broadcasts).
  if (!alive()) { teardown(); return; }
  chrome.storage.onChanged.addListener((ch) => {
    if (!alive()) { teardown(); return; }
    if (ch.overlayShowRequest) {
      root.style.display = 'block';
      safeStore({ overlayHidden: false });
    }
  });

  // ── Drag ──────────────────────────────────────────────────────────────
  let drag = null;
  header.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const rect = root.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    header.setPointerCapture(e.pointerId);
  });
  header.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    root.style.left = x + 'px';
    root.style.top = y + 'px';
    root.style.right = 'auto';
  });
  header.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    safeStore({
      overlayPos: { left: root.style.left, top: root.style.top },
    });
  });

  // ── Restore saved state ───────────────────────────────────────────────
  try { chrome.storage.local.get(['overlayPos', 'overlayCollapsed', 'overlayHidden'], (v) => {
    if (v.overlayPos && v.overlayPos.left) {
      root.style.left = v.overlayPos.left;
      root.style.top = v.overlayPos.top;
      root.style.right = 'auto';
    }
    if (v.overlayCollapsed) setCollapsed(true);
    if (v.overlayHidden) root.style.display = 'none';
  }); } catch (_) { teardown(); }
})();
