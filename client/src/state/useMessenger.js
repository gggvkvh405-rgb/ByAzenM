import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, origin, uploadFile } from '../lib/api.js';
import { loadIdentity, encryptDm, decryptDm } from '../lib/crypto.js';
import { chime } from '../lib/sounds.js';
import { dmId } from '../lib/format.js';
import { waveformPeaks } from '../lib/media.js';

export function useMessenger() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cb_user') || 'null'); } catch { return null; }
  });
  const [token, setToken] = useState(() => localStorage.getItem('cb_token') || '');
  const [socket, setSocket] = useState(null);
  const [boot, setBoot] = useState(null);
  const [messages, setMessages] = useState({});
  const [hasMore, setHasMore] = useState({});
  const [typing, setTyping] = useState({});
  const [online, setOnline] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState({});
  const keys = useRef({});
  const decCache = useRef({});

  const toast = useCallback((text) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  function persist(u, t) {
    localStorage.setItem('cb_token', t);
    localStorage.setItem('cb_user', JSON.stringify(u));
    setUser(u); setToken(t);
  }

  async function login(username, password, code) {
    const data = await api('/api/login', { method: 'POST', body: { username, password, code } });
    if (data.need2fa) return data;
    persist(data.user, data.token);
    return data;
  }
  async function login2fa(ticket, code) {
    const data = await api('/api/login/2fa', { method: 'POST', body: { ticket, code } });
    persist(data.user, data.token);
  }
  async function register(username, password) {
    const ident = await loadIdentity();
    const data = await api('/api/register', { method: 'POST', body: { username, password, identityPub: ident.pubJwk } });
    await api('/api/keys', { token: data.token, method: 'PUT', body: { identityPub: ident.pubJwk, signedPrekey: ident.prekeyJwk } });
    persist(data.user, data.token);
  }
  async function demo() {
    const data = await api('/api/demo', { method: 'POST', body: {} });
    const ident = await loadIdentity();
    await api('/api/keys', { token: data.token, method: 'PUT', body: { identityPub: ident.pubJwk, signedPrekey: ident.prekeyJwk } }).catch(() => {});
    persist(data.user, data.token);
  }
  function logout() {
    api('/api/logout', { token, method: 'POST' }).catch(() => {});
    socket?.disconnect();
    localStorage.removeItem('cb_token');
    localStorage.removeItem('cb_user');
    setUser(null); setToken(''); setBoot(null); setSocket(null); setMessages({});
  }

  useEffect(() => {
    if (!token || !user) return;
    let dead = false;
    (async () => {
      try {
        const ident = await loadIdentity();
        await api('/api/keys', { token, method: 'PUT', body: { identityPub: ident.pubJwk, signedPrekey: ident.prekeyJwk } });
      } catch {}
      try {
        const data = await api('/api/bootstrap', { token });
        if (dead) return;
        setBoot(data);
        setOnline(data.online || {});
        const map = {};
        for (const f of data.friends || []) map[f.id] = f;
        for (const g of data.groups || []) for (const m of g.members || []) if (m?.id) map[m.id] = m;
        map[data.user.id] = data.user;
        setUsers(map);
        const hq = (data.groups || []).find((g) => g.system) || (data.groups || [])[0];
        const first = hq?.channels?.find((c) => c.type === 'text') || hq?.channels?.[0];
        if (first) setActiveId((cur) => cur || first.id);
        const params = new URLSearchParams(location.search);
        const inv = params.get('invite');
        if (inv) {
          try {
            const joined = await api('/api/invites/' + inv + '/join', { token, method: 'POST', body: {} });
            setBoot((b) => ({ ...b, groups: [...(b.groups || []).filter((g) => g.id !== joined.group.id), joined.group] }));
            toast('Вы в группе');
          } catch (e) { toast(e.message); }
        }
      } catch (e) {
        if (String(e.message).includes('unauthorized') || String(e.message).includes('401')) logout();
        else toast(e.message);
      }
    })();
    const s = io(origin() || undefined, { auth: { token }, transports: ['websocket', 'polling'] });
    setSocket(s);
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });
    s.on('presence', (p) => setOnline((o) => ({ ...o, [p.userId]: p })));
    s.on('message:new', (m) => {
      setMessages((prev) => {
        const list = prev[m.convoId] || [];
        if (list.some((x) => x.id === m.id)) return prev;
        const pending = list.find((x) => x.pending && x.fromId === m.fromId && Math.abs((x.at || 0) - m.at) < 8000);
        const cleaned = list.filter((x) => x !== pending);
        const next = pending?.meta?.plain ? { ...m, meta: { ...m.meta, plain: pending.meta.plain } } : m;
        if (next.meta?.plain) rememberPlain(next.id, next.meta.plain);
        return { ...prev, [m.convoId]: [...cleaned, next] };
      });
      if (m.fromId !== user.id) {
        chime('message');
        if (document.hidden && Notification.permission === 'granted') {
          try { new Notification('Cbopka', { body: m.e2e ? 'Зашифрованное сообщение' : (m.text || 'Вложение').slice(0, 120) }); } catch {}
        }
      }
    });
    s.on('message:update', (m) => {
      setMessages((prev) => ({
        ...prev,
        [m.convoId]: (prev[m.convoId] || []).map((x) => x.id === m.id ? { ...m, meta: { ...m.meta, plain: x.meta?.plain || m.meta?.plain } } : x)
      }));
    });
    s.on('typing', ({ convoId, userId, active }) => {
      setTyping((t) => ({ ...t, [convoId]: { ...(t[convoId] || {}), [userId]: active ? Date.now() : 0 } }));
    });
    s.on('friend:request', () => refreshFriends());
    s.on('friend:added', () => refreshFriends());
    s.on('group:update', (g) => {
      setBoot((b) => b ? { ...b, groups: [...(b.groups || []).filter((x) => x.id !== g.id), { ...g, channels: g.channels || b.groups?.find((x) => x.id === g.id)?.channels || [] }] } : b);
    });
    s.on('channel:new', (ch) => {
      setBoot((b) => b ? { ...b, groups: (b.groups || []).map((g) => g.id === ch.groupId ? { ...g, channels: [...(g.channels || []), ch] } : g) } : b);
    });
    s.on('error_msg', (e) => toast(e.error || 'Ошибка'));
    const onHotkey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        window.dispatchEvent(new CustomEvent('cb-hotkey', { detail: 'mute' }));
      }
    };
    window.addEventListener('keydown', onHotkey);
    window.cbopkaAPI?.onHotkey?.((name) => window.dispatchEvent(new CustomEvent('cb-hotkey', { detail: name })));
    return () => { dead = true; s.disconnect(); window.removeEventListener('keydown', onHotkey); };
  }, [token]);

  async function refreshFriends() {
    if (!token) return;
    const data = await api('/api/friends', { token });
    setBoot((b) => b ? { ...b, ...data } : b);
  }

  const loadMessages = useCallback(async (convoId, before = 0) => {
    if (!token || !convoId) return;
    const data = await api(`/api/messages/${encodeURIComponent(convoId)}?limit=40${before ? `&before=${before}` : ''}`, { token });
    setHasMore((h) => ({ ...h, [convoId]: data.hasMore }));
    setMessages((prev) => {
      const cur = prev[convoId] || [];
      const merged = before ? [...data.messages, ...cur] : data.messages;
      const seen = new Set();
      return { ...prev, [convoId]: merged.filter((m) => (seen.has(m.id) ? false : seen.add(m.id))) };
    });
  }, [token]);

  useEffect(() => { if (activeId) loadMessages(activeId); }, [activeId, loadMessages]);

  async function peerKeys(peerId) {
    if (keys.current[peerId]) return keys.current[peerId];
    const data = await api('/api/keys/' + peerId, { token });
    keys.current[peerId] = data.keys;
    return data.keys;
  }

  async function send({ convoId, text, type = 'text', meta = null, replyTo = null, ttl = 0, e2e = false }) {
    const id = convoId || activeId;
    if (!id) return;
    let payload = { convoId: id, text, type, meta, replyTo, ttl };
    if (e2e && id.startsWith('dm:')) {
      const peerId = id.slice(3).split(':').find((x) => x !== user.id);
      const bundle = await peerKeys(peerId);
      if (!bundle?.identityPub) {
        toast('У собеседника ещё нет ключа — отправил открыто');
      } else {
        const boxed = await encryptDm(peerId, bundle, text);
        payload = { convoId: id, text: '', type: 'text', meta: { cipher: boxed }, e2e: true, replyTo, ttl };
      }
    }
    const optimistic = { id: 'tmp-' + Math.random().toString(36).slice(2), fromId: user.id, at: Date.now(), ...payload, text: payload.e2e ? text : payload.text, pending: true, meta: payload.e2e ? { ...payload.meta, plain: text } : payload.meta };
    setMessages((prev) => ({ ...prev, [id]: [...(prev[id] || []), optimistic] }));
    socket?.emit('message:send', payload, (ack) => {
      if (!ack?.ok) {
        toast(ack?.error || 'Не отправилось');
        setMessages((prev) => ({ ...prev, [id]: (prev[id] || []).filter((m) => m.id !== optimistic.id) }));
      } else {
        if (payload.e2e) rememberPlain(ack.message.id, text);
        setMessages((prev) => ({ ...prev, [id]: (prev[id] || []).map((m) => m.id === optimistic.id ? { ...ack.message, meta: payload.e2e ? { ...ack.message.meta, plain: text } : ack.message.meta } : m) }));
      }
    });
  }

  function rememberPlain(id, text) {
    if (!id || !text) return;
    try {
      const bag = JSON.parse(localStorage.getItem('cb_plain') || '{}');
      bag[id] = text;
      const keys = Object.keys(bag);
      if (keys.length > 400) delete bag[keys[0]];
      localStorage.setItem('cb_plain', JSON.stringify(bag));
    } catch {}
  }

  function savedPlain(id) {
    try { return JSON.parse(localStorage.getItem('cb_plain') || '{}')[id] || ''; } catch { return ''; }
  }

  async function plainOf(m) {
    if (!m?.e2e) return m?.deleted ? '' : (m?.text || '');
    if (m.meta?.plain) return m.meta.plain;
    const cached = savedPlain(m.id);
    if (cached) return cached;
    if (decCache.current[m.id]) return decCache.current[m.id];
    try {
      const text = await decryptDm(m.fromId, m.meta?.cipher, { own: m.fromId === user.id });
      decCache.current[m.id] = text;
      rememberPlain(m.id, text);
      return text;
    } catch {
      if (m.fromId === user.id) return 'Вы отправили это сообщение. Собеседник его видит, а копия на этом устройстве не сохранилась.';
      return 'Не удалось прочитать. Попросите отправить ещё раз.';
    }
  }

  function edit(id, text) { socket?.emit('message:edit', { id, text }); }
  function remove(id) { socket?.emit('message:delete', { id }); }
  function react(id, emoji) { socket?.emit('message:react', { id, emoji }); }
  function pin(id, pinned) { socket?.emit('message:pin', { id, pinned }); }
  function vote(id, optionId) { socket?.emit('poll:vote', { id, optionId }); }

  async function uploadAndSend(file, convoId) {
    const meta = await uploadFile(token, file);
    const isImg = (file.type || '').startsWith('image/');
    const isVid = (file.type || '').startsWith('video/');
    const isAudio = (file.type || '').startsWith('audio/');
    await send({
      convoId,
      type: isAudio ? 'voice' : 'file',
      text: file.name,
      meta: { ...meta, kind: isImg ? 'image' : isVid ? 'video' : isAudio ? 'audio' : 'file' }
    });
  }

  async function sendVoice(blob, peaks) {
    const ext = (blob.type || '').includes('wav') ? 'wav' : 'webm';
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type || 'audio/webm' });
    const meta = await uploadFile(token, file);
    const bars = peaks || await waveformPeaks(blob);
    await send({ type: 'voice', text: 'Голосовое', meta: { ...meta, kind: 'audio', peaks: bars } });
  }

  function setPresence(patch) {
    socket?.emit('presence:set', patch);
    setUser((u) => ({ ...u, ...patch }));
  }

  async function updateMe(patch) {
    const data = await api('/api/me', { token, method: 'PATCH', body: patch });
    persist(data.user, token);
    return data.user;
  }

  const groups = boot?.groups || [];
  const friends = boot?.friends || [];
  const active = useMemo(() => {
    if (!activeId || !user) return null;
    if (activeId.startsWith('saved:')) return { id: activeId, kind: 'saved', title: 'Избранное', subtitle: 'только вы' };
    if (activeId.startsWith('dm:')) {
      const peerId = activeId.slice(3).split(':').find((x) => x !== user.id);
      const peer = users[peerId] || friends.find((f) => f.id === peerId);
      return { id: activeId, kind: 'dm', title: peer?.username || 'Диалог', subtitle: '', peer, peerId };
    }
    if (activeId.startsWith('thread:')) return { id: activeId, kind: 'thread', title: 'Тред', subtitle: 'ответы' };
    for (const g of groups) {
      const ch = (g.channels || []).find((c) => c.id === activeId);
      if (ch) return { id: activeId, kind: 'channel', title: ch.name, subtitle: g.name, channel: ch, group: g };
    }
    return { id: activeId, kind: 'dm', title: 'Чат' };
  }, [activeId, groups, friends, users, user]);

  return {
    user, token, socket, boot, setBoot, messages, hasMore, typing, online, active, activeId, setActiveId,
    toasts, toast, connected, users, login, login2fa, register, demo, logout, loadMessages, send, plainOf,
    edit, remove, react, pin, vote, uploadAndSend, sendVoice, setPresence, updateMe, refreshFriends, friends, groups
  };
}
