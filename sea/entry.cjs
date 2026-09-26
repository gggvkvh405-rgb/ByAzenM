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

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
