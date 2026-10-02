const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extension = path.join(__dirname, '..');
const marker = 'mahjong-helper-overlay-v1';
const connection = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000002';
const pause = () => new Promise(resolve => setImmediate(resolve));

function page() {
  const listeners = new Map();
  const posted = [];
  let sequence = 0;
  let context;
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      if (!/^wss?:\/\//.test(url)) throw new SyntaxError('Invalid URL');
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.listeners = new Map();
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    emit(type, data) {
      for (const handler of this.listeners.get(type) || []) handler({data});
      if (type === 'message') this.onmessage?.({data});
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('Socket is not open');
      this.sent.push(data);
      return 'native-return';
    }
    close() {this.readyState = 3; this.emit('close');}
  }
  class FakeBlob {
    constructor(bytes, wait = Promise.resolve()) {this.bytes = Uint8Array.from(bytes); this.size = this.bytes.length; this.wait = wait;}
    async arrayBuffer() {await this.wait; return this.bytes.slice().buffer;}
  }
  const sandbox = {
    WebSocket: FakeWebSocket,
    Blob: FakeBlob,
    ArrayBuffer,
    Uint8Array,
    crypto: {randomUUID: () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`},
    location: {origin: 'https://game.maj-soul.com'},
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    postMessage(data, origin) {
      posted.push({data, origin});
      queueMicrotask(() => {for (const handler of listeners.get('message') || []) handler({data, origin, source: vm.runInContext('window', context)});});
    }
  };
  sandbox.window = sandbox;
  context = vm.createContext(sandbox);
  function load(file) {vm.runInContext(fs.readFileSync(path.join(extension, file), 'utf8'), context);}
  function ready() {sandbox.postMessage({marker, kind: 'ready'}, sandbox.location.origin);}
  function frames() {return posted.filter(item => item.data.kind === 'frame').map(item => item.data.payload);}
  return {sandbox, context, posted, load, ready, frames, FakeWebSocket, FakeBlob};
}

test('MAIN hook preserves constructor, subclass, native send and page messages', async () => {
  const p = page();
  p.load('main-hook.js');
  p.ready();
  const socket = new p.sandbox.WebSocket('wss://gateway.maj-soul.com');
  assert.ok(socket instanceof p.sandbox.WebSocket);
  assert.equal(p.sandbox.WebSocket.OPEN, 1);
  class Subclass extends p.sandbox.WebSocket {}
  assert.ok(new Subclass('wss://gateway.maj-soul.com') instanceof Subclass);
  assert.throws(() => p.sandbox.WebSocket('wss://gateway.maj-soul.com'), /class constructor/i);
  assert.throws(() => new p.sandbox.WebSocket('invalid'), /Invalid URL/);
  const originalEvent = new Uint8Array([3, 10]);
  let pageData;
  socket.onmessage = event => {pageData = event.data;};
  assert.equal(socket.send('original text'), 'native-return');
  socket.emit('message', originalEvent);
  assert.equal(pageData, originalEvent);
  await pause();
  assert.equal(socket.sent[0], 'original text');
  assert.equal(p.frames().length, 1);
  assert.equal(p.frames()[0].direction, 'receive');
  assert.equal(p.frames()[0].data, Buffer.from(originalEvent).toString('base64'));
});

test('binary snapshots honor view offset, copy mutable bytes and skip failed sends', async () => {
  const p = page();
  p.load('main-hook.js');
  p.ready();
  const socket = new p.sandbox.WebSocket('wss://gateway.maj-soul.com');
  const bytes = new Uint8Array([99, 1, 2, 88]);
  const view = new DataView(bytes.buffer, 1, 2);
  socket.send(view);
  bytes.fill(0);
  socket.send(new Uint8Array([4, 5]).buffer);
  socket.readyState = 0;
  assert.throws(() => socket.send(new Uint8Array([6])), /not open/);
  await pause();
  assert.deepEqual(p.frames().map(frame => frame.data), ['AQI=', 'BAU=']);
  assert.equal(socket.sent[0], view);
});

test('Blob conversion preserves send, receive and close event order', async () => {
  const p = page();
  p.load('main-hook.js');
  p.ready();
  const socket = new p.sandbox.WebSocket('wss://gateway.maj-soul.com');
  let release;
  const wait = new Promise(resolve => {release = resolve;});
  const blob = new p.FakeBlob([1], wait);
  socket.send(blob);
  socket.emit('message', new Uint8Array([2]));
  socket.send(new Uint8Array([3]));
  socket.close();
  await pause();
  assert.equal(p.frames().length, 0);
  assert.equal(socket.sent[0], blob);
  release();
  await pause();
  assert.deepEqual(p.frames().map(frame => [frame.direction, frame.data]), [['send', 'AQ=='], ['receive', 'Ag=='], ['send', 'Aw=='], ['close', undefined]]);
  assert.equal(new Set(p.frames().map(frame => frame.connection)).size, 1);
});

test('hook buffers until isolated relay is ready and uses unique connection IDs', async () => {
  const p = page();
  p.load('main-hook.js');
  const first = new p.sandbox.WebSocket('wss://gateway.maj-soul.com');
  const second = new p.sandbox.WebSocket('wss://gateway.maj-soul.com');
  first.send(new Uint8Array([1]));
  second.send(new Uint8Array([2]));
  await pause();
  assert.equal(p.frames().length, 0);
  p.ready();
  await pause();
  assert.equal(p.frames().length, 2);
  assert.notEqual(p.frames()[0].connection, p.frames()[1].connection);
  assert.equal(p.frames()[0].connection.split(':')[0], p.frames()[1].connection.split(':')[0]);
  const wrapped = p.sandbox.WebSocket;
  p.load('main-hook.js');
  assert.equal(p.sandbox.WebSocket, wrapped);
});

test('isolated relay handles either injection order and serializes runtime delivery', async () => {
  for (const order of [['main-hook.js', 'relay.js'], ['relay.js', 'main-hook.js']]) {
    const p = page();
    const received = [];
    const releases = [];
    p.sandbox.chrome = {runtime: {sendMessage(message) {
      received.push(message);
      return new Promise(resolve => releases.push(resolve));
    }}};
    for (const file of order) p.load(file);
    const socket = new p.sandbox.WebSocket('wss://gateway.maj-soul.com');
    socket.send(new Uint8Array([1]));
    socket.emit('message', new Uint8Array([2]));
    socket.close();
    await pause();
    assert.equal(received.length, 1);
    releases.shift()({ok: true});
    await pause();
    assert.equal(received.length, 2);
    releases.shift()({ok: true});
    await pause();
    assert.equal(received.length, 3);
    assert.deepEqual(received.map(message => message.payload.direction), ['send', 'receive', 'close']);
    releases.shift()({ok: true});
    await pause();
  }
});

function background(fetchImpl) {
  const local = {};
  const session = {};
  const calls = [];
  let listener;
  let accessLevel;
  const storage = data => ({
    async get(key) {return {[key]: data[key]};},
    async set(value) {Object.assign(data, value);},
    async remove(key) {delete data[key];},
    async setAccessLevel(value) {accessLevel = value.accessLevel;}
  });
  const sandbox = {
    URL,
    AbortSignal,
    chrome: {
      runtime: {id: 'test', getURL: file => `chrome-extension://test/${file}`, onMessage: {addListener(value) {listener = value;}}},
      storage: {local: storage(local), session: storage(session)},
      action: {async setBadgeText() {}, async setBadgeBackgroundColor() {}}
    },
    fetch: async (url, options) => {
      calls.push({url, options});
      return fetchImpl ? fetchImpl(url, options) : {ok: true, status: 204};
    }
  };
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), vm.createContext(sandbox));
  const settingsSender = {id: 'test', url: 'chrome-extension://test/popup.html'};
  const gameSender = {id: 'test', url: 'https://game.maj-soul.com/1/', tab: {id: 7}, frameId: 0};
  function request(message, sender = settingsSender) {return new Promise(resolve => {assert.equal(listener(message, sender, resolve), true);});}
  return {local, session, calls, request, gameSender, get accessLevel() {return accessLevel;}};
}

test('background keeps the token in trusted storage and validates page origin', async () => {
  const b = background();
  const token = 'a'.repeat(48);
  assert.equal((await b.request({type: 'save-token', token})).ok, true);
  assert.equal(b.accessLevel, 'TRUSTED_CONTEXTS');
  const settings = await b.request({type: 'settings'});
  assert.equal(settings.hasToken, true);
  assert.equal(JSON.stringify(settings).includes(token), false);
  assert.equal((await b.request({type: 'settings'}, b.gameSender)).ok, false);
  assert.equal((await b.request({type: 'save-token', token: 'b'.repeat(48)}, b.gameSender)).ok, false);
  const frame = {type: 'frame', payload: {connection, direction: 'send', data: 'AQI='}};
  assert.equal((await b.request(frame, {...b.gameSender, url: 'https://game.maj-soul.com.evil.example/'})).ok, false);
  assert.equal((await b.request(frame, {...b.gameSender, url: 'http://game.maj-soul.com/'})).ok, false);
  assert.equal((await b.request(frame, {...b.gameSender, tab: undefined})).ok, false);
  assert.equal((await b.request(frame, b.gameSender)).ok, true);
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].url, 'http://127.0.0.1:19221/frame');
  assert.equal(b.calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(b.calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(b.calls[0].options.body), frame.payload);
  assert.equal((await b.request({type: 'clear-token'})).ok, true);
  assert.equal(b.local.bridgeToken, undefined);
});

test('background validates frames and reports authentication failures without token exposure', async () => {
  const b = background(() => ({ok: false, status: 403}));
  const token = 'a'.repeat(48);
  await b.request({type: 'save-token', token});
  for (const payload of [
    {connection: 'untrusted', direction: 'send', data: 'AQ=='},
    {connection, direction: 'send', data: '!bad'},
    {connection, direction: 'close', data: 'AQ=='},
    {connection, direction: 'other', data: 'AQ=='},
    {connection, direction: 'receive', data: 'AAAA'.repeat(349527)}
  ]) assert.equal((await b.request({type: 'frame', payload}, b.gameSender)).ok, false);
  assert.equal(b.calls.length, 0);
  const result = await b.request({type: 'frame', payload: {connection, direction: 'close'}}, b.gameSender);
  assert.equal(result.ok, false);
  assert.match(result.error, /密钥失效/);
  assert.equal(JSON.stringify(await b.request({type: 'settings'})).includes(token), false);
});

test('background serializes requests for a socket, including close', async () => {
  let release;
  const b = background(async () => {
    if (b.calls.length === 1) await new Promise(resolve => {release = resolve;});
    return {ok: true, status: 204};
  });
  await b.request({type: 'save-token', token: 'a'.repeat(48)});
  const first = b.request({type: 'frame', payload: {connection, direction: 'send', data: 'AQ=='}}, b.gameSender);
  const second = b.request({type: 'frame', payload: {connection, direction: 'receive', data: 'Ag=='}}, b.gameSender);
  const close = b.request({type: 'frame', payload: {connection, direction: 'close'}}, b.gameSender);
  await pause();
  assert.equal(b.calls.length, 1);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal((await close).ok, true);
  assert.deepEqual(b.calls.map(call => JSON.parse(call.options.body).direction), ['send', 'receive', 'close']);
});

test('background accepts the full binary frame limit without recursive validation', async () => {
  const b = background();
  await b.request({type: 'save-token', token: 'a'.repeat(48)});
  const data = Buffer.alloc(1024 * 1024, 1).toString('base64');
  assert.equal((await b.request({type: 'frame', payload: {connection, direction: 'receive', data}}, b.gameSender)).ok, true);
  assert.equal(JSON.parse(b.calls[0].options.body).data.length, data.length);
});

test('manifest limits page injection and grants only the local bridge host', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:19221/*']);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.content_scripts.length, 2);
  assert.deepEqual(manifest.content_scripts.map(script => script.world), ['MAIN', 'ISOLATED']);
  for (const script of manifest.content_scripts) {
    assert.equal(script.run_at, 'document_start');
    assert.equal(script.matches.length, 4);
    assert.ok(script.matches.every(match => match.startsWith('https://') && !match.includes('://*')));
  }
  assert.equal(manifest.web_accessible_resources, undefined);
});
