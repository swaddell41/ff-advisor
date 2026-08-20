/**
 * Runs in the PAGE context of ESPN draft rooms (injected by content-espn.js).
 *
 * ESPN's draft room (league drafts and mocks alike) receives live picks over
 * a WebSocket with an undocumented text protocol. We can't read those frames
 * from a content script, so this shim wraps window.WebSocket and relays every
 * text frame (and anything the page sends) to the content script via
 * window.postMessage. Parsing happens on the extension side.
 */
(function () {
  if (window.__ffaWsTapInstalled) return;
  window.__ffaWsTapInstalled = true;

  const relay = (direction, url, data) => {
    try {
      if (typeof data !== 'string' || data.length > 4000) return;
      window.postMessage(
        { source: 'ffa-espn', type: 'ws-frame', direction, url, data },
        '*'
      );
    } catch (_) { /* never break the page */ }
  };

  const NativeWS = window.WebSocket;
  function TappedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);

    ws.addEventListener('message', (ev) => relay('in', url, ev.data));

    const nativeSend = ws.send.bind(ws);
    ws.send = (data) => {
      relay('out', url, data);
      return nativeSend(data);
    };
    return ws;
  }
  TappedWebSocket.prototype = NativeWS.prototype;
  TappedWebSocket.CONNECTING = NativeWS.CONNECTING;
  TappedWebSocket.OPEN = NativeWS.OPEN;
  TappedWebSocket.CLOSING = NativeWS.CLOSING;
  TappedWebSocket.CLOSED = NativeWS.CLOSED;

  window.WebSocket = TappedWebSocket;
})();
