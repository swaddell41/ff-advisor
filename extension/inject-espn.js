/**
 * Runs in the PAGE (MAIN world) context of ESPN draft rooms, declared as a
 * world:"MAIN" content script so it executes before any page code.
 *
 * Wraps window.WebSocket with a Proxy whose construct trap uses
 * Reflect.construct — this preserves `class X extends WebSocket`,
 * instanceof, static constants, and prototype identity exactly (a plain
 * function wrapper breaks subclasses and can blank the whole app). We only
 * observe INCOMING text frames (picks are broadcast inbound); outgoing
 * traffic is left completely untouched.
 */
(function () {
  try {
    if (window.__ffaWsTapInstalled) return;
    window.__ffaWsTapInstalled = true;

    const relay = (url, data) => {
      try {
        if (typeof data !== 'string' || data.length > 4000) return;
        window.postMessage(
          { source: 'ffa-espn', type: 'ws-frame', direction: 'in', url: String(url || ''), data },
          '*'
        );
      } catch (_) { /* never break the page */ }
    };

    const NativeWS = window.WebSocket;
    window.WebSocket = new Proxy(NativeWS, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try {
          ws.addEventListener('message', (ev) => relay(ws.url, ev.data));
        } catch (_) { /* observation is best-effort */ }
        return ws;
      },
    });
  } catch (_) { /* if anything goes wrong, leave the page untouched */ }
})();
