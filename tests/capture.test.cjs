const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const tls = require('node:tls');
const https = require('node:https');
const {EventEmitter, once} = require('node:events');
const {SocksClient} = require('socks');
const WebSocket = require('ws');
const {startProxy, gameHost} = require('../src/capture.cjs');
const {startInjector} = require('../src/injector.cjs');
const {WindowsProxy} = require('../src/windows-proxy.cjs');

let temporary;
let caDir;
test.before(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-capture-test-'));
  caDir = path.join(temporary, 'ca');
  const proxy = await startProxy(caDir, undefined, undefined, undefined, {port: 0});
  proxy.close();
});
test.after(() => fs.rmSync(temporary, {recursive: true, force: true}));

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  const done = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await done;
}
async function connect(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority, agent: false});
    request.on('error', reject);
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {socket.destroy(); reject(new Error(`CONNECT ${response.statusCode}`));}
      else {if (head.length) socket.unshift(head); resolve(socket);}
    });
    request.end();
  });
}
async function fakeInjector(proxyPort, options = {}) {
  return startInjector(path.join(temporary, 'fake-injector.exe'), '雀魂.exe', undefined, {
    port: 0, proxyPort, ...options,
    spawnProcess: options.spawnProcess || (() => {
      const child = new EventEmitter();
      child.kill = () => child.emit('exit', 0);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    })
  });
}

test('game domain filtering includes case and trailing dots without matching lookalikes', () => {
  for (const host of ['game.maj-soul.com', 'GAME.MAJ-SOUL.COM.', 'mahjongsoul.game.yo-star.com', 'majsoul.net']) assert.equal(gameHost(host), true);
  for (const host of ['maj-soul.com.example.org', 'fake-maj-soul.com', '', null]) assert.equal(gameHost(host), false);
});

test('occupied capture port rejects startup without hanging', {timeout: 5000}, async () => {
  const blocker = net.createServer();
  const port = await listen(blocker);
  try {
    await assert.rejects(startProxy(caDir, undefined, undefined, undefined, {port, startTimeout: 800}), {code: 'EADDRINUSE'});
  } finally {await close(blocker);}
});

test('HTTPS passes through unchanged and close destroys an open tunnel', {timeout: 8000}, async () => {
  const key = fs.readFileSync(path.join(caDir, 'keys', 'ca.private.key'));
  const cert = fs.readFileSync(path.join(caDir, 'certs', 'ca.pem'));
  const origin = https.createServer({key, cert}, (_req, res) => res.end('opaque HTTPS payload'));
  const originPort = await listen(origin);
  const proxy = await startProxy(caDir, undefined, undefined, undefined, {port: 0, tlsPorts: [originPort]});
  let secure;
  try {
    const socket = await connect(proxy.port, `127.0.0.1:${originPort}`);
    secure = tls.connect({socket, servername: 'example.org', rejectUnauthorized: false});
    await once(secure, 'secureConnect');
    assert.equal(secure.getPeerCertificate().fingerprint256, new (require('node:crypto').X509Certificate)(cert).fingerprint256);
    const response = once(secure, 'data');
    secure.write('GET / HTTP/1.1\r\nHost: example.org\r\nConnection: keep-alive\r\n\r\n');
    assert.match((await response)[0].toString(), /opaque HTTPS payload/);
    const closed = once(secure, 'close');
    proxy.close();
    proxy.close();
    await closed;
  } finally {secure?.destroy(); proxy.close(); await close(origin);}
});

test('SOCKS5 adapter forwards client bytes and shuts down idle sockets', {timeout: 5000}, async () => {
  const origin = net.createServer(socket => socket.pipe(socket));
  const originPort = await listen(origin);
  const proxy = await startProxy(caDir, undefined, undefined, undefined, {port: 0});
  const injector = await fakeInjector(proxy.port);
  let client;
  let idle;
  try {
    client = (await SocksClient.createConnection({proxy: {host: '127.0.0.1', port: injector.port, type: 5}, command: 'connect', destination: {host: '127.0.0.1', port: originPort}})).socket;
    const response = once(client, 'data');
    client.write(Buffer.from([0, 1, 255, 6]));
    assert.deepEqual((await response)[0], Buffer.from([0, 1, 255, 6]));
    idle = net.connect(injector.port, '127.0.0.1');
    await once(idle, 'connect');
    const closed = once(client, 'close');
    const idleClosed = once(idle, 'close');
    await injector.close();
    await Promise.all([closed, idleClosed]);
    await injector.close();
  } finally {client?.destroy(); idle?.destroy(); await injector.close(); proxy.close(); await close(origin);}
});

test('SOCKS adapter handles a refused HTTP proxy and a missing injector executable', {timeout: 5000}, async () => {
  const blocker = net.createServer();
  const unavailable = await listen(blocker);
  await close(blocker);
  const injector = await fakeInjector(unavailable);
  try {
    await assert.rejects(SocksClient.createConnection({proxy: {host: '127.0.0.1', port: injector.port, type: 5}, command: 'connect', destination: {host: '127.0.0.1', port: 80}, timeout: 1000}));
  } finally {await injector.close();}
  await assert.rejects(startInjector(path.join(temporary, 'does-not-exist.exe'), 'game', undefined, {port: 0}), {code: 'ENOENT'});
});

test('injection watcher reattaches after exit and stops restarting when closed', {timeout: 5000}, async () => {
  const children = [];
  const injector = await fakeInjector(1, {restartDelay: 10, spawnProcess: () => {
    const child = new EventEmitter();
    child.kill = () => child.emit('exit', 0);
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }});
  children[0].emit('exit', 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(children.length, 2);
  await injector.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(children.length, 2);
});

test('IP-only game TLS connection is identified by SNI and captures both WebSocket directions', {timeout: 10000}, async () => {
  const key = fs.readFileSync(path.join(caDir, 'keys', 'ca.private.key'));
  const cert = fs.readFileSync(path.join(caDir, 'certs', 'ca.pem'));
  const origin = https.createServer({key, cert});
  const wsOrigin = new WebSocket.Server({server: origin});
  wsOrigin.on('connection', socket => socket.on('message', data => socket.send(data)));
  const originPort = await listen(origin);
  const frames = [];
  const closedIds = [];
  let notifyClosed;
  const capturedClose = new Promise(resolve => {notifyClosed=resolve;});
  const proxy = await startProxy(caDir, (id, direction, bytes) => frames.push({id, direction, bytes}), undefined, id => {closedIds.push(id);notifyClosed();}, {port: 0, tlsPorts: [originPort]});
  const injector = await fakeInjector(proxy.port);
  const agent = new https.Agent({rejectUnauthorized: false, lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4)});
  const originalCreateConnection = https.Agent.prototype.createConnection;
  // Only the proxy's upstream agent needs this local test route. No system DNS
  // or trust store is changed.
  https.Agent.prototype.createConnection = function (options, callback) {
    if (options.host === 'game.maj-soul.com') return originalCreateConnection.call(this, {...options, host: '127.0.0.1', rejectUnauthorized: false}, callback);
    return originalCreateConnection.call(this, options, callback);
  };
  let client;
  try {
    const raw = (await SocksClient.createConnection({proxy: {host: '127.0.0.1', port: injector.port, type: 5}, command: 'connect', destination: {host: '127.0.0.1', port: originPort}})).socket;
    const secure = tls.connect({socket: raw, servername: 'game.maj-soul.com', ca: cert});
    await once(secure, 'secureConnect');
    assert.notEqual(secure.getPeerCertificate().fingerprint256, new (require('node:crypto').X509Certificate)(cert).fingerprint256);
    agent.createConnection = () => secure;
    client = new WebSocket(`wss://game.maj-soul.com:${originPort}/gateway`, {agent});
    await once(client, 'open');
    const received = once(client, 'message');
    client.send(Buffer.from([1, 3, 4, 5]));
    assert.deepEqual((await received)[0], Buffer.from([1, 3, 4, 5]));
    assert.deepEqual(frames.map(f => f.direction), ['send', 'receive']);
    assert.equal(frames[0].id, frames[1].id);
    const ended = once(client, 'close');
    client.close();
    await ended;
    await capturedClose;
    assert.deepEqual(closedIds, [frames[0].id]);
  } finally {
    client?.terminate();
    https.Agent.prototype.createConnection = originalCreateConnection;
    agent.destroy();
    await injector.close();
    proxy.close();
    for (const ws of wsOrigin.clients) ws.terminate();
    wsOrigin.close();
    await close(origin);
  }
});

test('system proxy recovery preserves user changes and never modifies real Windows settings', async () => {
  const recovery = path.join(temporary, 'proxy-recovery.json');
  const before = {ProxyEnable: 1, ProxyServer: 'old.example:8080', ProxyOverride: "'trusted'", AutoConfigURL: 'https://old.example/proxy.pac'};
  let current = {...before};
  let installed = false;
  const scripts = [];
  const commands = [];
  const manager = new WindowsProxy(recovery, {exec: async (exe, args) => {
    commands.push({exe, args});
    if (exe === 'certutil.exe') {installed = args.includes('-addstore'); return {stdout: ''};}
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    scripts.push(script);
    if (script.startsWith('Test-Path')) return {stdout: String(installed ? 'True' : 'False')};
    if (script.includes('ConvertTo-Json')) return {stdout: JSON.stringify(current)};
    if (script.includes("-Name ProxyServer -Value '127.0.0.1:19222'")) current = {ProxyEnable: 1, ProxyServer: '127.0.0.1:19222', ProxyOverride: '<local>', AutoConfigURL: null};
    return {stdout: ''};
  }});
  await manager.enable(path.join(caDir, 'certs', 'ca.pem'));
  current.ProxyEnable = 0;
  current.ProxyOverride = 'user.changed';
  await manager.restore();
  const restore = scripts.find(script => script.includes("-Name 'ProxyServer' -Value 'old.example:8080'"));
  assert.ok(restore, scripts.join('\n'));
  assert.ok(!restore.includes("-Name 'ProxyEnable'"));
  assert.ok(!restore.includes("-Name 'ProxyOverride'"));
  assert.ok(restore.includes("-Name 'AutoConfigURL'"));
  assert.equal(fs.existsSync(recovery), false);
  assert.deepEqual(commands.filter(c => c.exe === 'certutil.exe').map(c => c.args[1]), ['-addstore', '-delstore']);
});
