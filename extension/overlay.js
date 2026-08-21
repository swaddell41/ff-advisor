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
  if (document.getElementById('ffa-overlay')) return;

  const WIDTH = 360;
  const HEIGHT = Math.min(680, Math.round(window.innerHeight * 0.85));

  const root = document.createElement('div');
  root.id = 'ffa-overlay';
  Object.assign(root.style, {
    position: 'fixed',
    top: '70px',
    right: '12px',
    width: WIDTH + 'px',
    zIndex: 2147483646,
    borderRadius: '10px',
    overflow: 'hidden',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
    border: '1px solid #2a2f3a',
    background: '#0f1115',
    fontFamily: 'Menlo, monospace',
  });

  // Header / drag handle
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    background: '#171a21',
    color: '#e6e8ee',
    fontSize: '12px',
    cursor: 'move',
    userSelect: 'none',
  });
  header.innerHTML = '<span>⚡ Draft Assistant</span>';

  const buttons = document.createElement('span');
  const mkBtn = (label, title) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      background: 'transparent',
      border: 'none',
      color: '#8b93a5',
      cursor: 'pointer',
      fontSize: '13px',
      marginLeft: '8px',
      fontFamily: 'inherit',
    });
    b.addEventListener('mouseenter', () => (b.style.color = '#e6e8ee'));
    b.addEventListener('mouseleave', () => (b.style.color = '#8b93a5'));
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
    background: '#0f1115',
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
    chrome.storage.local.set({ overlayCollapsed: v });
  }
  collapseBtn.addEventListener('click', () => setCollapsed(!collapsed));
  closeBtn.addEventListener('click', () => {
    root.style.display = 'none';
    chrome.storage.local.set({ overlayHidden: true });
  });

  // Reopen when the toolbar icon is clicked (background broadcasts).
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.overlayShowRequest) {
      root.style.display = 'block';
      chrome.storage.local.set({ overlayHidden: false });
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
    chrome.storage.local.set({
      overlayPos: { left: root.style.left, top: root.style.top },
    });
  });

  // ── Restore saved state ───────────────────────────────────────────────
  chrome.storage.local.get(['overlayPos', 'overlayCollapsed', 'overlayHidden'], (v) => {
    if (v.overlayPos && v.overlayPos.left) {
      root.style.left = v.overlayPos.left;
      root.style.top = v.overlayPos.top;
      root.style.right = 'auto';
    }
    if (v.overlayCollapsed) setCollapsed(true);
    if (v.overlayHidden) root.style.display = 'none';
  });
})();
