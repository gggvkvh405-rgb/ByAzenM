import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export function avatarData(name = '?') {
  const letter = [...name][0]?.toUpperCase() || '?';
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="28" fill="hsl(${hue} 48% 42%)"/><text x="64" y="82" text-anchor="middle" font-size="64" font-family="sans-serif" fill="white">${letter.replace(/[<>&]/g, '')}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function id() {
  return crypto.randomUUID();
}

function blank() {
  return {
    users: {},
    sessions: {},
    friendships: {},
    requests: [],
    blocks: {},
    groups: {},
    channels: {},
    messages: {},
    invites: {},
    keys: {},
    files: {},
    activity: [],
    bots: {},
    push: [],
    tickets: {}
  };
}

export function createStore(opts = {}) {
  const persist = opts.persist !== false;
  let fallbackDir = process.cwd();
  try {
    if (import.meta && import.meta.url) fallbackDir = path.dirname(new URL(import.meta.url).pathname);
  } catch {}
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(fallbackDir, 'data');
  const jsonPath = path.join(dataDir, 'state.json');
  const state = blank();
  let db = opts.db || null;
  let timer = null;

  function hydrate(raw) {
    if (!raw || typeof raw !== 'object') return;
    for (const k of Object.keys(blank())) {
      if (raw[k] != null) state[k] = raw[k];
    }
  }

  if (persist && !opts.skipLoad) {
    try {
      if (db) {
        const row = db.prepare('SELECT json FROM app_state WHERE id=1').get();
        if (row?.json) hydrate(JSON.parse(row.json));
      } else if (fs.existsSync(jsonPath)) {
        hydrate(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
      }
    } catch (e) {
      console.log('state hydrate skipped:', e.message);
    }
  }

  function saveNow() {
    if (!persist) return;
    try {
      const json = JSON.stringify(state);
      if (db) {
        db.prepare('INSERT INTO app_state (id, json, updatedAt) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt').run(json, Date.now());
      } else {
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = jsonPath + '.tmp';
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, jsonPath);
      }
    } catch (e) {
      console.log('state save failed:', e.message);
    }
  }

  function touch() {
    if (!persist) return;
    clearTimeout(timer);
    timer = setTimeout(saveNow, 250);
  }

  function publicUser(u, self = false) {
    if (!u) return null;
    const { passwordHash, totpSecret, ...rest } = u;
    if (!self) {
      const hide = u.privacy?.showLastSeen === 'nobody' || (u.privacy?.showLastSeen === 'friends');
      if (hide && u.privacy?.showLastSeen === 'nobody') delete rest.lastSeen;
    }
    return rest;
  }

  function getUser(uid) { return state.users[uid] || null; }
  function getUserByName(name) {
    const lower = String(name || '').trim().toLowerCase();
    return Object.values(state.users).find((u) => u.usernameLower === lower) || null;
  }

  async function createUser({ username, password, bio, avatar, system = false }) {
    const clean = String(username || '').trim();
    if (clean.length < 3 || clean.length > 20) throw new Error('Ник: 3–20 символов');
    if (!/^[\p{L}\p{N}_]+$/u.test(clean)) throw new Error('Ник: буквы, цифры и _');
    const lower = clean.toLowerCase();
    if (getUserByName(clean)) throw new Error('Этот ник уже занят');
    const user = {
      id: id(),
      username: clean,
      usernameLower: lower,
      passwordHash: system ? '!' : await bcrypt.hash(password || id(), 8),
      avatar: avatar || avatarData(clean),
      bio: bio || 'Привет, я в Cbopka',
      status: 'online',
      customStatus: '',
      customEmoji: '',
      activity: null,
      lastSeen: Date.now(),
      createdAt: Date.now(),
      theme: 'dark',
      accent: '',
      nitro: false,
      totpSecret: '',
      totpEnabled: false,
      system,
      customEmojis: [],
      privacy: { dm: 'everyone', calls: 'everyone', showLastSeen: 'everyone' }
    };
    state.users[user.id] = user;
    state.friendships[user.id] = state.friendships[user.id] || [];
    state.blocks[user.id] = state.blocks[user.id] || [];
    touch();
    return user;
  }

  function updateUser(uid, patch) {
    const u = getUser(uid);
    if (!u) return null;
    const allow = ['avatar', 'bio', 'status', 'customStatus', 'customEmoji', 'activity', 'theme', 'accent', 'nitro', 'privacy', 'customEmojis', 'totpSecret', 'totpEnabled', 'lastSeen'];
    for (const k of allow) if (patch[k] !== undefined) u[k] = patch[k];
    if (patch.username) {
      const clean = String(patch.username).trim();
      if (clean.length >= 3 && clean.length <= 20 && getUserByName(clean)?.id !== uid && /^[\p{L}\p{N}_]+$/u.test(clean)) {
        u.username = clean;
        u.usernameLower = clean.toLowerCase();
      }
    }
    touch();
    return u;
  }

  async function checkPassword(user, password) {
    if (!user || user.passwordHash === '!') return false;
    return bcrypt.compare(password || '', user.passwordHash);
  }

  async function setPassword(uid, password) {
    const u = getUser(uid);
    if (!u) return;
    u.passwordHash = await bcrypt.hash(password, 8);
    touch();
  }

  function createSession(userId) {
    const token = id();
    state.sessions[token] = { userId, createdAt: Date.now() };
    const u = getUser(userId);
    if (u) { u.status = u.status === 'offline' ? 'online' : (u.status || 'online'); u.lastSeen = Date.now(); }
    touch();
    return token;
  }

  function sessionUser(token) {
    const s = state.sessions[token];
    if (!s) return null;
    return getUser(s.userId);
  }

  function destroySession(token) {
    delete state.sessions[token];
    touch();
  }

  function searchUsers(q, exceptId) {
    const query = String(q || '').trim().toLowerCase();
    return Object.values(state.users)
      .filter((u) => !u.system && u.id !== exceptId && (!query || u.usernameLower.includes(query) || (u.bio || '').toLowerCase().includes(query)))
      .slice(0, 20);
  }

  function isBlocked(a, b) {
    return (state.blocks[a] || []).includes(b) || (state.blocks[b] || []).includes(a);
  }

  function block(uid, other) {
    state.blocks[uid] = state.blocks[uid] || [];
    if (!state.blocks[uid].includes(other)) state.blocks[uid].push(other);
    removeFriend(uid, other);
    touch();
  }

  function unblock(uid, other) {
    state.blocks[uid] = (state.blocks[uid] || []).filter((id) => id !== other);
    touch();
  }

  function friendRequest(from, to) {
    if (from === to) throw new Error('Нельзя добавить себя');
    if (isBlocked(from, to)) throw new Error('Пользователь недоступен');
    if ((state.friendships[from] || []).includes(to)) throw new Error('Уже в друзьях');
    const existing = state.requests.find((r) => r.from === from && r.to === to && r.status === 'pending');
    if (existing) return existing;
    const reverse = state.requests.find((r) => r.from === to && r.to === from && r.status === 'pending');
    if (reverse) return acceptRequest(reverse.id, from);
    const req = { id: id(), from, to, status: 'pending', at: Date.now() };
    state.requests.push(req);
    addActivity(from, 'friend_request', { to });
    touch();
    return req;
  }

  function acceptRequest(requestId, uid) {
    const r = state.requests.find((x) => x.id === requestId && x.to === uid && x.status === 'pending');
    if (!r) throw new Error('Заявка не найдена');
    r.status = 'accepted';
    state.friendships[r.from] = state.friendships[r.from] || [];
    state.friendships[r.to] = state.friendships[r.to] || [];
    if (!state.friendships[r.from].includes(r.to)) state.friendships[r.from].push(r.to);
    if (!state.friendships[r.to].includes(r.from)) state.friendships[r.to].push(r.from);
    addActivity(uid, 'friend_added', { with: r.from });
    touch();
    return r;
  }

  function declineRequest(requestId, uid) {
    const r = state.requests.find((x) => x.id === requestId && x.to === uid && x.status === 'pending');
    if (!r) throw new Error('Заявка не найдена');
    r.status = 'declined';
    touch();
    return r;
  }

  function removeFriend(uid, other) {
    state.friendships[uid] = (state.friendships[uid] || []).filter((id) => id !== other);
    state.friendships[other] = (state.friendships[other] || []).filter((id) => id !== uid);
    touch();
  }

  function friendsOf(uid) {
    return (state.friendships[uid] || []).map(getUser).filter(Boolean);
  }

  function requestsOf(uid) {
    const incoming = state.requests.filter((r) => r.to === uid && r.status === 'pending');
    const outgoing = state.requests.filter((r) => r.from === uid && r.status === 'pending');
    return { incoming, outgoing };
  }

  function createGroup({ name, description, ownerId, avatar, system = false }) {
    const g = {
      id: id(),
      name: String(name || 'Группа').trim().slice(0, 40),
      description: String(description || '').slice(0, 200),
      avatar: avatar || avatarData(name || 'G'),
      ownerId,
      createdAt: Date.now(),
      system,
      members: { [ownerId]: 'admin' }
    };
    state.groups[g.id] = g;
    addActivity(ownerId, 'group_created', { groupId: g.id, name: g.name });
    touch();
    return g;
  }

  function getGroup(gid) { return state.groups[gid] || null; }

  function groupsOf(uid) {
    return Object.values(state.groups).filter((g) => g.members[uid]);
  }

  function setMember(gid, uid, role) {
    const g = getGroup(gid);
    if (!g) return null;
    if (role) g.members[uid] = role;
    else delete g.members[uid];
    touch();
    return g;
  }

  function memberRole(gid, uid) {
    return getGroup(gid)?.members[uid] || null;
  }

  function createChannel({ groupId, name, type = 'text' }) {
    const list = channelsOf(groupId);
    const ch = {
      id: id(),
      groupId,
      name: String(name || 'канал').trim().slice(0, 32).replace(/^#/, ''),
      type: ['text', 'voice', 'announcement'].includes(type) ? type : 'text',
      position: list.length,
      createdAt: Date.now()
    };
    state.channels[ch.id] = ch;
    touch();
    return ch;
  }

  function getChannel(cid) { return state.channels[cid] || null; }

  function channelsOf(groupId) {
    return Object.values(state.channels).filter((c) => c.groupId === groupId).sort((a, b) => a.position - b.position);
  }

  function deleteChannel(cid) {
    delete state.channels[cid];
    delete state.messages[cid];
    touch();
  }

  function createInvite({ groupId, creatorId, maxUses = 0, expiresIn = 0 }) {
    const code = crypto.randomBytes(4).toString('hex');
    const inv = {
      code,
      groupId,
      creatorId,
      maxUses: Number(maxUses) || 0,
      uses: 0,
      expiresAt: expiresIn ? Date.now() + Number(expiresIn) : 0,
      createdAt: Date.now()
    };
    state.invites[code] = inv;
    touch();
    return inv;
  }

  function getInvite(code) { return state.invites[code] || null; }

  function consumeInvite(code, uid) {
    const inv = getInvite(code);
    if (!inv) throw new Error('Ссылка недействительна');
    if (inv.expiresAt && inv.expiresAt < Date.now()) throw new Error('Ссылка истекла');
    const g = getGroup(inv.groupId);
    if (!g) throw new Error('Группа не найдена');
    if (g.members[uid]) return g;
    if (inv.maxUses && inv.uses >= inv.maxUses) throw new Error('Лимит приглашений исчерпан');
    if (!g.members[uid]) {
      g.members[uid] = 'member';
      inv.uses += 1;
      addActivity(uid, 'joined_group', { groupId: g.id });
    }
    touch();
    return g;
  }

  function addMessage(msg) {
    const m = {
      id: id(),
      convoId: msg.convoId,
      fromId: msg.fromId,
      text: msg.text ?? '',
      at: Date.now(),
      type: msg.type || 'text',
      meta: msg.meta || null,
      edited: false,
      editedAt: 0,
      deleted: false,
      replyTo: msg.replyTo || null,
      parentId: msg.parentId || null,
      reactions: {},
      pinned: false,
      expiresAt: msg.ttl ? Date.now() + Number(msg.ttl) : 0,
      e2e: Boolean(msg.e2e)
    };
    if (!state.messages[m.convoId]) state.messages[m.convoId] = [];
    state.messages[m.convoId].push(m);
    if (state.messages[m.convoId].length > 5000) state.messages[m.convoId].splice(0, state.messages[m.convoId].length - 5000);
    touch();
    return m;
  }

  function getMessage(mid) {
    for (const list of Object.values(state.messages)) {
      const found = list.find((m) => m.id === mid);
      if (found) return found;
    }
    return null;
  }

  function queryMessages(convoId, { before = 0, limit = 40, q = '' } = {}) {
    let list = (state.messages[convoId] || []).filter((m) => !m.expiresAt || m.expiresAt > Date.now());
    if (q) {
      const query = q.toLowerCase();
      list = list.filter((m) => (m.text || '').toLowerCase().includes(query) || (m.meta?.name || '').toLowerCase().includes(query));
    }
    if (before) list = list.filter((m) => m.at < before);
    const hasMore = list.length > limit;
    const slice = list.slice(-limit);
    return { messages: slice, hasMore };
  }

  function editMessage(mid, uid, text) {
    const m = getMessage(mid);
    if (!m || m.fromId !== uid || m.deleted) return null;
    m.text = text;
    m.edited = true;
    m.editedAt = Date.now();
    touch();
    return m;
  }

  function deleteMessage(mid, uid, force = false) {
    const m = getMessage(mid);
    if (!m) return null;
    if (!force && m.fromId !== uid) return null;
    m.deleted = true;
    m.text = '';
    m.meta = null;
    touch();
    return m;
  }

  function react(mid, uid, emoji) {
    const m = getMessage(mid);
    if (!m || m.deleted) return null;
    m.reactions = m.reactions || {};
    const arr = new Set(m.reactions[emoji] || []);
    if (arr.has(uid)) arr.delete(uid); else arr.add(uid);
    m.reactions[emoji] = [...arr];
    if (m.reactions[emoji].length === 0) delete m.reactions[emoji];
    touch();
    return m;
  }

  function pin(mid, pinned) {
    const m = getMessage(mid);
    if (!m) return null;
    m.pinned = pinned != null ? Boolean(pinned) : !m.pinned;
    touch();
    return m;
  }

  function votePoll(mid, uid, optionId) {
    const m = getMessage(mid);
    if (!m || m.type !== 'poll' || !m.meta?.options) return null;
    for (const opt of m.meta.options) {
      opt.votes = (opt.votes || []).filter((v) => v !== uid);
    }
    const opt = m.meta.options.find((o) => o.id === optionId);
    if (opt) opt.votes.push(uid);
    touch();
    return m;
  }

  function sweepExpired() {
    const now = Date.now();
    let n = 0;
    for (const list of Object.values(state.messages)) {
      for (const m of list) {
        if (m.expiresAt && m.expiresAt <= now && !m.deleted) {
          m.deleted = true;
          m.text = '';
          m.meta = null;
          n++;
        }
      }
    }
    if (n) touch();
    return n;
  }

  function addActivity(userId, type, meta) {
    state.activity.unshift({ id: id(), userId, type, meta, at: Date.now() });
    if (state.activity.length > 200) state.activity.length = 200;
    touch();
  }

  function saveFile(meta) {
    state.files[meta.id] = meta;
    touch();
    return meta;
  }

  function setKeys(uid, bundle) {
    state.keys[uid] = { ...bundle, at: Date.now() };
    touch();
  }

  function getKeys(uid) { return state.keys[uid] || null; }

  function createBot(ownerId, name) {
    const token = 'bot_' + crypto.randomBytes(18).toString('hex');
    state.bots[token] = { token, ownerId, name: name || 'Bot', createdAt: Date.now() };
    touch();
    return state.bots[token];
  }

  function botByToken(token) { return state.bots[token] || null; }

  function addPush(sub) {
    state.push = state.push.filter((p) => p.endpoint !== sub.endpoint);
    state.push.push({ ...sub, at: Date.now() });
    touch();
  }

  function issueTicket(userId) {
    const ticket = id();
    state.tickets[ticket] = { userId, exp: Date.now() + 5 * 60 * 1000 };
    return ticket;
  }

  function takeTicket(ticket) {
    const t = state.tickets[ticket];
    delete state.tickets[ticket];
    if (!t || t.exp < Date.now()) return null;
    return t.userId;
  }

  return {
    state,
    dataDir,
    saveNow,
    touch,
    publicUser,
    getUser,
    getUserByName,
    createUser,
    updateUser,
    checkPassword,
    setPassword,
    createSession,
    sessionUser,
    destroySession,
    searchUsers,
    isBlocked,
    block,
    unblock,
    friendRequest,
    acceptRequest,
    declineRequest,
    removeFriend,
    friendsOf,
    requestsOf,
    createGroup,
    getGroup,
    groupsOf,
    setMember,
    memberRole,
    createChannel,
    getChannel,
    channelsOf,
    deleteChannel,
    createInvite,
    getInvite,
    consumeInvite,
    addMessage,
    getMessage,
    queryMessages,
    editMessage,
    deleteMessage,
    react,
    pin,
    votePoll,
    sweepExpired,
    addActivity,
    saveFile,
    setKeys,
    getKeys,
    createBot,
    botByToken,
    addPush,
    issueTicket,
    takeTicket,
    avatarData
  };
}

export function openSqlite(Database, dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      usernameLower TEXT UNIQUE,
      passwordHash TEXT,
      avatar TEXT,
      bio TEXT,
      status TEXT DEFAULT 'online',
      customStatus TEXT DEFAULT '',
      lastSeen INTEGER,
      createdAt INTEGER,
      theme TEXT DEFAULT 'dark'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId TEXT,
      createdAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS friendships (
      userId TEXT,
      friendId TEXT,
      PRIMARY KEY (userId, friendId)
    );
    CREATE TABLE IF NOT EXISTS friendRequests (
      id TEXT PRIMARY KEY,
      fromId TEXT,
      toId TEXT,
      status TEXT,
      at INTEGER
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT,
      avatar TEXT,
      description TEXT,
      inviteCode TEXT,
      createdAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS groupMembers (
      groupId TEXT,
      userId TEXT,
      role TEXT DEFAULT 'member',
      PRIMARY KEY (groupId, userId)
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      groupId TEXT,
      name TEXT,
      type TEXT,
      position INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      convoId TEXT,
      fromId TEXT,
      text TEXT,
      at INTEGER,
      type TEXT DEFAULT 'text',
      meta TEXT,
      edited INTEGER DEFAULT 0,
      replyTo TEXT,
      reactions TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      originalName TEXT,
      mimeType TEXT,
      size INTEGER,
      path TEXT,
      uploaderId TEXT,
      at INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      json TEXT,
      updatedAt INTEGER
    );
  `);
  return db;
}
