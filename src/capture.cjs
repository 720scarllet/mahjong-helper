const {Proxy} = require('http-mitm-proxy');
const net = require('node:net');
const crypto = require('node:crypto');

function gameHost(host) {
  return typeof host === 'string' && /(^|\.)(maj-soul\.(com|net)|mahjongsoul\.(com|net)|majsoul\.(com|net)|yo-star\.com|catfood\.com)$/.test(host.toLowerCase().replace(/\.$/, ''));
}

function destination(authority) {
  const url = new URL(`http://${authority}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid CONNECT destination');
  return {host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 443};
}

// Proxinject usually supplies an IP address. Read only the public TLS SNI field
// before deciding whether to decrypt a connection to a game domain.
function clientHelloName(data) {
  const chunks = [];
  let offset = 0;
  let size = 0;
  while (offset < data.length) {
    if (data.length - offset < 5) return undefined;
    if (data[offset] !== 22 || data[offset + 1] !== 3) return null;
    const length = data.readUInt16BE(offset + 3);
    if (data.length - offset - 5 < length) return undefined;
    chunks.push(data.subarray(offset + 5, offset + 5 + length));
    size += length;
    offset += 5 + length;
    const hello = Buffer.concat(chunks, size);
    if (hello.length < 4) continue;
    if (hello[0] !== 1) return null;
    const end = 4 + hello.readUIntBE(1, 3);
    if (end > 65536) return null;
    if (hello.length < end) continue;
    try {
      let p = 38;
      p += 1 + hello[p];
      p += 2 + hello.readUInt16BE(p);
      p += 1 + hello[p];
      const extensionsEnd = p + 2 + hello.readUInt16BE(p);
      p += 2;
      if (extensionsEnd > end) return null;
      while (p + 4 <= extensionsEnd) {
        const type = hello.readUInt16BE(p);
        const next = p + 4 + hello.readUInt16BE(p + 2);
        p += 4;
        if (next > extensionsEnd) return null;
        if (type === 0) {
          const namesEnd = p + 2 + hello.readUInt16BE(p);
          p += 2;
          if (namesEnd > next) return null;
          while (p + 3 <= namesEnd) {
            const nameType = hello[p];
            const nameEnd = p + 3 + hello.readUInt16BE(p + 1);
            if (nameEnd > namesEnd) return null;
            if (nameType === 0) return hello.subarray(p + 3, nameEnd).toString('ascii');
            p = nameEnd;
          }
        }
        p = next;
      }
      return null;
    } catch {
      return null;
    }
  }
  return undefined;
}

async function startProxy(caDir, onFrame = () => {}, onError = () => {}, onClose = () => {}, options = {}) {
  const sockets = new Set();
  const webSockets = new Set();
  const servers = new Set();
  const timeout = options.connectionTimeout ?? 15000;
  let stopped = false;
  let listening = false;
  let rejectStart;
  const report = message => {try {onError(message);} catch {}};
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const trackServer = server => {
    if (servers.has(server)) return;
    servers.add(server);
    server.on('connection', track);
    if (stopped) server.close();
  };

  class CaptureProxy extends Proxy {
    _createHttpsServer(settings, callback) {
      return super._createHttpsServer(settings, (port, server, wsServer) => {
        trackServer(server);
        callback(port, server, wsServer);
      });
    }
  }
  const proxy = new CaptureProxy();
  const dispose = () => {
    stopped = true;
    for (const ws of webSockets) ws.terminate();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) {server.close(); server.closeAllConnections?.();}
    proxy.httpAgent?.destroy();
    proxy.httpsAgent?.destroy();
    if (proxy.httpServer) proxy.close();
  };
  proxy.onError((_ctx, error, kind) => {
    report(`代理连接错误：${kind} (${error?.code || error?.message || 'unknown'})`);
    if (!listening) rejectStart?.(error || new Error(kind));
  });

  function tunnel(target, socket, head, acknowledged = false) {
    const upstream = track(net.connect({port: target.port, host: target.host}));
    upstream.setTimeout(timeout, () => upstream.destroy(new Error('Upstream connection timed out')));
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      if (!acknowledged) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', error => {
      report(`代理目标连接失败：${error.code || error.message}`);
      if (!acknowledged && !socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    upstream.on('close', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  }

  proxy.onConnect((req, socket, head, callback) => {
    let target;
    try {target = destination(req.url);} catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (gameHost(target.host)) return callback();
    if (!net.isIP(target.host) || !(options.tlsPorts || [443, 8443]).includes(target.port)) return tunnel(target, socket, head);

    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let buffered = head;
    let decided = false;
    const timer = setTimeout(() => decide(null), Math.min(timeout, 2000));
    timer.unref();
    function decide(name) {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      socket.removeListener('data', inspect);
      if (socket.destroyed || stopped) return;
      socket.pause();
      if (gameHost(name)) {
        req.url = `${name}:${target.port}`;
        // The pinned MITM library exposes this continuation for CONNECT data.
        // It avoids sending a second HTTP acknowledgement after SNI inspection.
        proxy._onHttpServerConnectData(req, socket, buffered);
      } else tunnel(target, socket, buffered, true);
    }
    function inspect(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const name = buffered.length > 65536 ? null : clientHelloName(buffered);
      if (name !== undefined) decide(name);
    }
    socket.once('close', () => {clearTimeout(timer); socket.removeListener('data', inspect);});
    socket.on('data', inspect);
    if (head.length) inspect(Buffer.alloc(0));
    socket.resume();
  });

  proxy.onWebSocketConnection((ctx, callback) => {
    const req = ctx.clientToProxyWebSocket.upgradeReq;
    let host = '';
    try {host = destination(req.headers.host || '').host;} catch {}
    ctx.captureId = crypto.randomUUID();
    ctx.captureGame = gameHost(host);
    webSockets.add(ctx.clientToProxyWebSocket);
    ctx.clientToProxyWebSocket.once('close', () => webSockets.delete(ctx.clientToProxyWebSocket));
    callback();
    if (ctx.proxyToServerWebSocket) {
      webSockets.add(ctx.proxyToServerWebSocket);
      ctx.proxyToServerWebSocket.once('close', () => webSockets.delete(ctx.proxyToServerWebSocket));
    }
  });
  proxy.onWebSocketFrame((ctx, type, fromServer, data, flags, callback) => {
    try {
      if (ctx.captureGame && type === 'message' && flags?.binary !== false) onFrame(`proxy:${ctx.captureId}`, fromServer ? 'receive' : 'send', Buffer.from(data));
    } catch (error) {report(error.message);}
    callback(null, data, flags);
  });
  proxy.onWebSocketError((ctx, error) => {
    report(`游戏连接错误：${error.code || error.message}`);
    ctx.clientToProxyWebSocket?.terminate();
    ctx.proxyToServerWebSocket?.terminate();
  });
  proxy.onWebSocketClose((ctx, code, message, callback) => {
    try {if (ctx.captureGame) onClose(`proxy:${ctx.captureId}`);} catch (error) {report(error.message);}
    callback(null, code, message);
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('代理启动超时')), options.startTimeout ?? 15000);
      const fail = error => {clearTimeout(timer); reject(error);};
      rejectStart = fail;
      proxy.listen({host: '127.0.0.1', port: options.port ?? 19222, sslCaDir: caDir, keepAlive: true, timeout}, error => {
        if (error) return fail(error);
        trackServer(proxy.httpServer);
        if (stopped) {dispose(); return;}
        listening = true;
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error) {dispose(); throw error;}
  return {port: proxy.httpPort, close: dispose};
}

module.exports = {startProxy, gameHost};
