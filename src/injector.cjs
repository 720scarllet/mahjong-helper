const {createServer} = require('@pondwader/socks5-server');
const {spawn} = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

async function startInjector(executable, processName, onError = () => {}, options = {}) {
  if (typeof processName !== 'string') throw new Error('无效的游戏进程名');
  processName = processName.trim().replace(/\.exe$/i, '');
  if (!/^[^\x00-\x1f\\/:*?"<>|]{1,100}$/u.test(processName) || /^\.+$/.test(processName)) throw new Error('无效的游戏进程名');
  const sockets = new Set();
  const requests = new Set();
  const socks = createServer();
  const timeout = options.connectionTimeout ?? 15000;
  let child;
  let stopped = false;
  let restartTimer;
  let lastError = '';
  const report = message => {
    if (message === lastError) return;
    lastError = message;
    try {onError(message);} catch {}
  };
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  socks.server.on('connection', socket => {
    track(socket);
    socket.setTimeout(timeout, () => socket.destroy());
    socket.on('error', () => {});
  });
  socks.setConnectionHandler((connection, sendStatus) => {
    const {socket, destAddress, destPort} = connection;
    let replied = false;
    let upstream;
    const reply = status => {
      if (replied || socket.destroyed || stopped) return;
      replied = true;
      sendStatus(status);
    };
    const host = net.isIP(destAddress) === 6 ? `[${destAddress}]` : destAddress;
    const request = http.request({host: '127.0.0.1', port: options.proxyPort ?? 19222, method: 'CONNECT', path: `${host}:${destPort}`, agent: false});
    requests.add(request);
    request.once('close', () => requests.delete(request));
    request.setTimeout(timeout, () => request.destroy(new Error('Proxy connection timed out')));
    request.on('connect', (res, stream, head) => {
      upstream = track(stream);
      if (res.statusCode !== 200 || socket.destroyed || stopped) {
        reply('GENERAL_FAILURE');
        upstream.destroy();
        return;
      }
      upstream.setTimeout(0);
      socket.setTimeout(0);
      upstream.on('error', () => socket.destroy());
      upstream.once('close', () => socket.destroy());
      reply('REQUEST_GRANTED');
      if (head.length) socket.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    request.on('response', res => {res.resume(); reply('GENERAL_FAILURE'); request.destroy();});
    request.on('error', () => reply('CONNECTION_REFUSED'));
    socket.once('close', () => {request.destroy(); upstream?.destroy();});
    socket.on('error', () => {request.destroy(); upstream?.destroy();});
    request.end();
    // The SOCKS library resumes after invoking the handler; pause again until
    // CONNECT succeeds so an early application packet stays buffered.
    queueMicrotask(() => {if (!replied) socket.pause();});
  });

  let closing;
  const close = () => {
    if (closing) return closing;
    stopped = true;
    clearTimeout(restartTimer);
    child?.kill();
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    closing = new Promise(resolve => socks.close(() => resolve()));
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      const fail = error => reject(error);
      socks.server.once('error', fail);
      socks.listen(options.port ?? 19223, '127.0.0.1', () => {
        socks.server.removeListener('error', fail);
        socks.server.on('error', error => report(`进程代理服务错误：${error.message}`));
        resolve();
      });
    });
    const port = socks.server.address().port;
    const launch = () => new Promise((resolve, reject) => {
      child = (options.spawnProcess || spawn)(executable, ['-n', processName, '-p', `127.0.0.1:${port}`], {windowsHide: true, stdio: 'ignore', cwd: path.dirname(executable)});
      child.once('spawn', resolve);
      child.once('error', error => {
        reject(error);
        if (!stopped) {report(`进程代理启动失败：${error.message}`); close();}
      });
      child.once('exit', code => {
        if (stopped) return;
        if (code) report(`进程代理已退出（${code}），正在等待客户端，请确认两者权限一致`);
        restartTimer = setTimeout(() => {if (!stopped) launch().catch(() => {});}, options.restartDelay ?? 1500);
        restartTimer.unref();
      });
    });
    await launch();
    return {port, close};
  } catch (error) {await close(); throw error;}
}

module.exports = {startInjector};
