import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createStore, openSqlite, avatarData } from './store.js';
import { generateSecret, verifyTotp, otpauthUrl } from './totp.js';
import { iceServers, transportInfo } from './ice.js';
import { createSfu } from './sfu.js';

function hereDir() {
  try {
    if (import.meta && import.meta.url) return path.dirname(fileURLToPath(import.meta.url));
  } catch {}
  return process.cwd();
}
const __dirname = hereDir();

async function start() {
  const PORT = Number(process.env.PORT || 3000);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  let multer = null;
  let Database = null;
  let sqlite = null;
  let useSQLite = false;

  // Critical: never load native/optional modules when Electron sets these flags.
  // Access Violation 0xC0000005 (3221225477) happens if better-sqlite3/multer load inside Electron's node.
  if (process.env.DISABLE_MULTER !== '1') {
    try {
      multer = (await import('multer')).default;
      console.log('✅ multer loaded');
    } catch (e) {
      console.log('⚠️ multer not available, JSON upload fallback:', e.message);
      multer = null;
    }
  } else {
    // disabled
    console.log('⚠️ multer disabled via DISABLE_MULTER');
    multer = null;
  }

  if (process.env.DISABLE_SQLITE !== '1') {
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default;
      const dbPath = process.env.DB_PATH || path.join(dataDir, 'cbopka.db');
      sqlite = openSqlite(Database, dbPath);
      useSQLite = true;
      console.log('✅ SQLite persistence at', dbPath);
    } catch (e) {
      console.log('⚠️ better-sqlite3 not available, using in-memory Maps:', e.message);
      useSQLite = false;
      sqlite = null;
    }
  } else {
    console.log('⚠️ SQLite disabled via DISABLE_SQLITE, using in-memory Maps');
    useSQLite = false;
    sqlite = null;
  }

  let Sentry = null;
  if (process.env.SENTRY_DSN) {
    try {
      Sentry = await import('@sentry/node');
      Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.05 });
      console.log('✅ Sentry enabled');
    } catch (e) {
      console.log('Sentry skipped:', e.message);
    }
  }

  let webpush = null;
  try {
    if (process.env.DISABLE_WEBPUSH === '1') throw new Error('disabled');
    webpush = (await import('web-push')).default || (await import('web-push'));
  } catch {
    webpush = null;
  }

  const sfu = await createSfu();
  console.log(sfu.available ? '✅ SFU mediasoup' : 'ℹ️  group calls: mesh (' + sfu.reason + ')');

  const store = createStore({
    persist: true,
    dataDir,
    db: useSQLite ? sqlite : null
  });

  // in-memory runtime (voice rooms, sockets, rate limits) — not the message store
  const userSockets = new Map();
  const voiceRooms = new Map();
  const calls = new Map();
  const rate = new Map();

  function hitRate(key, limit, windowMs) {
    const now = Date.now();
    const arr = (rate.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    rate.set(key, arr);
    return arr.length <= limit;
  }

  function pub(u, self = false) {
    return store.publicUser(u, self);
  }

  function ensureSeed() {
    let bot = store.getUserByName('cbopka');
    if (!bot) {
      bot = {
        id: crypto.randomUUID(),
        username: 'cbopka',
        usernameLower: 'cbopka',
        passwordHash: '!',
        avatar: avatarData('Cbopka'),
        bio: 'Бот Cbopka. /help /dice /weather /shrug',
        status: 'online',
        customStatus: 'слежу за чатом',
        customEmoji: '✦',
        activity: null,
        lastSeen: Date.now(),
        createdAt: Date.now(),
        theme: 'dark',
        accent: '',
        nitro: true,
        totpSecret: '',
        totpEnabled: false,
        system: true,
        customEmojis: [],
        privacy: { dm: 'everyone', calls: 'nobody', showLastSeen: 'everyone' }
      };
      store.state.users[bot.id] = bot;
      store.state.friendships[bot.id] = [];
      store.state.blocks[bot.id] = [];
    }
    let hq = Object.values(store.state.groups).find((g) => g.system);
    if (!hq) {
      hq = store.createGroup({
        name: 'Cbopka HQ',
        description: 'Дом, который не пропадает. Каналы, голос, анонсы.',
        ownerId: bot.id,
        system: true
      });
      const general = store.createChannel({ groupId: hq.id, name: 'общий', type: 'text' });
      store.createChannel({ groupId: hq.id, name: 'анонсы', type: 'announcement' });
      store.createChannel({ groupId: hq.id, name: 'Голосовой зал', type: 'voice' });
      store.addMessage({
        convoId: general.id,
        fromId: bot.id,
        type: 'text',
        text: 'Добро пожаловать в **Cbopka 2.0**.\n\nЗдесь уже есть текстовый канал, анонсы (пишут только админы) и голосовой зал 24/7. Личные чаты шифруются на устройстве. `/help` — команды бота.'
      });
    }
    store.saveNow();
    return { bot, hq: Object.values(store.state.groups).find((g) => g.system) };
  }

  const seed = ensureSeed();

  function joinHq(uid) {
    const hq = Object.values(store.state.groups).find((g) => g.system);
    if (hq && !hq.members[uid]) store.setMember(hq.id, uid, 'member');
    return hq;
  }

  function convoMembers(convoId) {
    if (!convoId) return [];
    if (convoId.startsWith('saved:')) return [convoId.slice(6)];
    if (convoId.startsWith('dm:')) return convoId.slice(3).split(':').filter(Boolean);
    if (convoId.startsWith('thread:')) {
      const parent = store.getMessage(convoId.slice(7));
      return parent ? convoMembers(parent.convoId) : [];
    }
    const ch = store.getChannel(convoId);
    if (!ch) return [];
    const g = store.getGroup(ch.groupId);
    return g ? Object.keys(g.members) : [];
  }

  function canAccess(uid, convoId) {
    const members = convoMembers(convoId);
    if (!members.includes(uid)) return false;
    if (convoId.startsWith('dm:')) {
      const other = members.find((id) => id !== uid);
      if (other && store.isBlocked(uid, other)) return false;
    }
    return true;
  }

  function canPost(uid, convoId) {
    if (!canAccess(uid, convoId)) return false;
    const ch = store.getChannel(convoId);
    if (ch?.type === 'announcement') {
      const role = store.memberRole(ch.groupId, uid);
      return role === 'admin' || role === 'mod';
    }
    if (ch?.type === 'voice') return false;
    return true;
  }

  function emitToUser(uid, event, payload) {
    const set = userSockets.get(uid);
    if (!set) return;
    for (const sid of set) io.to(sid).emit(event, payload);
  }

  function emitToConvo(convoId, event, payload, except) {
    for (const uid of convoMembers(convoId)) {
      if (uid === except) continue;
      emitToUser(uid, event, payload);
    }
  }

  function addSocket(uid, sid) {
    if (!userSockets.has(uid)) userSockets.set(uid, new Set());
    userSockets.get(uid).add(sid);
  }

  function removeSocket(uid, sid) {
    const set = userSockets.get(uid);
    if (!set) return 0;
    set.delete(sid);
    if (set.size === 0) userSockets.delete(uid);
    return set.size;
  }

  function onlineSnapshot() {
    const map = {};
    for (const uid of userSockets.keys()) {
      const u = store.getUser(uid);
      if (!u) continue;
      map[uid] = { status: u.status || 'online', customStatus: u.customStatus || '', customEmoji: u.customEmoji || '', activity: u.activity || null, lastSeen: u.lastSeen };
    }
    return map;
  }

  function voiceSnapshot(channelId) {
    const room = voiceRooms.get(channelId) || new Map();
    return [...room.entries()].map(([userId, st]) => ({ userId, ...st, user: pub(store.getUser(userId)) }));
  }

  async function botReply(convoId, text, fromId) {
    const bot = store.getUserByName('cbopka');
    if (!bot || fromId === bot.id) return null;
    const raw = String(text || '').trim();
    const lower = raw.toLowerCase();
    let reply = null;
    if (lower === '/help' || lower.startsWith('/help@') || lower === '@cbopka') {
      reply = 'Команды: `/help` `/dice` `/shrug` `/weather Город` `/time`\nСлэш в поле ввода: `/poll` `/gif` `/me` `/status`';
    } else if (lower === '/dice') {
      reply = `🎲 ${1 + Math.floor(Math.random() * 6)}`;
    } else if (lower === '/shrug') {
      reply = '¯\\_(ツ)_/¯';
    } else if (lower === '/time') {
      reply = 'Сейчас ' + new Date().toLocaleString('ru-RU');
    } else if (lower.startsWith('/weather')) {
      const city = raw.replace(/^\/weather\s*/i, '').trim() || 'Москва';
      try {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru`);
        const gj = await g.json();
        const loc = gj.results?.[0];
        if (!loc) reply = `Не нашёл город «${city}»`;
        else {
          const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code`);
          const wj = await w.json();
          const c = wj.current || {};
          reply = `${loc.name}: ${c.temperature_2m}°C, ощущается как ${c.apparent_temperature}°C, ветер ${c.wind_speed_10m} км/ч`;
        }
      } catch (e) {
        reply = 'Погода недоступна: ' + e.message;
      }
    }
    if (!reply) return null;
    const msg = store.addMessage({ convoId, fromId: bot.id, text: reply, type: 'text' });
    emitToConvo(convoId, 'message:new', msg);
    return msg;
  }

  function sendMessage(uid, payload) {
    const convoId = payload.convoId;
    if (!canPost(uid, convoId)) {
      const err = new Error('Нет права писать сюда');
      err.status = 403;
      throw err;
    }
    const text = String(payload.text ?? '');
    if (!text.trim() && payload.type !== 'file' && payload.type !== 'voice' && payload.type !== 'gif' && payload.type !== 'sticker' && payload.type !== 'poll' && !payload.e2e) {
      const err = new Error('Пустое сообщение');
      err.status = 400;
      throw err;
    }
    if (text.length > 4000) {
      const err = new Error('Слишком длинное сообщение');
      err.status = 400;
      throw err;
    }
    const other = convoId.startsWith('dm:') ? convoId.slice(3).split(':').find((id) => id !== uid) : null;
    if (other) {
      const target = store.getUser(other);
      const policy = target?.privacy?.dm || 'everyone';
      const friends = (store.state.friendships[other] || []).includes(uid);
      if (policy === 'friends' && !friends) {
        const err = new Error('Пользователь принимает сообщения только от друзей');
        err.status = 403;
        throw err;
      }
      if (policy === 'nobody') {
        const err = new Error('Пользователь закрыл личные сообщения');
        err.status = 403;
        throw err;
      }
    }
    const msg = store.addMessage({
      convoId,
      fromId: uid,
      text: payload.e2e ? '' : text.slice(0, 4000),
      type: payload.type || 'text',
      meta: payload.meta || null,
      replyTo: payload.replyTo || null,
      parentId: payload.parentId || null,
      ttl: payload.ttl || 0,
      e2e: Boolean(payload.e2e)
    });
    if (payload.e2e && payload.meta) msg.meta = payload.meta;
    emitToConvo(convoId, 'message:new', msg);
    if (!payload.e2e && payload.type !== 'system') botReply(convoId, text, uid).catch(() => {});
    return msg;
  }

  function clientCandidates() {
    return [
      process.env.CLIENT_DIST_PATH,
      path.join(__dirname, '../client/dist'),
      path.join(process.cwd(), 'client/dist'),
      path.join(path.dirname(process.execPath), 'client/dist'),
      path.join(path.dirname(process.execPath), 'client-dist'),
      path.join(__dirname, 'client-dist')
    ].filter(Boolean);
  }

  function resolveClientDist() {
    for (const p of clientCandidates()) {
      try {
        if (fs.existsSync(path.join(p, 'index.html'))) return p;
      } catch {}
    }
    return null;
  }

  const clientDist = resolveClientDist();
  console.log('Client dist:', clientDist || '(embedded/fallback)');

  let embedded = null;
  try {
    const embPath = path.join(__dirname, 'embedded-client.json');
    if (fs.existsSync(embPath)) embedded = JSON.parse(fs.readFileSync(embPath, 'utf8'));
  } catch {}

  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
    maxHttpBufferSize: 8e7
  });

  app.use(cors());
  app.use(express.json({ limit: '80mb' }));
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));
  if (clientDist) app.use(express.static(clientDist));

  let upload = null;
  if (multer) {
    const storage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname || ''))
    });
    upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });
  }

  function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
    const user = store.sessionUser(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    req.token = token;
    next();
  }

  function asyncRoute(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
      if (Sentry?.captureException) Sentry.captureException(e);
      res.status(e.status || 500).json({ error: e.message || 'error' });
    });
  }

  function readHostFile(name) {
    try { return fs.readFileSync(path.join(dataDir, name), 'utf8').trim(); } catch { return ''; }
  }
  app.get('/api/host', (_req, res) => {
    const url = readHostFile('public-url.txt') || process.env.CBOPKA_PUBLIC_URL || '';
    res.json({ url: url.startsWith('http') ? url : '', status: readHostFile('public-url-status.txt') });
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      name: 'Cbopka',
      version: '2.0.0',
      storage: useSQLite ? 'sqlite' : 'memory',
      multer: Boolean(multer),
      sfu: Boolean(sfu.available),
      sfuReason: sfu.reason,
      push: Boolean(webpush),
      transport: transportInfo(),
      features: [
        'chat', 'groups', 'channels', 'voice', 'webrtc', 'turn', 'e2e', '2fa', 'files', 'gifs', 'threads', 'polls', 'nitro'
      ]
    });
  });

  app.get('/api/turn', auth, (req, res) => {
    res.json({ iceServers: iceServers(), sfu: Boolean(sfu.available), transport: transportInfo() });
  });

  app.get('/api/transport', (req, res) => res.json(transportInfo()));

  app.post('/api/register', asyncRoute(async (req, res) => {
    if (!hitRate('reg:' + req.ip, 20, 60_000)) return res.status(429).json({ error: 'Слишком много попыток' });
    const { username, password, bio } = req.body || {};
    if (!password || String(password).length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    const user = await store.createUser({ username, password, bio });
    const identity = req.body.identityPub;
    if (identity) store.setKeys(user.id, { identityPub: identity });
    joinHq(user.id);
    const token = store.createSession(user.id);
    res.json({ token, user: pub(user, true) });
  }));

  app.post('/api/demo', asyncRoute(async (req, res) => {
    const name = 'guest' + crypto.randomBytes(2).toString('hex');
    const user = await store.createUser({ username: name, password: crypto.randomUUID(), bio: 'Гостевой аккаунт — данные живут на этом сервере' });
    joinHq(user.id);
    const token = store.createSession(user.id);
    const saved = 'saved:' + user.id;
    const bot = store.getUserByName('cbopka');
    store.addMessage({
      convoId: saved,
      fromId: bot?.id || user.id,
      text: 'Это «Избранное» — как в Telegram. Сюда можно кидать заметки, файлы и голосовые. Никто другой их не видит.'
    });
    res.json({ token, user: pub(user, true) });
  }));

  app.post('/api/login', asyncRoute(async (req, res) => {
    if (!hitRate('login:' + req.ip, 30, 60_000)) return res.status(429).json({ error: 'Слишком много попыток' });
    const { username, password, code } = req.body || {};
    const user = store.getUserByName(username || '');
    if (!user || !(await store.checkPassword(user, password))) return res.status(400).json({ error: 'Неверный ник или пароль' });
    if (user.totpEnabled) {
      if (!code) return res.json({ need2fa: true, ticket: store.issueTicket(user.id) });
      if (!verifyTotp(user.totpSecret, code)) return res.status(400).json({ error: 'Неверный код 2FA' });
    }
    const token = store.createSession(user.id);
    res.json({ token, user: pub(user, true) });
  }));

  app.post('/api/login/2fa', asyncRoute(async (req, res) => {
    const uid = store.takeTicket(req.body?.ticket);
    if (!uid) return res.status(400).json({ error: 'Сессия 2FA истекла' });
    const user = store.getUser(uid);
    if (!verifyTotp(user.totpSecret, req.body?.code)) return res.status(400).json({ error: 'Неверный код 2FA' });
    const token = store.createSession(uid);
    res.json({ token, user: pub(user, true) });
  }));

  app.post('/api/logout', auth, (req, res) => {
    store.destroySession(req.token);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user, true) }));

  app.patch('/api/me', auth, asyncRoute(async (req, res) => {
    const patch = req.body || {};
    if (patch.bio) patch.bio = String(patch.bio).slice(0, 180);
    if (patch.customStatus) patch.customStatus = String(patch.customStatus).slice(0, 80);
    const user = store.updateUser(req.user.id, patch);
    emitPresence(user);
    res.json({ user: pub(user, true) });
  }));

  app.post('/api/me/password', auth, asyncRoute(async (req, res) => {
    if (!(await store.checkPassword(req.user, req.body?.current))) return res.status(400).json({ error: 'Текущий пароль неверный' });
    if (!req.body?.next || String(req.body.next).length < 4) return res.status(400).json({ error: 'Новый пароль слишком короткий' });
    await store.setPassword(req.user.id, req.body.next);
    res.json({ ok: true });
  }));

  app.post('/api/2fa/setup', auth, (req, res) => {
    const secret = generateSecret();
    store.updateUser(req.user.id, { totpSecret: secret, totpEnabled: false });
    res.json({ secret, otpauth: otpauthUrl(secret, req.user.username) });
  });

  app.post('/api/2fa/enable', auth, (req, res) => {
    const u = store.getUser(req.user.id);
    if (!verifyTotp(u.totpSecret, req.body?.code)) return res.status(400).json({ error: 'Код не сошёлся' });
    store.updateUser(u.id, { totpEnabled: true });
    res.json({ user: pub(store.getUser(u.id), true) });
  });

  app.post('/api/2fa/disable', auth, asyncRoute(async (req, res) => {
    const u = store.getUser(req.user.id);
    if (!(await store.checkPassword(u, req.body?.password))) return res.status(400).json({ error: 'Пароль неверный' });
    if (u.totpEnabled && !verifyTotp(u.totpSecret, req.body?.code)) return res.status(400).json({ error: 'Код 2FA неверный' });
    store.updateUser(u.id, { totpEnabled: false, totpSecret: '' });
    res.json({ user: pub(store.getUser(u.id), true) });
  }));

  app.put('/api/keys', auth, (req, res) => {
    store.setKeys(req.user.id, { identityPub: req.body?.identityPub, signedPrekey: req.body?.signedPrekey || null });
    res.json({ ok: true });
  });

  app.get('/api/keys/:id', auth, (req, res) => {
    res.json({ keys: store.getKeys(req.params.id) });
  });

  app.get('/api/users/search', auth, (req, res) => {
    const users = store.searchUsers(req.query.q, req.user.id)
      .filter((u) => !store.isBlocked(req.user.id, u.id))
      .map((u) => pub(u));
    res.json({ users });
  });

  app.get('/api/users/:id', auth, (req, res) => {
    const u = store.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'not found' });
    const fresh = pub(u);
    if (u.privacy?.showLastSeen === 'friends' && !(store.state.friendships[u.id] || []).includes(req.user.id) && u.id !== req.user.id) {
      delete fresh.lastSeen;
    }
    fresh.online = userSockets.has(u.id);
    res.json({ user: fresh });
  });

  app.post('/api/users/:id/block', auth, (req, res) => {
    store.block(req.user.id, req.params.id);
    res.json({ ok: true, blocked: store.state.blocks[req.user.id] || [] });
  });

  app.delete('/api/users/:id/block', auth, (req, res) => {
    store.unblock(req.user.id, req.params.id);
    res.json({ ok: true, blocked: store.state.blocks[req.user.id] || [] });
  });

  app.get('/api/blocks', auth, (req, res) => {
    const ids = store.state.blocks[req.user.id] || [];
    res.json({ users: ids.map((id) => pub(store.getUser(id))).filter(Boolean) });
  });

  app.get('/api/friends', auth, (req, res) => {
    const { incoming, outgoing } = store.requestsOf(req.user.id);
    res.json({
      friends: store.friendsOf(req.user.id).map((u) => pub(u)),
      incoming: incoming.map((r) => ({ ...r, fromUser: pub(store.getUser(r.from)) })),
      outgoing: outgoing.map((r) => ({ ...r, toUser: pub(store.getUser(r.to)) }))
    });
  });

  app.post('/api/friends/request', auth, asyncRoute(async (req, res) => {
    const target = req.body.userId ? store.getUser(req.body.userId) : store.getUserByName(req.body.username || '');
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    const request = store.friendRequest(req.user.id, target.id);
    emitToUser(target.id, 'friend:request', { ...request, fromUser: pub(req.user) });
    res.json({ request });
  }));

  app.post('/api/friends/accept', auth, (req, res) => {
    const request = store.acceptRequest(req.body.requestId, req.user.id);
    emitToUser(request.from, 'friend:added', { friend: pub(req.user) });
    emitToUser(req.user.id, 'friend:added', { friend: pub(store.getUser(request.from)) });
    res.json({ request });
  });

  app.post('/api/friends/decline', auth, (req, res) => {
    res.json({ request: store.declineRequest(req.body.requestId, req.user.id) });
  });

  app.delete('/api/friends/:id', auth, (req, res) => {
    store.removeFriend(req.user.id, req.params.id);
    emitToUser(req.params.id, 'friend:removed', { userId: req.user.id });
    res.json({ ok: true });
  });

  app.get('/api/bootstrap', auth, (req, res) => {
    const uid = req.user.id;
    const groups = store.groupsOf(uid).map((g) => ({
      ...g,
      members: Object.entries(g.members).map(([id, role]) => ({ ...pub(store.getUser(id)), role })),
      channels: store.channelsOf(g.id)
    }));
    const { incoming, outgoing } = store.requestsOf(uid);
    const dmIds = Object.keys(store.state.messages).filter((c) => c.startsWith('dm:') && c.split(':').includes(uid));
    res.json({
      user: pub(req.user, true),
      friends: store.friendsOf(uid).map((u) => pub(u)),
      incoming: incoming.map((r) => ({ ...r, fromUser: pub(store.getUser(r.from)) })),
      outgoing: outgoing.map((r) => ({ ...r, toUser: pub(store.getUser(r.to)) })),
      groups,
      online: onlineSnapshot(),
      dms: dmIds,
      activity: store.state.activity.slice(0, 40).map((a) => ({ ...a, user: pub(store.getUser(a.userId)) })),
      blocked: store.state.blocks[uid] || [],
      voice: Object.fromEntries([...voiceRooms.keys()].map((id) => [id, voiceSnapshot(id)]))
    });
  });

  app.get('/api/groups', auth, (req, res) => {
    const groups = store.groupsOf(req.user.id).map((g) => ({
      ...g,
      members: Object.entries(g.members).map(([id, role]) => ({ ...pub(store.getUser(id)), role })),
      channels: store.channelsOf(g.id)
    }));
    res.json({ groups });
  });

  app.post('/api/groups', auth, (req, res) => {
    const g = store.createGroup({ name: req.body.name, description: req.body.description, ownerId: req.user.id, avatar: req.body.avatar });
    store.createChannel({ groupId: g.id, name: 'общий', type: 'text' });
    store.createChannel({ groupId: g.id, name: 'анонсы', type: 'announcement' });
    store.createChannel({ groupId: g.id, name: 'Голос', type: 'voice' });
    for (const fid of req.body.memberIds || []) {
      if (store.getUser(fid)) store.setMember(g.id, fid, 'member');
    }
    const full = { ...store.getGroup(g.id), channels: store.channelsOf(g.id) };
    for (const uid of Object.keys(full.members)) emitToUser(uid, 'group:update', full);
    res.json({ group: full });
  });

  app.patch('/api/groups/:id', auth, (req, res) => {
    const role = store.memberRole(req.params.id, req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Только админ' });
    const g = store.getGroup(req.params.id);
    if (req.body.name) g.name = String(req.body.name).slice(0, 40);
    if (req.body.description != null) g.description = String(req.body.description).slice(0, 200);
    if (req.body.avatar) g.avatar = req.body.avatar;
    store.touch();
    const full = { ...g, channels: store.channelsOf(g.id) };
    for (const uid of Object.keys(g.members)) emitToUser(uid, 'group:update', full);
    res.json({ group: full });
  });

  app.post('/api/groups/:id/members', auth, (req, res) => {
    const role = store.memberRole(req.params.id, req.user.id);
    if (role !== 'admin' && role !== 'mod') return res.status(403).json({ error: 'Нет прав' });
    const target = req.body.userId ? store.getUser(req.body.userId) : store.getUserByName(req.body.username || '');
    if (!target) return res.status(404).json({ error: 'Не найден' });
    store.setMember(req.params.id, target.id, 'member');
    const g = store.getGroup(req.params.id);
    const full = { ...g, channels: store.channelsOf(g.id) };
    for (const uid of Object.keys(g.members)) emitToUser(uid, 'group:update', full);
    res.json({ group: full });
  });

  app.patch('/api/groups/:id/members/:uid', auth, (req, res) => {
    if (store.memberRole(req.params.id, req.user.id) !== 'admin') return res.status(403).json({ error: 'Только админ' });
    const role = req.body.role;
    if (!['admin', 'mod', 'member'].includes(role)) return res.status(400).json({ error: 'Роль: admin, mod, member' });
    store.setMember(req.params.id, req.params.uid, role);
    const g = store.getGroup(req.params.id);
    res.json({ group: g });
  });

  app.delete('/api/groups/:id/members/:uid', auth, (req, res) => {
    const my = store.memberRole(req.params.id, req.user.id);
    const kicking = req.params.uid !== req.user.id;
    if (kicking && my !== 'admin' && my !== 'mod') return res.status(403).json({ error: 'Нет прав' });
    store.setMember(req.params.id, req.params.uid, null);
    const g = store.getGroup(req.params.id);
    if (g && Object.keys(g.members).length === 0) delete store.state.groups[g.id];
    emitToUser(req.params.uid, 'group:left', { groupId: req.params.id });
    res.json({ ok: true });
  });

  app.post('/api/groups/:id/channels', auth, (req, res) => {
    const role = store.memberRole(req.params.id, req.user.id);
    if (role !== 'admin' && role !== 'mod') return res.status(403).json({ error: 'Нет прав' });
    const ch = store.createChannel({ groupId: req.params.id, name: req.body.name, type: req.body.type });
    const g = store.getGroup(req.params.id);
    for (const uid of Object.keys(g.members)) emitToUser(uid, 'channel:new', ch);
    res.json({ channel: ch });
  });

  app.delete('/api/channels/:id', auth, (req, res) => {
    const ch = store.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Нет канала' });
    if (store.memberRole(ch.groupId, req.user.id) !== 'admin') return res.status(403).json({ error: 'Только админ' });
    store.deleteChannel(ch.id);
    res.json({ ok: true });
  });

  app.post('/api/groups/:id/invites', auth, (req, res) => {
    const role = store.memberRole(req.params.id, req.user.id);
    if (!role) return res.status(403).json({ error: 'Нет доступа' });
    if (role === 'member' && req.body.maxUses == null) {
      /* members can create limited invites */
    }
    const inv = store.createInvite({
      groupId: req.params.id,
      creatorId: req.user.id,
      maxUses: Number(req.body.maxUses || 0),
      expiresIn: Number(req.body.expiresIn || 0)
    });
    res.json({ invite: inv });
  });

  app.post('/api/invites/:code/join', auth, (req, res) => {
    const g = store.consumeInvite(req.params.code, req.user.id);
    const full = { ...g, channels: store.channelsOf(g.id) };
    emitToUser(req.user.id, 'group:update', full);
    res.json({ group: full });
  });

  app.get('/api/messages/:convoId', auth, (req, res) => {
    if (!canAccess(req.user.id, req.params.convoId)) return res.status(403).json({ error: 'forbidden' });
    const { messages, hasMore } = store.queryMessages(req.params.convoId, {
      before: Number(req.query.before || 0),
      limit: Math.min(100, Number(req.query.limit || 40)),
      q: req.query.q || ''
    });
    res.json({ messages, hasMore });
  });

  app.post('/api/messages', auth, (req, res) => {
    try {
      const msg = sendMessage(req.user.id, req.body || {});
      res.json({ message: msg });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get('/api/activity', auth, (req, res) => {
    res.json({
      activity: store.state.activity.slice(0, 50).map((a) => ({ ...a, user: pub(store.getUser(a.userId)) }))
    });
  });

  function saveUploadBuffer({ name, mime, buffer, uid }) {
    const user = store.getUser(uid);
    const limit = user?.nitro ? 100 * 1024 * 1024 : 25 * 1024 * 1024;
    if (buffer.length > limit) {
      const err = new Error(user?.nitro ? 'Файл больше 100 МБ' : 'Лимит 25 МБ. Nitro поднимает его до 100 МБ');
      err.status = 400;
      throw err;
    }
    const fid = crypto.randomUUID();
    const ext = path.extname(name || '') || '';
    const filename = fid + ext;
    fs.writeFileSync(path.join(uploadDir, filename), buffer);
    const meta = {
      id: fid,
      name: name || 'file',
      mime: mime || 'application/octet-stream',
      size: buffer.length,
      url: `/uploads/${filename}`,
      uploaderId: uid,
      at: Date.now()
    };
    store.saveFile(meta);
    return meta;
  }

  app.post('/api/upload', auth, (req, res, next) => {
    if (upload && (req.is('multipart/form-data') || String(req.headers['content-type'] || '').includes('multipart'))) {
      return upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
        const meta = {
          id: path.parse(req.file.filename).name,
          name: req.file.originalname,
          mime: req.file.mimetype,
          size: req.file.size,
          url: `/uploads/${req.file.filename}`,
          uploaderId: req.user.id,
          at: Date.now()
        };
        store.saveFile(meta);
        res.json({ file: meta });
      });
    }
    next();
  }, asyncRoute(async (req, res) => {
    const { name, mime, data } = req.body || {};
    if (!data) return res.status(400).json({ error: 'Нужен data (base64) — multer выключен или не multipart' });
    const buffer = Buffer.from(data, 'base64');
    const meta = saveUploadBuffer({ name, mime, buffer, uid: req.user.id });
    res.json({ file: meta });
  }));

  app.post('/api/nitro', auth, (req, res) => {
    const user = store.updateUser(req.user.id, { nitro: Boolean(req.body?.enabled) });
    res.json({ user: pub(user, true), note: 'Nitro здесь — локальный флаг: кастомные эмодзи, 4K, файлы 100 МБ. Оплаты нет.' });
  });

  app.post('/api/bots', auth, (req, res) => {
    const bot = store.createBot(req.user.id, req.body?.name);
    res.json({ bot });
  });

  app.post('/api/bots/message', (req, res) => {
    const token = (req.headers.authorization || '').replace('Bot ', '').replace('Bearer ', '');
    const bot = store.botByToken(token);
    if (!bot) return res.status(401).json({ error: 'bad bot token' });
    const { channelId, text } = req.body || {};
    if (!channelId || !text) return res.status(400).json({ error: 'channelId and text required' });
    const ch = store.getChannel(channelId);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    const g = store.getGroup(ch.groupId);
    if (!g.members[bot.ownerId]) return res.status(403).json({ error: 'owner is not a member' });
    const msg = store.addMessage({ convoId: channelId, fromId: bot.ownerId, text: `**${bot.name}:** ${text}`, type: 'text', meta: { bot: bot.name } });
    emitToConvo(channelId, 'message:new', msg);
    res.json({ message: msg });
  });

  app.get('/api/push/vapid', auth, (req, res) => {
    res.json({ publicKey: vapidPublic() });
  });

  app.post('/api/push/subscribe', auth, asyncRoute(async (req, res) => {
    if (!req.body?.endpoint) return res.status(400).json({ error: 'bad subscription' });
    store.addPush({ ...req.body, userId: req.user.id });
    res.json({ ok: true });
  }));

  let vapidKeys = null;
  function vapidPublic() {
    if (!webpush) return null;
    if (vapidKeys) return vapidKeys.publicKey;
    const p = path.join(dataDir, 'vapid.json');
    try {
      if (fs.existsSync(p)) vapidKeys = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
    if (!vapidKeys) {
      vapidKeys = webpush.generateVAPIDKeys();
      try { fs.writeFileSync(p, JSON.stringify(vapidKeys)); } catch {}
    }
    try {
      webpush.setVapidDetails('mailto:cbopka@localhost', vapidKeys.publicKey, vapidKeys.privateKey);
    } catch {}
    return vapidKeys.publicKey;
  }

  function notifyOffline(uid, payload) {
    if (!webpush || userSockets.has(uid)) return;
    const subs = (store.state.push || []).filter((s) => s.userId === uid);
    for (const sub of subs) {
      webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {});
    }
  }

  function emitPresence(user) {
    io.emit('presence', {
      userId: user.id,
      status: userSockets.has(user.id) ? (user.status || 'online') : 'offline',
      customStatus: user.customStatus || '',
      customEmoji: user.customEmoji || '',
      activity: user.activity || null,
      lastSeen: user.lastSeen
    });
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = store.sessionUser(token);
    if (!user) return next(new Error('unauthorized'));
    socket.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const uid = socket.userId;
    const user = store.getUser(uid);
    if (!user) return socket.disconnect();
    addSocket(uid, socket.id);
    user.lastSeen = Date.now();
    if (user.status === 'offline') user.status = 'online';
    socket.emit('ready', { userId: uid, online: onlineSnapshot() });
    emitPresence(user);

    socket.on('presence:set', (patch = {}) => {
      const next = store.updateUser(uid, {
        status: patch.status,
        customStatus: patch.customStatus,
        customEmoji: patch.customEmoji,
        activity: patch.activity
      });
      if (next) emitPresence(next);
    });

    socket.on('typing', ({ convoId, active }) => {
      if (!canAccess(uid, convoId)) return;
      emitToConvo(convoId, 'typing', { convoId, userId: uid, active: Boolean(active) }, uid);
    });

    socket.on('message:send', (payload = {}, ack) => {
      try {
        const msg = sendMessage(uid, payload);
        ack?.({ ok: true, message: msg });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
        socket.emit('error_msg', { error: e.message });
      }
    });

    socket.on('message:edit', ({ id: mid, text }) => {
      const m = store.editMessage(mid, uid, String(text || '').slice(0, 4000));
      if (m) emitToConvo(m.convoId, 'message:update', m);
    });

    socket.on('message:delete', ({ id: mid }) => {
      const existing = store.getMessage(mid);
      if (!existing) return;
      let force = false;
      const ch = store.getChannel(existing.convoId);
      if (ch) {
        const role = store.memberRole(ch.groupId, uid);
        if (role === 'admin' || role === 'mod') force = true;
      }
      const m = store.deleteMessage(mid, uid, force);
      if (m) emitToConvo(m.convoId, 'message:update', m);
    });

    socket.on('message:react', ({ id: mid, emoji }) => {
      const m = store.react(mid, uid, String(emoji || '').slice(0, 8));
      if (m) emitToConvo(m.convoId, 'message:update', m);
    });

    socket.on('message:pin', ({ id: mid, pinned }) => {
      const m = store.pin(mid, pinned);
      if (m) emitToConvo(m.convoId, 'message:update', m);
    });

    socket.on('poll:vote', ({ id: mid, optionId }) => {
      const m = store.votePoll(mid, uid, optionId);
      if (m) emitToConvo(m.convoId, 'message:update', m);
    });

    socket.on('call:invite', ({ toUserId, channelId, type = 'video', quality }) => {
      const callId = crypto.randomUUID();
      if (toUserId) {
        if (store.isBlocked(uid, toUserId)) return socket.emit('error_msg', { error: 'Пользователь недоступен' });
        const target = store.getUser(toUserId);
        const policy = target?.privacy?.calls || 'everyone';
        const friends = (store.state.friendships[toUserId] || []).includes(uid);
        if (policy === 'nobody' || (policy === 'friends' && !friends)) {
          return socket.emit('error_msg', { error: 'Пользователь не принимает звонки' });
        }
        if (!userSockets.has(toUserId)) return socket.emit('error_msg', { error: 'Собеседник не в сети' });
        const call = { id: callId, type, initiator: uid, toUserId, participants: new Set([uid]), quality: quality || '1080p60', startedAt: Date.now() };
        calls.set(callId, call);
        emitToUser(toUserId, 'call:incoming', { callId, from: pub(user), type, quality: call.quality });
        socket.emit('call:outgoing', { callId, toUserId, type });
        notifyOffline(toUserId, { title: 'Звонок Cbopka', body: user.username + ' звонит' });
      } else if (channelId) {
        const members = convoMembers(channelId).filter((id) => id !== uid && userSockets.has(id));
        const call = { id: callId, type, initiator: uid, channelId, participants: new Set([uid]), startedAt: Date.now() };
        calls.set(callId, call);
        for (const id of members) emitToUser(id, 'call:incoming', { callId, from: pub(user), type, channelId });
        socket.emit('call:outgoing', { callId, channelId, type });
      }
    });

    socket.on('call:accept', ({ callId }) => {
      const call = calls.get(callId);
      if (!call) return;
      call.participants.add(uid);
      for (const pid of call.participants) {
        emitToUser(pid, 'call:accepted', { callId, userId: uid, user: pub(user), participants: [...call.participants] });
      }
    });

    socket.on('call:reject', ({ callId }) => {
      const call = calls.get(callId);
      if (!call) return;
      emitToUser(call.initiator, 'call:rejected', { callId, userId: uid });
      if (!call.channelId) calls.delete(callId);
    });

    socket.on('call:leave', ({ callId }) => {
      const call = calls.get(callId);
      if (!call) return;
      call.participants.delete(uid);
      for (const pid of call.participants) emitToUser(pid, 'call:peer-left', { callId, userId: uid });
      socket.emit('call:ended', { callId });
      if (call.participants.size === 0) calls.delete(callId);
    });

    socket.on('call:state', (payload = {}) => {
      const call = calls.get(payload.callId);
      if (!call) return;
      for (const pid of call.participants) {
        if (pid === uid) continue;
        emitToUser(pid, 'call:state', { ...payload, userId: uid });
      }
    });

    socket.on('call:reaction', ({ callId, emoji }) => {
      const call = calls.get(callId);
      if (!call) return;
      for (const pid of call.participants) emitToUser(pid, 'call:reaction', { callId, userId: uid, emoji, at: Date.now() });
    });

    socket.on('draw:stroke', (payload = {}) => {
      const call = calls.get(payload.callId);
      const targets = call ? [...call.participants] : convoMembers(payload.channelId || '');
      for (const pid of targets) {
        if (pid === uid) continue;
        emitToUser(pid, 'draw:stroke', { ...payload, userId: uid });
      }
    });

    for (const ev of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice']) {
      socket.on(ev, (payload = {}) => {
        if (!payload.toUserId) return;
        emitToUser(payload.toUserId, ev, { ...payload, fromUserId: uid });
      });
    }

    socket.on('voice:join', ({ channelId }) => {
      const ch = store.getChannel(channelId);
      if (!ch || ch.type !== 'voice') return socket.emit('error_msg', { error: 'Это не голосовой канал' });
      if (!store.memberRole(ch.groupId, uid)) return;
      if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
      const room = voiceRooms.get(channelId);
      const existing = [...room.keys()];
      room.set(uid, { muted: false, video: false, sharing: false, hand: false, joinedAt: Date.now() });
      const peers = voiceSnapshot(channelId);
      io.emit('voice:state', { channelId, peers });
      socket.emit('voice:joined', { channelId, peers, existing });
      store.addActivity(uid, 'voice_join', { channelId, name: ch.name });
    });

    socket.on('voice:leave', ({ channelId }) => {
      voiceRooms.get(channelId)?.delete(uid);
      if (voiceRooms.get(channelId)?.size === 0) voiceRooms.delete(channelId);
      io.emit('voice:state', { channelId, peers: voiceSnapshot(channelId) });
      socket.emit('voice:left', { channelId });
    });

    socket.on('voice:state', ({ channelId, ...st }) => {
      const room = voiceRooms.get(channelId);
      if (!room?.has(uid)) return;
      room.set(uid, { ...room.get(uid), ...st, userId: uid });
      io.emit('voice:state', { channelId, peers: voiceSnapshot(channelId) });
    });

    socket.on('voice:signal', (payload = {}) => {
      if (!payload.toUserId) return;
      emitToUser(payload.toUserId, 'voice:signal', { ...payload, fromUserId: uid });
    });

    socket.on('sfu:join', async ({ roomId }, ack) => {
      if (!sfu.available) return ack?.({ ok: false, error: 'sfu unavailable' });
      try {
        const data = await sfu.join(roomId, uid);
        ack?.({ ok: true, ...data });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on('sfu:connect', async (payload = {}, ack) => {
      try {
        await sfu.connect(payload.roomId, uid, payload.transportId, payload.dtlsParameters);
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on('sfu:produce', async (payload = {}, ack) => {
      try {
        const produced = await sfu.produce(payload.roomId, uid, payload);
        for (const [other, sockets] of userSockets) {
          if (other === uid) continue;
          for (const sid of sockets) io.to(sid).emit('sfu:newProducer', { roomId: payload.roomId, userId: uid, ...produced });
        }
        ack?.({ ok: true, ...produced, existing: sfu.producersIn(payload.roomId, uid) });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on('sfu:consume', async (payload = {}, ack) => {
      try {
        const consumed = await sfu.consume(payload.roomId, uid, payload.producerId, payload.rtpCapabilities);
        ack?.({ ok: true, ...consumed });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on('disconnect', () => {
      const left = removeSocket(uid, socket.id);
      if (left === 0) {
        const u = store.getUser(uid);
        if (u) {
          u.status = 'offline';
          u.lastSeen = Date.now();
          store.touch();
          emitPresence(u);
        }
        for (const [channelId, room] of voiceRooms) {
          if (room.has(uid)) {
            room.delete(uid);
            io.emit('voice:state', { channelId, peers: voiceSnapshot(channelId) });
          }
        }
        for (const [callId, call] of calls) {
          if (call.participants.has(uid)) {
            call.participants.delete(uid);
            for (const pid of call.participants) emitToUser(pid, 'call:peer-left', { callId, userId: uid });
            if (call.participants.size === 0) calls.delete(callId);
          }
        }
        if (sfu.available) {
          try { sfu.leave('global', uid); } catch {}
        }
      }
    });
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/socket.io')) return next();
    const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
    if (clientDist) {
      const file = path.join(clientDist, rel);
      if (rel !== 'index.html' && fs.existsSync(file) && fs.statSync(file).isFile()) return res.sendFile(file);
      const index = path.join(clientDist, 'index.html');
      if (fs.existsSync(index)) return res.sendFile(index);
    }
    if (embedded && (embedded[rel] || embedded['index.html'])) {
      const body = embedded[rel] || embedded['index.html'];
      const ext = path.extname(rel || 'index.html');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm' };
      res.setHeader('Content-Type', types[ext] || 'text/plain');
      if (typeof body === 'string' && body.startsWith('base64:')) return res.end(Buffer.from(body.slice(7), 'base64'));
      return res.send(body);
    }
    res.status(200).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Cbopka</title></head><body style="margin:0;background:#0c0d11;color:#f6f1e8;font-family:sans-serif;display:grid;place-items:center;height:100vh"><div><h1>Cbopka 2.0</h1><p>Сервер запущен. Клиент ещё не собран — <code>npm run build</code> в client/.</p></div></body></html>`);
  });

  setInterval(() => store.sweepExpired(), 15_000).unref?.();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    if (process.env.CBOPKA_OPEN_BROWSER === '1') {
      const url = `http://127.0.0.1:${PORT}`;
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      import('child_process').then(({ exec }) => exec(cmd, () => {}));
    }
  });


}

const invoked = String(process.argv[1] || '').replace(/\\/g, '/');
const isDirect = /\/index\.js$|\/server-bundle\.cjs$/.test(invoked) || invoked.endsWith('index.js') || invoked.endsWith('server-bundle.cjs');
if (isDirect && process.env.CBOPKA_AUTOSTART !== '0') {
  start().catch((err) => { console.error(err); process.exit(1); });
}
export { start };
