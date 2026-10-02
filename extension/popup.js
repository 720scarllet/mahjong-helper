'use strict';
const input = document.querySelector('#token');
const notice = document.querySelector('#notice');
const connection = document.querySelector('#connection');
const indicator = document.querySelector('#indicator');
const buttons = document.querySelectorAll('button');

function showNotice(text, error = false) {
  notice.textContent = text;
  notice.dataset.error = String(error);
}

async function refresh() {
  const result = await chrome.runtime.sendMessage({type: 'settings'});
  if (!result.ok) throw new Error(result.error);
  const status = result.status;
  indicator.dataset.state = result.hasToken ? status.state : 'idle';
  connection.textContent = !result.hasToken ? '尚未配置密钥' : status.state === 'connected' ? '已连接本机悬浮窗' : status.state === 'error' ? '连接中断' : '密钥已保存 · 等待游戏消息';
  if (status.state === 'error' && result.hasToken) showNotice(status.error, true);
}

async function update(message, success) {
  for (const button of buttons) button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result.ok) throw new Error(result.error);
    input.value = '';
    await refresh();
    showNotice(success);
  } catch (error) {showNotice(error.message, true);}
  finally {for (const button of buttons) button.disabled = false;}
}

document.querySelector('#settings').addEventListener('submit', event => {
  event.preventDefault();
  update({type: 'save-token', token: input.value}, '密钥已保存，请刷新雀魂游戏页面。');
});
document.querySelector('#clear').addEventListener('click', () => update({type: 'clear-token'}, '密钥已清除。'));
refresh().catch(error => showNotice(error.message, true));
