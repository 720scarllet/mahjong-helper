'use strict';
const bridge = 'http://127.0.0.1:19221/frame';
const gameHosts = new Set(['game.maj-soul.com', 'game.maj-soul.net', 'game.mahjongsoul.com', 'mahjongsoul.game.yo-star.com']);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const connectionPattern = new RegExp(`^${uuid}:${uuid}$`, 'i');
const queues = new Map();
let status = {state: 'idle', lastAt: 0, error: ''};
let lastStoredAt = 0;
const initialized = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const saved = await chrome.storage.session.get('bridgeStatus');
  if (saved.bridgeStatus) status = saved.bridgeStatus;
})();

function gameSender(sender) {
  if (!sender.tab || sender.id !== chrome.runtime.id) return false;
  try {const url = new URL(sender.url); return url.protocol === 'https:' && gameHosts.has(url.hostname);} catch {return false;}
}

function settingsSender(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
}

function validFrame(payload) {
  if (!payload || typeof payload.connection !== 'string' || !connectionPattern.test(payload.connection)) return false;
  if (payload.direction === 'close') return payload.data === undefined;
  return ['send', 'receive'].includes(payload.direction) && typeof payload.data === 'string' && payload.data.length <= 1398104 && payload.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(payload.data);
}

async function updateStatus(state, error = '') {
  const changed = state !== status.state || error !== status.error;
  status = {state, error, lastAt: state === 'connected' ? Date.now() : status.lastAt};
  if (changed || Date.now() - lastStoredAt > 5000) {
    lastStoredAt = Date.now();
    await chrome.storage.session.set({bridgeStatus: status});
    await chrome.action.setBadgeText({text: state === 'connected' ? 'ON' : state === 'error' ? '!' : ''});
    await chrome.action.setBadgeBackgroundColor({color: state === 'error' ? '#b94b4b' : '#24775e'});
  }
}

async function deliver(payload) {
  await initialized;
  const {bridgeToken} = await chrome.storage.local.get('bridgeToken');
  if (!bridgeToken) {await updateStatus('idle'); return {ok: false, error: '请先保存连接密钥'};}
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${bridgeToken}`},
      body: JSON.stringify(payload),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(response.status === 403 ? '密钥失效，请从悬浮窗重新复制' : `接入失败（${response.status}）`);
    await updateStatus('connected');
    return {ok: true};
  } catch (error) {
    const message = error.message?.startsWith('密钥') || error.message?.startsWith('接入失败') ? error.message : '无法连接悬浮窗，请确认助手已启动';
    await updateStatus('error', message);
    return {ok: false, error: message};
  }
}

async function handle(message, sender) {
  if (message?.type === 'frame') {
    if (!gameSender(sender) || !validFrame(message.payload)) return {ok: false, error: '无效的对局消息'};
    const payload = {connection: message.payload.connection, direction: message.payload.direction};
    if (payload.direction !== 'close') payload.data = message.payload.data;
    const key = `${sender.tab.id}:${sender.frameId}:${payload.connection}`;
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => deliver(payload));
    queues.set(key, next);
    try {return await next;} finally {if (queues.get(key) === next) queues.delete(key);}
  }
  if (!settingsSender(sender)) return {ok: false, error: '无效请求'};
  await initialized;
  if (message.type === 'settings') {
    const {bridgeToken} = await chrome.storage.local.get('bridgeToken');
    return {ok: true, hasToken: !!bridgeToken, status};
  }
  if (message.type === 'save-token') {
    const value = typeof message.token === 'string' ? message.token.trim() : '';
    if (!/^[0-9a-f]{48}$/i.test(value)) return {ok: false, error: '请粘贴悬浮窗复制的完整密钥'};
    await chrome.storage.local.set({bridgeToken: value});
    await updateStatus('idle');
    return {ok: true};
  }
  if (message.type === 'clear-token') {
    await chrome.storage.local.remove('bridgeToken');
    await updateStatus('idle');
    return {ok: true};
  }
  return {ok: false, error: '未知请求'};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond).catch(() => respond({ok: false, error: '扩展接入发生错误，请重新加载扩展'}));
  return true;
});
