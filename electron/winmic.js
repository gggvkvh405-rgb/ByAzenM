const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PS1 = [
  'param([int]$Port, [string]$Dll, [string]$Src)',
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'try {',
  '  if ($Dll) { Add-Type -Path $Dll }',
  '  else {',
  '    $code = [System.IO.File]::ReadAllText($Src)',
  '    Add-Type -TypeDefinition $code -CompilerOptions "/warn:0 /nologo"',
  '  }',
  '  [CbopkaMic]::Run($Port)',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
  ''
].join('\r\n');

let child = null;
let server = null;
let sock = null;
let live = null;
let inflight = null;
let session = 0;
let stoppedAt = 0;
let unlockDone = false;

function parseFrames(state, chunk, onStatus, onPcm) {
  const next = state.buf && state.buf.length ? Buffer.concat([state.buf, chunk]) : Buffer.from(chunk);
  state.buf = next;
  while (state.buf.length >= 5) {
    const type = state.buf[0];
    const len = state.buf.readUInt32LE(1);
    if (len > 200000) {
      state.buf = Buffer.alloc(0);
      if (onStatus) onStatus('FAIL\t0\tbad frame');
      return;
    }
    if (state.buf.length < 5 + len) return;
    const payload = state.buf.subarray(5, 5 + len);
    state.buf = state.buf.subarray(5 + len);
    if (type === 1 && onStatus) onStatus(payload.toString('utf8'));
    else if (type === 2 && onPcm) onPcm(payload);
  }
}

function describeFail(token, text) {
  const raw = String(text || '');
  if (/System\.Exception|\.cs\(|CS\d{4}|Add-Type|CompilerError/i.test(raw)) return 'захват Windows не собрался';
  const t = String(token || '').toUpperCase();
  const map = {
    1: 'драйвер не открыл микрофон',
    4: 'микрофон занят другой программой',
    5: 'Windows запретила доступ к микрофону',
    6: 'нет драйвера записи',
    2: 'устройство записи не найдено',
    32: 'формат записи не подошёл',
    '8889000A': 'микрофон занят другой программой',
    '88890008': 'формат записи не подошёл',
    '8889000E': 'драйвер отказал в общем режиме',
    '80070005': 'Windows запретила доступ к микрофону',
    '80070057': 'драйвер не принял формат звука'
  };
  if (map[t]) return map[t];
  if (/^(open|wave|wasapi|capture|mic)$/i.test(raw.trim())) return t && t !== '0' ? ('код ' + t) : 'микрофон не открылся';
  const line = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  if (!line || /[^\x09\x0a\x0d\x20-\x7e\u0400-\u04FF]/.test(line)) return t && t !== '0' ? ('код ' + t) : 'микрофон не открылся';
  return line.slice(0, 140);
}

function cscPath() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || '';
}

function compileHelper(csPath, dir) {
  const csc = cscPath();
  if (!csc) return Promise.resolve('');
  const hash = crypto.createHash('sha1').update(fs.readFileSync(csPath)).digest('hex').slice(0, 10);
  const dll = path.join(dir, 'CbopkaMic-' + hash + '.dll');
  if (fs.existsSync(dll)) return Promise.resolve(dll);
  return new Promise((resolve) => {
    execFile(csc, [
      '/nologo', '/optimize+', '/warn:0', '/target:library',
      '/r:System.dll',
      '/utf8output', '/out:' + dll, csPath
    ], { windowsHide: true, timeout: 25000 }, (err) => {
      resolve(!err && fs.existsSync(dll) ? dll : '');
    });
  });
}


function likelyHolder() {
  if (process.platform !== 'win32') return Promise.resolve('');
  const known = [
    [/voicemod/i, 'Voicemod'],
    [/discord/i, 'Discord'],
    [/zoom/i, 'Zoom'],
    [/teams/i, 'Teams'],
    [/skype/i, 'Skype'],
    [/obs64|obs32/i, 'OBS'],
    [/valorant-win64|valorant/i, 'Valorant'],
    [/cs2|csgo/i, 'Counter-Strike'],
    [/genshinimpact|yuanshen|genshin/i, 'Genshin Impact']
  ];
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      const text = String(stdout || '');
      const hit = known.find(([re]) => re.test(text));
      resolve(hit ? hit[1] : '');
    });
  });
}

function userDataDir() {
  try { return require('electron').app.getPath('userData'); } catch {}
  return path.join(process.env.TEMP || process.env.TMP || '/tmp', 'cbopka-mic');
}

function bundledSource() {
  const candidates = [
    path.join(__dirname, 'mic-helper.cs'),
    path.join(process.resourcesPath || '', 'mic-helper.cs')
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return fs.readFileSync(p);
    } catch {}
  }
  throw new Error('mic-helper.cs missing');
}

function materializeSource() {
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'mic-helper.cs');
  fs.writeFileSync(dest, bundledSource());
  const ps1 = path.join(dir, 'cbopka-mic.ps1');
  fs.writeFileSync(ps1, PS1, 'ascii');
  return { dir, cs: dest, ps1 };
}

function regAdd(key, name, type, data) {
  return new Promise((resolve) => {
    execFile('reg', ['add', key, '/v', name, '/t', type, '/d', data, '/f'], { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

function unlockMicConsent() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false });
  if (unlockDone) return Promise.resolve({ ok: true });
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const paths = [process.execPath, ps].filter(Boolean).map((p) => p.replace(/\\/g, '#'));
  const jobs = [
    regAdd(base, 'Value', 'REG_SZ', 'Allow'),
    regAdd(base + '\\NonPackaged', 'Value', 'REG_SZ', 'Allow'),
    regAdd(base + '\\ConsentV2Unverified', 'Value', 'REG_DWORD', '1')
  ];
  for (const encoded of paths) {
    jobs.push(regAdd(base + '\\NonPackaged\\' + encoded, 'Value', 'REG_SZ', 'Allow'));
  }
  return Promise.all(jobs).then((flags) => {
    if (flags.some(Boolean)) unlockDone = true;
    return { ok: flags.some(Boolean) };
  });
}

function powershellExe() {
  const full = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

function cleanup() {
  try { sock && sock.destroy(); } catch {}
  try { server && server.close(); } catch {}
  sock = null;
  server = null;
  if (child && !child.killed) {
    try { child.kill(); } catch {}
  }
  child = null;
  live = null;
}

function stopNativeMic() {
  session += 1;
  stoppedAt = Date.now();
  cleanup();
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launch(onPcm) {
  const my = session;
  let files;
  try { files = materializeSource(); } catch (e) {
    return { ok: false, error: e.message, code: 'missing' };
  }
  let dll = '';
  try { dll = await compileHelper(files.cs, files.dir); } catch { dll = ''; }
  return new Promise((resolve) => {
    const listener = net.createServer();
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (my !== session) {
        resolve({ ok: false, error: 'stopped', code: 'stopped' });
        return;
      }
      if (!res.ok) cleanup();
      else live = { result: res, onPcm };
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'микрофон Windows не ответил', code: 'timeout' }), 20000);
    listener.on('connection', (socket) => {
      const addr = socket.remoteAddress || '';
      if (addr && addr !== '127.0.0.1' && !addr.endsWith('127.0.0.1')) {
        socket.destroy();
        return;
      }
      sock = socket;
      const state = { buf: Buffer.alloc(0) };
      socket.on('data', (chunk) => {
        parseFrames(state, chunk, (status) => {
          if (status.startsWith('READY')) {
            const p = status.split('\t');
            finish({ ok: true, engine: p[1] || '', device: p[2] || 'микрофон Windows', rate: Number(p[3]) || 16000 });
          } else if (status.startsWith('FAIL')) {
            const p = status.split('\t');
            finish({ ok: false, code: p[1] || '', error: describeFail(p[1], p.slice(2).join(' ')) });
          }
        }, (pcm) => {
          const b64 = pcm.toString('base64');
          if (live && live.onPcm) live.onPcm(b64);
        });
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (!settled) finish({ ok: false, error: 'захват закрылся', code: 'closed' });
        if (live && my === session) live = null;
      });
    });
    listener.on('error', (e) => finish({ ok: false, error: e.message, code: 'listen' }));
    server = listener;
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      let log = '';
      const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', files.ps1, '-Port', String(port)
      ];
      if (dll) args.push('-Dll', dll);
      else args.push('-Src', files.cs);
      const proc = spawn(powershellExe(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (my !== session) {
        try { proc.kill(); } catch {}
        return;
      }
      child = proc;
      const take = (buf) => {
        log += buf.toString();
        if (log.length > 4000) log = log.slice(-4000);
      };
      proc.stdout?.on('data', take);
      proc.stderr?.on('data', take);
      proc.on('error', (e) => finish({ ok: false, error: e.message, code: 'spawn' }));
      proc.on('exit', (code) => {
        if (!settled) finish({ ok: false, error: describeFail('', log) || ('процесс завершился ' + code), code: String(code ?? 'exit') });
      });
    });
  });
}


function startNativeMic(onPcm) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'not-windows', code: 'platform' });
  if (live && child && !child.killed) {
    live.onPcm = onPcm || live.onPcm;
    return Promise.resolve(live.result);
  }
  if (inflight) {
    return inflight.then((res) => {
      if (live && onPcm) live.onPcm = onPcm;
      return res;
    });
  }
  inflight = (async () => {
    const gap = 500 - (Date.now() - stoppedAt);
    if (stoppedAt && gap > 0) await sleep(gap);
    try { await unlockMicConsent(); } catch {}
    const res = await launch(onPcm);
    if (res && !res.ok && res.code !== 'stopped') {
      try { res.holder = await likelyHolder(); } catch {}
    }
    return res;
  })().finally(() => { inflight = null; });
  return inflight;
}

module.exports = { parseFrames, describeFail, startNativeMic, stopNativeMic, unlockMicConsent };
