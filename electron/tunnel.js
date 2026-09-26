/**
 * Opens a public HTTPS address to the local Cbopka server when the app starts.
 * The friend opens that link in a browser; both sides are then on the same server.
 * cloudflared is downloaded on first launch (not baked into the exe — GitHub's 100MB limit).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CF_VERSION = '2026.9.3';

function cfName() {
  if (process.platform === 'win32') return 'cloudflared.exe';
  return 'cloudflared';
}

function cfAsset() {
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'cloudflared-darwin-arm64' : 'cloudflared-darwin-amd64';
  return 'cloudflared-linux-amd64';
}

function cfUrl() {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/${cfAsset()}`;
}

function extractUrl(text) {
  const re = /https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*\.(?:trycloudflare\.com|lhr\.life|localhost\.run|pinggy\.link)/g;
  const found = String(text).match(re);
  return found ? found[found.length - 1] : null;
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('слишком много редиректов'));
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'Cbopka/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(new URL(res.headers.location, url).href, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('скачивание хоста: HTTP ' + res.statusCode));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('таймаут скачивания хоста')));
  });
}

async function ensureCloudflared(cacheDir) {
  const dest = path.join(cacheDir, cfName());
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5_000_000) return dest;
  } catch {}
  const tmp = dest + '.download';
  await downloadFile(cfUrl(), tmp);
  const size = fs.statSync(tmp).size;
  if (size < 5_000_000) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('файл хоста слишком маленький');
  }
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o755); } catch {}
  try { fs.unlinkSync(dest + ':Zone.Identifier'); } catch {}
  return dest;
}

function runAndWait(command, args, timeoutMs, logPath) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let buf = '';
    let settled = false;
    const finish = (err, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { child.kill(); } catch {}
        reject(err);
      } else {
        resolve({
          url,
          kill() { try { child.kill(); } catch {} }
        });
      }
    };
    const timer = setTimeout(() => finish(new Error('хост не ответил адресом')), timeoutMs);
    const onData = (chunk) => {
      const text = chunk.toString();
      buf += text;
      if (logPath) { try { fs.appendFileSync(logPath, text); } catch {} }
      const url = extractUrl(buf);
      if (url) finish(null, url);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => {
      if (!settled) finish(new Error('хост закрылся (' + code + ')'));
    });
  });
}

function sshArgs(port, mode) {
  const known = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const base = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + known, '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes'];
  if (mode === 'pinggy') {
    return [...base, '-p', '443', '-R', `0:127.0.0.1:${port}`, 'free@a.pinggy.io'];
  }
  return [...base, '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'];
}

async function startPublicHost({ port, cacheDir, onStatus }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const logPath = path.join(cacheDir, 'tunnel.log');
  try { fs.writeFileSync(logPath, ''); } catch {}
  const errors = [];

  try {
    onStatus?.('Скачиваем хост (один раз, потом быстрее)…');
    const bin = await ensureCloudflared(cacheDir);
    onStatus?.('Открываем адрес для друга…');
    return await runAndWait(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--protocol', 'http2'], 45000, logPath);
  } catch (e) {
    errors.push(e.message);
  }

  const ssh = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
  for (const mode of ['localhost.run', 'pinggy']) {
    try {
      onStatus?.('Пробуем запасной хост…');
      return await runAndWait(ssh, sshArgs(port, mode), 20000, logPath);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.filter(Boolean).join(' · ') || 'хост не открылся');
}

module.exports = { startPublicHost, extractUrl };
