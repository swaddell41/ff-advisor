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

    // Relay via a namespaced CustomEvent — NOT window.postMessage. ESPN's
    // lobby and draft-room windows coordinate over postMessage, and foreign
    // messages on that channel poison their handlers (undefined.pageName →
    // React crash → blank page). CustomEvents with a custom name are
    // invisible to 'message' listeners. Payload is a JSON string so it
    // crosses the isolated-world boundary reliably.
    const relay = (url, data) => {
      try {
        if (typeof data !== 'string') return;
        // 4000 was too tight: a full draft-state sync (every pick so far)
        // is exactly the frame we most want and exactly the one that
        // exceeded it, so it was dropped silently. Report what we still
        // drop rather than discarding it without trace.
        if (data.length > 32000) {
          document.dispatchEvent(new CustomEvent('ffa-espn-frame', {
            detail: JSON.stringify({ url: String(url || ''), oversize: data.length }),
          }));
          return;
        }
        document.dispatchEvent(new CustomEvent('ffa-espn-frame', {
          detail: JSON.stringify({ url: String(url || ''), data }),
        }));
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
