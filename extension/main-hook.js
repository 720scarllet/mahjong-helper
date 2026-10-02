(() => {
  'use strict';
  const marker = 'mahjong-helper-overlay-v1';
  const maximumBytes = 1024 * 1024;
  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || window[Symbol.for(marker)]) return;
  Object.defineProperty(window, Symbol.for(marker), {value: true});

  const pageId = crypto.randomUUID();
  const sockets = new WeakMap();
  const pending = [];
  let relayReady = false;
  const post = window.postMessage.bind(window);
  const origin = location.origin;
  const encode = window.btoa.bind(window);
  const blobArrayBuffer = Blob.prototype.arrayBuffer;

  function publish(payload) {
    if (relayReady) post({marker, kind: 'frame', payload}, origin);
    else if (pending.length < 256) pending.push(payload);
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin || event.data?.marker !== marker || event.data.kind !== 'ready') return;
    relayReady = true;
    for (const payload of pending.splice(0)) publish(payload);
  });
  post({marker, kind: 'hello'}, origin);

  function snapshot(data) {
    if (data instanceof Blob) return data.size <= maximumBytes ? data : null;
    if (data instanceof ArrayBuffer) return data.byteLength <= maximumBytes ? new Uint8Array(data).slice() : null;
    if (ArrayBuffer.isView(data)) return data.byteLength <= maximumBytes ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : null;
    return null;
  }

  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return encode(binary);
  }

  function enqueue(context, direction, data) {
    // A Blob can resolve after a later ArrayBuffer; one queue preserves socket order.
    context.queue = context.queue.then(async () => {
      const payload = {connection: context.connection, direction};
      if (direction !== 'close') {
        const bytes = data instanceof Blob ? new Uint8Array(await Reflect.apply(blobArrayBuffer, data, [])) : data;
        payload.data = base64(bytes);
      }
      publish(payload);
    }).catch(() => {});
  }

  const sendDescriptor = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'send');
  const nativeSend = sendDescriptor.value;
  Object.defineProperty(NativeWebSocket.prototype, 'send', {
    ...sendDescriptor,
    value: function send(data) {
      const context = sockets.get(this);
      let copy = null;
      if (context) {try {copy = snapshot(data);} catch {}}
      const result = Reflect.apply(nativeSend, this, arguments);
      if (context && copy) enqueue(context, 'send', copy);
      return result;
    }
  });

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, argumentsList, newTarget) {
      const socket = Reflect.construct(target, argumentsList, newTarget);
      const context = {connection: `${pageId}:${crypto.randomUUID()}`, queue: Promise.resolve()};
      sockets.set(socket, context);
      socket.addEventListener('message', event => {
        let copy = null;
        try {copy = snapshot(event.data);} catch {}
        if (copy) enqueue(context, 'receive', copy);
      });
      socket.addEventListener('close', () => enqueue(context, 'close'), {once: true});
      return socket;
    }
  });
})();
