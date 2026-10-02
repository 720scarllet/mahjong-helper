(() => {
  'use strict';
  const marker = 'mahjong-helper-overlay-v1';
  const origin = location.origin;
  const pending = [];
  let sending = false;
  let disconnected = false;

  function ready() {
    window.postMessage({marker, kind: 'ready'}, origin);
  }

  async function drain() {
    if (sending || disconnected) return;
    sending = true;
    try {
      while (pending.length) {
        const payload = pending.shift();
        await chrome.runtime.sendMessage({type: 'frame', payload});
      }
    } catch {
      // An extension reload invalidates this isolated context until the page reloads.
      disconnected = true;
      pending.length = 0;
    } finally {sending = false;}
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin || event.data?.marker !== marker) return;
    if (event.data.kind === 'hello') {ready(); return;}
    if (event.data.kind !== 'frame' || disconnected) return;
    const payload = event.data.payload;
    if (!payload || typeof payload.connection !== 'string' || !['send', 'receive', 'close'].includes(payload.direction)) return;
    if (payload.direction !== 'close' && (typeof payload.data !== 'string' || payload.data.length > 1398104)) return;
    if (pending.length >= 256) return;
    pending.push(payload);
    drain();
  });
  ready();
})();
