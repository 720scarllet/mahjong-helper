const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs');
const crypto = require('node:crypto');
const exec = promisify(execFile);
const KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const LOCAL_PROXY = '127.0.0.1:19222';
const APPLIED = {ProxyEnable: 1, ProxyServer: LOCAL_PROXY, ProxyOverride: '<local>', AutoConfigURL: null};
const SNAPSHOT = `$ErrorActionPreference='Stop'; $p=Get-ItemProperty -LiteralPath '${KEY}'; @{ProxyEnable=$p.ProxyEnable;ProxyServer=$p.ProxyServer;ProxyOverride=$p.ProxyOverride;AutoConfigURL=$p.AutoConfigURL}|ConvertTo-Json -Compress`;
const refresh = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ProxyNotify { [DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }'; [ProxyNotify]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null; [ProxyNotify]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null;`;
const quoted = value => "'" + String(value).replaceAll("'", "''") + "'";

class WindowsProxy {
  constructor(stateFile, options = {}) {
    this.file = stateFile;
    this.exec = options.exec || exec;
    this.pending = Promise.resolve();
  }
  async run(script) {
    const result = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {windowsHide: true, timeout: 15000});
    return result.stdout.trim();
  }
  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  enable(cert, mode = 'system') {return this.enqueue(() => this._enable(cert, mode));}
  restore() {return this.enqueue(() => this._restore());}

  async _enable(cert, mode) {
    if (!['system', 'inject'].includes(mode)) throw new Error('未知客户端代理模式');
    if (fs.existsSync(this.file)) throw new Error('代理恢复记录尚未清理，请先关闭代理');
    const fingerprint = new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint.replaceAll(':', '');
    const before = JSON.parse(await this.run(SNAPSHOT));
    const existed = (await this.run(`Test-Path 'Cert:\\CurrentUser\\Root\\${fingerprint}'`)) === 'True';
    fs.writeFileSync(this.file, JSON.stringify({before, fingerprint, existed, mode}), {flag: 'wx', mode: 0o600});
    try {
      if (!existed) await this.exec('certutil.exe', ['-user', '-addstore', 'Root', cert], {windowsHide: true, timeout: 15000});
      if (mode === 'system') {
        // Set the server before enabling it, so a partial failure remains
        // identifiable and recoverable from the saved record.
        await this.run(`$ErrorActionPreference='Stop'; Set-ItemProperty -LiteralPath '${KEY}' -Name ProxyServer -Value '${LOCAL_PROXY}'; Set-ItemProperty -LiteralPath '${KEY}' -Name ProxyOverride -Value '<local>'; Remove-ItemProperty -LiteralPath '${KEY}' -Name AutoConfigURL -ErrorAction SilentlyContinue; Set-ItemProperty -LiteralPath '${KEY}' -Name ProxyEnable -Value 1; ${refresh}`);
      }
    } catch (error) {
      try {await this._restore();} catch (restoreError) {throw new AggregateError([error, restoreError], `代理启动失败，恢复设置也失败：${restoreError.message}`);}
      throw error;
    }
  }

  async _restore() {
    if (!fs.existsSync(this.file)) return;
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!saved.before || typeof saved.before !== 'object' || !/^[a-f0-9]{40}$/i.test(saved.fingerprint) || typeof saved.existed !== 'boolean') throw new Error('代理恢复记录无效，请保留记录并检查设置');
    if (saved.mode !== 'inject') {
      const current = JSON.parse(await this.run(SNAPSHOT));
      if (current.ProxyServer === LOCAL_PROXY) {
        let script = `$ErrorActionPreference='Stop'; `;
        for (const [name, applied] of Object.entries(APPLIED)) {
          // Restore only values still owned by this tool; retain concurrent
          // changes to the enable switch, bypass list, or configuration URL.
          if ((current[name] ?? null) !== applied) continue;
          const value = saved.before[name];
          if (value != null && typeof value !== 'string' && typeof value !== 'number') throw new Error('代理恢复记录包含无效设置');
          script += value == null ? `Remove-ItemProperty -LiteralPath '${KEY}' -Name '${name}' -ErrorAction SilentlyContinue; ` : `Set-ItemProperty -LiteralPath '${KEY}' -Name '${name}' -Value ${typeof value === 'number' ? value : quoted(value)}; `;
        }
        await this.run(script + refresh);
      }
    }
    if (!saved.existed && (await this.run(`Test-Path 'Cert:\\CurrentUser\\Root\\${saved.fingerprint}'`)) === 'True') {
      await this.exec('certutil.exe', ['-user', '-delstore', 'Root', saved.fingerprint], {windowsHide: true, timeout: 15000});
    }
    fs.unlinkSync(this.file);
  }
}

module.exports = {WindowsProxy};
