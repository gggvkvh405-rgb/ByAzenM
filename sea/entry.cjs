/**
 * Variant 1 — portable SEA entry.
 * Env is set before start(), so better-sqlite3 and multer are never loaded.
 */
process.env.DISABLE_SQLITE = '1';
process.env.DISABLE_MULTER = '1';
process.env.CBOPKA_AUTOSTART = '0';
process.env.CBOPKA_OPEN_BROWSER = '1';
process.env.PORT = process.env.PORT || '3000';

const path = require('path');
const fs = require('fs');
const { start } = require('../server/index.js');
const { startPublicHost } = require('../electron/tunnel.js');

process.env.DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(process.execPath), 'cbopka-data');

function findDist() {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    process.env.CLIENT_DIST_PATH,
    path.join(execDir, 'client', 'dist'),
    path.join(execDir, 'client-dist'),
    path.join(process.cwd(), 'client', 'dist'),
    path.join(__dirname, '..', 'client', 'dist')
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, 'index.html'))) return p; } catch (e) {}
  }
  return '';
}

const dist = findDist();
if (dist && !process.env.CLIENT_DIST_PATH) process.env.CLIENT_DIST_PATH = dist;

function writeHost(status, url) {
  const dir = process.env.DATA_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'public-url-status.txt'), status || '');
    if (url) fs.writeFileSync(path.join(dir, 'public-url.txt'), url);
  } catch {}
}

start().then((boundPort) => {
  if (process.env.CBOPKA_NO_TUNNEL === '1') return;
  writeHost('Открываем адрес для друга…');
  startPublicHost({
    port: Number(boundPort || process.env.PORT || 3000),
    cacheDir: process.env.DATA_DIR,
    onStatus: (s) => writeHost(s)
  }).then((handle) => {
    writeHost('Ссылка для друга готова. Отправь её и звони.', handle.url);
    console.log('FRIEND URL ' + handle.url);
  }).catch((e) => {
    writeHost('Хост не открылся: ' + (e.message || e));
    console.error(e);
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
