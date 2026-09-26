import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import QRCode from 'qrcode';
import Icon from './icons.jsx';
import CallStage from './CallStage.jsx';
import { api, fileUrl, searchGifs, uploadFile } from '../lib/api.js';
import { renderMarkdown, COMMANDS } from '../lib/markdown.js';
import { dayLabel, timeShort, lastSeen, dmId, bytes, statusColor } from '../lib/format.js';
import { soundsOn, setSounds } from '../lib/sounds.js';
import { sha256 } from '../lib/crypto.js';
import { QUALITY, waveformPeaks } from '../lib/media.js';

const EMOJI = ['😀','😁','😂','🤣','😊','😍','😘','😎','🤔','😅','😭','😡','👍','👎','👏','🔥','❤️','🧡','💛','💚','💙','💜','🖤','✨','🎉','✅','❌','👀','🤝','🙏','💯','⚡','🌙','☀️','🍀','🎵','📎','💬','🫡','🫠'];
const STICKERS = ['🦊','🐙','🪐','🍋','🎧','🛹','🍵','🌵','🫧','🪩','🧸','🪁','🧿','🍄','🍒','🌊'];

function TextBody({ m, plainOf }) {
  const [text, setText] = useState(m.deleted ? '' : (m.meta?.plain || m.text || ''));
  useEffect(() => {
    let dead = false;
    if (m.deleted) { setText(''); return; }
    plainOf(m).then((t) => { if (!dead) setText(t); });
    return () => { dead = true; };
  }, [m.id, m.text, m.editedAt, m.e2e, m.deleted]);
  if (m.deleted) return <span style={{ color: 'var(--faint)', fontStyle: 'italic' }}>Сообщение удалено</span>;
  return <span dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

export default function Messenger({ m, call }) {
  const { user, token, boot, friends, groups, online, messages, active, activeId, setActiveId, typing, toasts, toast, send, connected } = m;
  const [tab, setTab] = useState('home');
  const [groupId, setGroupId] = useState(null);
  const [preferHome, setPreferHome] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(true);
  const [modal, setModal] = useState(null);
  const [palette, setPalette] = useState(false);
  const [sideQ, setSideQ] = useState('');
  const [msgQ, setMsgQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHits, setSearchHits] = useState(null);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState(null);
  const [editing, setEditing] = useState(null);
  const [slash, setSlash] = useState(0);
  const [drop, setDrop] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('cb_theme') || 'dark');
  const [accent, setAccent] = useState(() => localStorage.getItem('cb_accent') || '');
  const [hidden, setHidden] = useState(() => { try { return JSON.parse(localStorage.getItem('cb_hidden') || '{}'); } catch { return {}; } });
  const [showHidden, setShowHidden] = useState(false);
  const [ttl, setTtl] = useState(0);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (preferHome || groupId) return;
    const g = groups.find((x) => (x.channels || []).some((c) => c.id === activeId));
    if (g) { setGroupId(g.id); setTab('group'); }
  }, [activeId, groups, groupId, preferHome]);
  const endRef = useRef(null);
  const scRef = useRef(null);
  const fileRef = useRef(null);
  const recRef = useRef(null);
  const taRef = useRef(null);
  const group = groups.find((g) => g.id === groupId) || null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cb_theme', theme);
    if (accent) document.documentElement.style.setProperty('--accent', accent);
    else document.documentElement.style.removeProperty('--accent');
    localStorage.setItem('cb_accent', accent || '');
  }, [theme, accent]);

  useEffect(() => {
    const secure = activeId && hidden[activeId];
    document.querySelector('.shell')?.classList.toggle('secure', Boolean(secure));
    window.cbopkaAPI?.setContentProtection?.(Boolean(secure));
    const onVis = () => {
      document.querySelector('.shell')?.classList.toggle('blurred', Boolean(secure) && document.hidden);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [activeId, hidden]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      if (e.key === 'Escape') { setModal(null); setPalette(false); setExpanded(false); }
    };
    window.addEventListener('keydown', onKey);
    const onHot = (e) => { if (e.detail === 'mute') call.toggleMute(); };
    window.addEventListener('cb-hotkey', onHot);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('cb-hotkey', onHot); };
  }, [call]);

  useEffect(() => {
    if (!searchOpen || !msgQ || !activeId) { setSearchHits(null); return; }
    const t = setTimeout(() => {
      api(`/api/messages/${encodeURIComponent(activeId)}?q=${encodeURIComponent(msgQ)}`, { token }).then((d) => setSearchHits(d.messages)).catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [msgQ, searchOpen, activeId, token]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages[activeId]?.length, activeId]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(async (reg) => {
        try {
          const vapid = await api('/api/push/vapid', { token });
          if (!vapid.publicKey || !reg.pushManager) return;
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapid.publicKey) });
          await api('/api/push/subscribe', { token, method: 'POST', body: sub.toJSON() });
        } catch {}
      }).catch(() => {});
    }
  }, [token]);

  function openDm(peer) {
    const id = dmId(user.id, peer.id);
    setActiveId(id);
    setGroupId(null);
    setTab('home');
    setSideOpen(false);
    localStorage.setItem('cb_active', id);
  }
  function openChannel(ch, g) {
    setGroupId(g.id);
    setActiveId(ch.id);
    setSideOpen(false);
    localStorage.setItem('cb_active', ch.id);
    if (ch.type === 'voice') call.joinVoice(ch.id);
  }

  const list = searchHits || messages[activeId] || [];
  const pins = (messages[activeId] || []).filter((x) => x.pinned && !x.deleted);
  const typingNames = Object.entries(typing[activeId] || {}).filter(([, t]) => Date.now() - t < 2500 && t).map(([id]) => m.users[id]?.username || 'кто-то');

  const dms = useMemo(() => {
    const ids = new Set(boot?.dms || []);
    Object.keys(messages).forEach((id) => { if (id.startsWith('dm:') && id.includes(user.id)) ids.add(id); });
    return [...ids].map((id) => {
      const peerId = id.slice(3).split(':').find((x) => x !== user.id);
      const peer = m.users[peerId] || friends.find((f) => f.id === peerId);
      const last = (messages[id] || []).slice(-1)[0];
      return { id, peer, peerId, last };
    }).filter((d) => d.peerId);
  }, [boot, messages, friends, user.id, m.users]);

  function visible(id) {
    if (!hidden[id]) return true;
    return showHidden;
  }

  async function onSend(text = draft) {
    const value = text.trim();
    if (!value && !editing) return;
    if (value.startsWith('/gif ')) { setModal({ type: 'gif', q: value.slice(5) }); setDraft(''); return; }
    if (value.startsWith('/poll ')) {
      const parts = value.slice(6).split('|').map((s) => s.trim()).filter(Boolean);
      const [question, ...opts] = parts;
      if (question && opts.length >= 2) {
        await send({ type: 'poll', text: question, meta: { question, options: opts.map((t) => ({ id: Math.random().toString(36).slice(2, 8), text: t, votes: [] })) }, ttl: hiddenTtl() });
      } else toast('Формат: /poll вопрос | да | нет');
      setDraft(''); return;
    }
    if (value.startsWith('/status ')) { m.setPresence({ customStatus: value.slice(8), customEmoji: '✨' }); setDraft(''); return; }
    if (value === '/shrug' || value.startsWith('/shrug ')) {
      await send({ text: value.replace('/shrug', '¯\\_(ツ)_/¯').trim(), replyTo: reply?.id, ttl: hiddenTtl(), e2e: active?.kind === 'dm' });
      setDraft(''); setReply(null); return;
    }
    let body = value;
    if (value.startsWith('/me ')) body = `_${value.slice(4)}_`;
    if (value.startsWith('/code')) body = '```\n' + (value.replace(/^\/code\s*/, '') || 'const hi = "cbopka";') + '\n```';
    if (editing) { m.edit(editing.id, body); setEditing(null); setDraft(''); return; }
    const e2e = active?.kind === 'dm' && localStorage.getItem('cb_e2e') !== '0';
    await send({ text: body, replyTo: reply?.id, ttl: hiddenTtl(), e2e });
    setDraft(''); setReply(null);
    m.socket?.emit('typing', { convoId: activeId, active: false });
  }

  function hiddenTtl() {
    if (hidden[activeId]?.ttl) return hidden[activeId].ttl;
    return ttl || 0;
  }

  function onDraft(v) {
    setDraft(v);
    m.socket?.emit('typing', { convoId: activeId, active: Boolean(v) });
  }

  const suggestions = draft.startsWith('/') ? COMMANDS.filter((c) => c.cmd.startsWith(draft.split(' ')[0]) || draft.length < 2) : [];

  async function onFiles(files) {
    for (const f of files) {
      try { await m.uploadAndSend(f, activeId); } catch (e) { toast(e.message); }
    }
  }

  async function toggleVoice() {
    if (recordingVoice) { recRef.current?.stop(); setRecordingVoice(false); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const peaks = await waveformPeaks(blob);
      try { await m.sendVoice(blob, peaks); } catch (e) { toast(e.message); }
    };
    rec.start();
    recRef.current = rec;
    setRecordingVoice(true);
  }

  function older() {
    const first = (messages[activeId] || [])[0];
    if (first) m.loadMessages(activeId, first.at);
  }

  const myRole = active?.group ? active.group.members?.find?.((x) => x.id === user.id)?.role || active.group.members?.[user.id] : null;
  const roleOf = (uid) => {
    const mem = active?.group?.members;
    if (!mem) return null;
    if (Array.isArray(mem)) return mem.find((x) => x.id === uid)?.role;
    return mem[uid];
  };
  const canPost = !active?.channel || active.channel.type !== 'announcement' || roleOf(user.id) === 'admin' || roleOf(user.id) === 'mod';
  const voicePeers = call.peersState && active?.channel?.type === 'voice' ? Object.values(call.peersState) : [];

  if (!boot) {
    return (
      <div className="lock">
        <div style={{ textAlign: 'center' }}>
          <img src="./icon-192.png" alt="" width="64" height="64" style={{ borderRadius: 20 }} />
          <p style={{ color: 'var(--muted)' }}>Собираем комнаты…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`shell ${showMembers && active?.group ? 'members' : ''}`} style={{ '--accent': accent || undefined }}>
      <div className="app-hairline" />
      <aside className={`rail ${sideOpen ? 'open' : ''}`}>
        <img src="./icon-192.png" className="rail-logo" alt="Cbopka" />
        <button className={`rail-btn ${tab === 'home' && !groupId ? 'active' : ''}`} title="Чаты" onClick={() => { setPreferHome(true); setTab('home'); setGroupId(null); setSideOpen(true); }}>
          <Icon name="users" />
        </button>
        <div style={{ width: 28, height: 1, background: 'var(--line)', margin: '4px 0' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto', width: '100%', alignItems: 'center' }}>
          {groups.map((g) => (
            <button key={g.id} className={`rail-btn ${groupId === g.id ? 'active' : ''}`} title={g.name} onClick={() => { setPreferHome(false); setGroupId(g.id); setTab('group'); setSideOpen(true); if (!activeId || !g.channels?.some((c) => c.id === activeId)) setActiveId(g.channels?.[0]?.id || null); }}>
              <img src={g.avatar} alt="" />
            </button>
          ))}
        </div>
        <button className="rail-btn" title="Новая группа" onClick={() => setModal({ type: 'group' })}><Icon name="plus" /></button>
        <div className="rail-spacer" />
        <button className="rail-btn" title={user.username} onClick={() => setModal({ type: 'settings' })}>
          <img src={user.avatar} alt="" />
          <i className={`dot status-dot ${statusColor(online[user.id]?.status || user.status)}`} style={{ position: 'absolute' }} />
        </button>
      </aside>

      <aside className={`side ${sideOpen ? 'open' : ''}`}>
        <div className="side-head">
          <h2>{group ? group.name : 'Чаты'}</h2>
          <button className="icon-btn" onClick={() => setModal(group ? { type: 'channel' } : { type: 'friend' })} title="Добавить"><Icon name="plus" /></button>
        </div>
        <div className="search"><Icon name="search" size={15} /><input placeholder={group ? 'Найти канал' : 'Поиск'} value={sideQ} onChange={(e) => setSideQ(e.target.value)} /></div>
        <div className="side-scroll">
          {!group && (
            <>
              <button className={`row ${activeId === 'saved:' + user.id ? 'active' : ''}`} onClick={() => { setActiveId('saved:' + user.id); setSideOpen(false); }}>
                <span className="avatar" style={{ display: 'grid', placeItems: 'center', background: 'var(--accent-soft)' }}><Icon name="bookmark" /></span>
                <span className="meta"><span className="name">Избранное</span><span className="sub">заметки себе</span></span>
              </button>
              <button className="row" onClick={() => setModal({ type: 'friends' })}>
                <span className="avatar" style={{ display: 'grid', placeItems: 'center' }}><Icon name="users" /></span>
                <span className="meta"><span className="name">Друзья</span><span className="sub">{friends.length} · заявки {(boot?.incoming || []).length}</span></span>
                {(boot?.incoming || []).length > 0 && <span className="badge">{boot.incoming.length}</span>}
              </button>
              <div className="section-label">Личные</div>
              {dms.filter((d) => visible(d.id) && (!sideQ || (d.peer?.username || '').toLowerCase().includes(sideQ.toLowerCase()))).map((d) => (
                <button key={d.id} className={`row ${activeId === d.id ? 'active' : ''}`} onClick={() => openDm({ id: d.peerId, username: d.peer?.username })}>
                  <span style={{ position: 'relative' }}>
                    <img className="avatar" src={d.peer?.avatar} alt="" />
                    <i className={`status-dot ${statusColor(online[d.peerId]?.status || 'offline')}`} />
                  </span>
                  <span className="meta">
                    <span className="name">{d.peer?.username || '…'} {online[d.peerId]?.customEmoji}</span>
                    <span className="sub">{online[d.peerId]?.customStatus || d.last?.text || 'Начать разговор'}</span>
                  </span>
                </button>
              ))}
              {friends.filter((f) => !dms.some((d) => d.peerId === f.id)).map((f) => (
                <button key={f.id} className="row" onClick={() => openDm(f)}>
                  <span style={{ position: 'relative' }}><img className="avatar" src={f.avatar} alt="" /><i className={`status-dot ${statusColor(online[f.id]?.status || 'offline')}`} /></span>
                  <span className="meta"><span className="name">{f.username}</span><span className="sub">{online[f.id]?.customStatus || lastSeen(f.lastSeen, online[f.id] && online[f.id].status !== 'offline')}</span></span>
                </button>
              ))}
              <button className="row" onClick={() => setShowHidden((v) => !v)}><span className="sub">{showHidden ? 'Скрыть тайные чаты' : 'Показать скрытые чаты'}</span></button>
            </>
          )}
          {group && (
            <>
              <div className="section-label">Текстовые</div>
              {(group.channels || []).filter((c) => c.type !== 'voice' && (!sideQ || c.name.toLowerCase().includes(sideQ.toLowerCase()))).map((c) => (
                <button key={c.id} className={`row ${activeId === c.id ? 'active' : ''}`} onClick={() => openChannel(c, group)}>
                  <Icon name={c.type === 'announcement' ? 'megaphone' : 'hash'} size={16} />
                  <span className="meta"><span className="name">{c.name}</span></span>
                </button>
              ))}
              <div className="section-label">Голос · 24/7</div>
              {(group.channels || []).filter((c) => c.type === 'voice').map((c) => (
                <div key={c.id}>
                  <button className={`row ${activeId === c.id ? 'active' : ''}`} onClick={() => openChannel(c, group)}>
                    <Icon name="volume" size={16} />
                    <span className="meta"><span className="name">{c.name}</span></span>
                  </button>
                </div>
              ))}
              <button className="row" onClick={() => setModal({ type: 'invite', group })}><Icon name="link" /><span className="sub">Пригласить</span></button>
            </>
          )}
        </div>
      </aside>

      <main className="chat" onDragOver={(e) => { e.preventDefault(); setDrop(true); }} onDragLeave={() => setDrop(false)} onDrop={(e) => { e.preventDefault(); setDrop(false); onFiles(e.dataTransfer.files); }}>
        <header className="chat-head">
          <button className="icon-btn" onClick={() => setSideOpen((v) => !v)}><Icon name="menu" /></button>
          {active ? (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 680, display: 'flex', gap: 8, alignItems: 'center' }}>
                  {active.kind === 'channel' && <Icon name={active.channel.type === 'voice' ? 'volume' : active.channel.type === 'announcement' ? 'megaphone' : 'hash'} size={16} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.title}</span>
                  {active.kind === 'dm' && <Icon name="lock" size={13} />}
                  {user.nitro && <span style={{ fontSize: 10, letterSpacing: '.12em', color: 'var(--accent)' }}>NITRO</span>}
                </div>
                <div style={{ color: 'var(--faint)', fontSize: 12 }}>
                  {active.kind === 'dm' && (online[active.peerId]?.activity?.name ? `играет в ${online[active.peerId].activity.name}` : lastSeen(online[active.peerId]?.lastSeen || active.peer?.lastSeen, online[active.peerId] && online[active.peerId].status !== 'offline'))}
                  {active.kind === 'channel' && active.subtitle}
                  {active.kind === 'saved' && 'заметки, файлы, голосовые'}
                  {!connected && ' · нет связи'}
                </div>
              </div>
              {active.kind === 'dm' && <button className="icon-btn" title="Позвонить" onClick={() => call.startCall({ toUserId: active.peerId, type: 'audio' })}><Icon name="phone" /></button>}
              {active.kind === 'dm' && <button className="icon-btn" title="Видео" onClick={() => call.startCall({ toUserId: active.peerId, type: 'video' })}><Icon name="cam" /></button>}
              {active.kind === 'channel' && active.channel?.type !== 'voice' && <button className="icon-btn" title="Созвать" onClick={() => call.startCall({ channelId: active.id, type: 'video' })}><Icon name="phone" /></button>}
              <button className="icon-btn" title="Поиск по чату" onClick={() => setSearchOpen((v) => !v)}><Icon name="search" /></button>
              <button className="icon-btn" onClick={() => setShowMembers((v) => !v)}><Icon name="users" /></button>
              <button className="icon-btn" onClick={() => setModal({ type: 'chatinfo' })}><Icon name="settings" size={16} /></button>
            </>
          ) : <div style={{ color: 'var(--muted)' }}>Выберите чат</div>}
        </header>

        {call.call && !expanded && (
          <div className="call-bar">
            <span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--accent-2)' }} />
            <span style={{ flex: 1 }}>{call.call.voice ? 'Вы в голосе' : 'Звонок'} · {call.muted ? 'мут' : 'микрофон открыт'} {call.pttHeld ? '· говорите' : ''}</span>
            <button className="btn" onClick={() => setExpanded(true)}>Открыть</button>
            <button className="btn danger" onClick={call.hangup}>Выйти</button>
          </div>
        )}

        {searchOpen && (
          <div className="search" style={{ margin: '8px 16px 0' }}>
            <Icon name="search" size={15} />
            <input autoFocus placeholder="Найти в этом чате" value={msgQ} onChange={(e) => setMsgQ(e.target.value)} />
          </div>
        )}

        {pins.length > 0 && (
          <div className="pins">📌 {pins[0].text?.slice(0, 80) || 'вложение'} {pins.length > 1 ? `· ещё ${pins.length - 1}` : ''}</div>
        )}

        <div className="chat-scroll" ref={scRef}>
          {active && m.hasMore[activeId] && <button className="btn ghost" style={{ margin: '0 auto 12px', display: 'block' }} onClick={older}>Раньше</button>}
          {!active && (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}>
              <div>
                <img src="./icon-512.png" alt="" width="88" height="88" style={{ borderRadius: 28 }} />
                <h2 style={{ fontFamily: 'Fraunces, serif', fontSize: 40, margin: '12px 0 6px' }}>Тишина — тоже сообщение.</h2>
                <p style={{ color: 'var(--muted)' }}>Откройте друга слева или загляните в Cbopka HQ.</p>
              </div>
            </div>
          )}
          {active?.channel?.type === 'voice' && (
            <div className="modal" style={{ margin: '24px auto', padding: 18, maxWidth: 480 }}>
              <h3 style={{ marginTop: 0 }}>Голосовой зал</h3>
              <p style={{ color: 'var(--muted)' }}>Канал живёт постоянно. Зашли — и вас слышно, даже если текст молчит.</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {voicePeers.map((p) => (
                  <div key={p.userId} className="row" style={{ width: 'auto' }}>
                    <img className="avatar sm" src={p.user?.avatar} alt="" />
                    <span>{p.user?.username} {p.hand ? '✋' : ''} {p.muted ? '🔇' : ''}</span>
                  </div>
                ))}
                {voicePeers.length === 0 && <span style={{ color: 'var(--faint)' }}>Пока никого. Будьте первым.</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn ember" onClick={() => { call.joinVoice(active.id); setExpanded(true); }}>Войти</button>
                <button className="btn" onClick={() => call.shareScreen(user.nitro ? '4k60' : '1080p60')}>Показать экран</button>
              </div>
            </div>
          )}
          {active && active.channel?.type !== 'voice' && list.map((msg, i) => {
            const prev = list[i - 1];
            const showDay = !prev || dayLabel(prev.at) !== dayLabel(msg.at);
            const grouped = prev && prev.fromId === msg.fromId && msg.at - prev.at < 120000 && !showDay && active.kind !== 'dm';
            const author = m.users[msg.fromId] || { username: msg.fromId === user.id ? user.username : '…', avatar: user.avatar };
            const mine = msg.fromId === user.id;
            if (msg.type === 'system') return <div key={msg.id} className="system">{msg.text}</div>;
            return (
              <div key={msg.id}>
                {showDay && <div className="day"><span>{dayLabel(msg.at)}</span></div>}
                {active.kind === 'dm' || active.kind === 'saved' ? (
                  <div className={`bubble-row ${mine ? 'mine' : ''}`}>
                    <div className="bubble">
                      {msg.replyTo && <div className="reply-quote">ответ</div>}
                      <MessageContent m={msg} plainOf={m.plainOf} onVote={(opt) => m.vote(msg.id, opt)} />
                      <div style={{ fontSize: 11, marginTop: 4, opacity: .7, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span>{timeShort(msg.at)}{msg.edited && ' · изменено'}{msg.e2e && ' · 🔒'}{msg.expiresAt ? ' · таймер' : ''}</span>
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => m.react(msg.id, '❤️')}>❤️</button>
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setReply(msg)}>↩</button>
                        {mine && <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => m.remove(msg.id)}><Icon name="x" size={12} /></button>}
                      </div>
                      <Reactions msg={msg} onReact={(e) => m.react(msg.id, e)} />
                    </div>
                  </div>
                ) : (
                  <div className="msg">
                    {!grouped ? <img className="avatar" src={author.avatar} alt="" /> : <div style={{ width: 40 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {!grouped && <div><span className="who" style={{ color: mine ? 'var(--accent)' : 'var(--text)' }}>{author.username}</span><span className="time">{timeShort(msg.at)}</span>{msg.edited && <span className="edited">изменено</span>}{msg.e2e && <span className="edited">🔒</span>}</div>}
                      {msg.replyTo && <div className="reply-quote">в ответ</div>}
                      <div className="body"><MessageContent m={msg} plainOf={m.plainOf} onVote={(opt) => m.vote(msg.id, opt)} /></div>
                      <Reactions msg={msg} onReact={(e) => m.react(msg.id, e)} />
                    </div>
                    <div className="tools">
                      {['❤️','👍','😂'].map((e) => <button key={e} className="icon-btn" onClick={() => m.react(msg.id, e)}>{e}</button>)}
                      <button className="icon-btn" title="Ответить" onClick={() => setReply(msg)}>↩</button>
                      <button className="icon-btn" title="Тред" onClick={() => setActiveId('thread:' + msg.id)}>⧉</button>
                      <button className="icon-btn" title="Закрепить" onClick={() => m.pin(msg.id)}><Icon name="pin" size={14} /></button>
                      {mine && <button className="icon-btn" onClick={() => { setEditing(msg); setDraft(msg.text); }}>✎</button>}
                      <button className="icon-btn" onClick={() => m.remove(msg.id)}><Icon name="x" size={14} /></button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
        {typingNames.length > 0 && <div style={{ padding: '0 22px', color: 'var(--faint)', fontSize: 12 }}>{typingNames.join(', ')} печатает…</div>}
        {reply && <div className="pins">Ответ · <button className="icon-btn" onClick={() => setReply(null)}><Icon name="x" size={12} /></button></div>}
        {suggestions.length > 0 && (
          <div className="slash">
            {suggestions.map((c, i) => (
              <button key={c.cmd} className={i === slash ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); setDraft(c.cmd); }}>
                <b>{c.cmd}</b><span style={{ color: 'var(--muted)' }}>{c.hint}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-wrap">
          {!canPost ? <div className="composer" style={{ padding: 14, color: 'var(--muted)' }}>Анонсы пишут только админы и модераторы.</div> : (
            <div className="composer">
              <button className="icon-btn" onClick={() => fileRef.current?.click()} title="Файл"><Icon name="plus" /></button>
              <button className="icon-btn" onClick={() => setModal({ type: 'gif', q: '' })} title="GIF">GIF</button>
              <button className="icon-btn" onClick={() => setModal({ type: 'stickers' })} title="Стикеры"><Icon name="smile" /></button>
              <button className={`icon-btn ${recordingVoice ? 'on' : ''}`} onClick={toggleVoice} title="Голосовое"><Icon name="mic" /></button>
              <textarea ref={taRef} rows={1} placeholder={editing ? 'Правка сообщения' : 'Сообщение. / для команд'} value={draft} onChange={(e) => onDraft(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
                if (e.key === 'ArrowUp' && !draft) {
                  const mine = [...(messages[activeId] || [])].reverse().find((x) => x.fromId === user.id && !x.deleted && !x.e2e);
                  if (mine) { setEditing(mine); setDraft(mine.text); }
                }
              }} />
              <button className="send" disabled={!draft.trim() && !editing} onClick={() => onSend()}><Icon name="send" size={16} /></button>
            </div>
          )}
          <input ref={fileRef} type="file" hidden multiple onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
        </div>
        {drop && <div className="drop">Отпустите — файл уйдёт в чат</div>}
      </main>

      {showMembers && active?.group && (
        <aside className="members">
          <div className="section-label">Участники</div>
          {(Array.isArray(active.group.members) ? active.group.members : Object.entries(active.group.members).map(([id, role]) => ({ ...(m.users[id] || {}), id, role }))).map((mem) => (
            <button key={mem.id} className="row" onClick={() => setModal({ type: 'profile', user: mem.id ? { ...m.users[mem.id], ...mem } : mem })}>
              <span style={{ position: 'relative' }}><img className="avatar sm" src={mem.avatar || m.users[mem.id]?.avatar} alt="" /><i className={`status-dot ${statusColor(online[mem.id]?.status || 'offline')}`} /></span>
              <span className="meta"><span className="name">{mem.username || m.users[mem.id]?.username}</span><span className="sub">{mem.role}</span></span>
            </button>
          ))}
        </aside>
      )}

      <AnimatePresence>
        {modal && (
          <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setModal(null)}>
            <motion.div className="modal" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} onClick={(e) => e.stopPropagation()} style={{ padding: 18 }}>
              <ModalBody modal={modal} setModal={setModal} m={m} call={call} theme={theme} setTheme={setTheme} accent={accent} setAccent={setAccent} hidden={hidden} setHidden={setHidden} ttl={ttl} setTtl={setTtl} toast={toast} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {palette && <Palette onClose={() => setPalette(false)} m={m} setModal={setModal} setActiveId={setActiveId} openDm={openDm} />}
      {call.incoming && (
        <div className="incoming">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <img className="avatar" src={call.incoming.from?.avatar} alt="" />
            <div>
              <b>{call.incoming.from?.username}</b>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>{call.incoming.type === 'audio' ? 'Голосовой звонок' : 'Видеозвонок'}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn ember" onClick={() => { call.acceptCall(); setExpanded(true); }}>Ответить</button>
            <button className="btn danger" onClick={call.rejectCall}>Отклонить</button>
          </div>
        </div>
      )}
      {expanded && call.call && (
        <CallStage
          call={call.call} me={user} localStream={call.localStream} remotes={call.remotes} peersState={call.peersState}
          muted={call.muted} camOff={call.camOff} sharing={call.sharing} recording={call.recording} hand={call.hand}
          ptt={call.ptt} pttHeld={call.pttHeld} quality={call.quality} stats={call.stats} reactions={call.reactions}
          strokes={call.strokes} drawOn={call.drawOn} bg={call.bg} noise={call.noise}
          onMute={() => call.toggleMute()} onCam={call.toggleCam} onShare={call.shareScreen} onQuality={call.setQuality}
          onRecord={call.toggleRecord} onHand={call.raiseHand} onPtt={() => call.setPtt((v) => !v)} onReact={call.sendReaction}
          onHangup={() => { call.hangup(); setExpanded(false); }} onDrawToggle={() => call.setDrawOn((v) => !v)} onStroke={call.pushStroke}
          onBg={call.setBackground} onNoise={call.setNoise}
        />
      )}
      <div className="toast-wrap">{toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}</div>
    </div>
  );
}

function Reactions({ msg, onReact }) {
  const entries = Object.entries(msg.reactions || {});
  if (!entries.length) return null;
  return (
    <div className="reactions">
      {entries.map(([e, ids]) => <button key={e} className="react" onClick={() => onReact(e)}>{e} {ids.length}</button>)}
    </div>
  );
}

function MessageContent({ m, plainOf, onVote }) {
  if (m.type === 'poll' && m.meta?.options) {
    const total = m.meta.options.reduce((a, o) => a + (o.votes?.length || 0), 0) || 1;
    return (
      <div className="poll">
        <b>{m.meta.question || m.text}</b>
        {m.meta.options.map((o) => (
          <button key={o.id} onClick={() => onVote(o.id)}>
            <i className="bar" style={{ width: `${((o.votes?.length || 0) / total) * 100}%` }} />
            <span className="label"><span>{o.text}</span><span>{o.votes?.length || 0}</span></span>
          </button>
        ))}
      </div>
    );
  }
  if (m.type === 'sticker') return <div className="sticker">{m.text}</div>;
  if (m.type === 'gif' || m.meta?.kind === 'gif') return <img className="gif-img" src={m.meta?.url} alt="" />;
  if (m.type === 'voice' || m.meta?.kind === 'audio') {
    return (
      <div className="voice-card">
        <audio controls src={fileUrl(m.meta?.url)} />
        <div className="waveform">{(m.meta?.peaks || []).slice(0, 28).map((p, i) => <i key={i} style={{ height: 4 + p * 22 }} />)}</div>
      </div>
    );
  }
  if (m.meta?.kind === 'image') return <img className="preview-img" src={fileUrl(m.meta.url)} alt={m.meta.name || ''} />;
  if (m.meta?.kind === 'video') return <video className="preview-img" controls src={fileUrl(m.meta.url)} />;
  if (m.type === 'file' || m.meta?.url) {
    return (
      <a className="file-card" href={fileUrl(m.meta.url)} target="_blank" rel="noreferrer">
        <Icon name="image" />
        <span><b>{m.meta.name || m.text}</b><div style={{ color: 'var(--muted)', fontSize: 12 }}>{bytes(m.meta.size || 0)}</div></span>
      </a>
    );
  }
  return <TextBody m={m} plainOf={plainOf} />;
}

function ModalBody({ modal, setModal, m, call, theme, setTheme, accent, setAccent, hidden, setHidden, ttl, setTtl, toast }) {
  const { user, token, friends, groups } = m;
  if (modal.type === 'settings') return <Settings m={m} theme={theme} setTheme={setTheme} accent={accent} setAccent={setAccent} toast={toast} onClose={() => setModal(null)} />;
  if (modal.type === 'friends') return <FriendsPanel m={m} onClose={() => setModal(null)} />;
  if (modal.type === 'friend') return <AddFriend m={m} onClose={() => setModal(null)} />;
  if (modal.type === 'group') return <CreateGroup m={m} onClose={() => setModal(null)} />;
  if (modal.type === 'channel') return <CreateChannel m={m} onClose={() => setModal(null)} />;
  if (modal.type === 'invite') return <InviteBox group={modal.group} token={token} toast={toast} />;
  if (modal.type === 'gif') return <GifBox initial={modal.q} onPick={(url) => { m.send({ type: 'gif', text: 'GIF', meta: { url, kind: 'gif' } }); setModal(null); }} />;
  if (modal.type === 'stickers') return (
    <div>
      <h3 style={{ marginTop: 0 }}>Стикеры</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6 }}>
        {STICKERS.concat(EMOJI).map((e) => <button key={e} className="icon-btn" style={{ fontSize: 26, width: 42, height: 42 }} onClick={() => { m.send({ type: 'sticker', text: e }); setModal(null); }}>{e}</button>)}
      </div>
      {user.nitro && <NitroEmoji m={m} />}
    </div>
  );
  if (modal.type === 'profile') return <ProfileCard person={modal.user} m={m} call={call} onClose={() => setModal(null)} />;
  if (modal.type === 'chatinfo') return (
    <ChatInfo m={m} hidden={hidden} setHidden={setHidden} ttl={ttl} setTtl={setTtl} onClose={() => setModal(null)} />
  );
  return null;
}

function Settings({ m, theme, setTheme, accent, setAccent, toast, onClose }) {
  const { user, token } = m;
  const [tab, setTab] = useState('profile');
  const [bio, setBio] = useState(user.bio || '');
  const [status, setStatus] = useState(user.customStatus || '');
  const [emoji, setEmoji] = useState(user.customEmoji || '');
  const [game, setGame] = useState(user.activity?.name || '');
  const [presence, setPresence] = useState(user.status || 'online');
  const [secret, setSecret] = useState('');
  const [otp, setOtp] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [sounds, setS] = useState(soundsOn());
  useEffect(() => { window.cbopkaAPI?.onGame?.((name) => { if (name) { setGame(name); m.setPresence({ status: 'playing', activity: { type: 'playing', name } }); } }); }, []);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontFamily: 'Fraunces, serif' }}>Настройки</h2>
        <button className="icon-btn" onClick={onClose}><Icon name="x" /></button>
      </div>
      <div style={{ display: 'flex', gap: 6, margin: '12px 0', flexWrap: 'wrap' }}>
        {[['profile','Профиль'],['look','Тема'],['privacy','Приватность'],['security','Защита'],['nitro','Nitro'],['keys','Клавиши']].map(([id, label]) => (
          <button key={id} className="btn" style={{ background: tab === id ? 'var(--text)' : 'var(--bg-4)', color: tab === id ? 'var(--bg)' : 'inherit' }} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'profile' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <img className="avatar lg" src={user.avatar} alt="" />
          <input className="field" value={bio} onChange={(e) => setBio(e.target.value)} placeholder="О себе" />
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="field" style={{ width: 72 }} value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="✦" />
            <input className="field" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Кастомный статус" />
          </div>
          <input className="field" value={game} onChange={(e) => setGame(e.target.value)} placeholder="Играю в…" />
          <div style={{ display: 'flex', gap: 6 }}>
            {['online','idle','dnd','playing','offline'].map((s) => <button key={s} className="btn" onClick={() => setPresence(s)} style={{ outline: presence === s ? '2px solid var(--accent)' : 'none' }}>{s}</button>)}
          </div>
          <button className="btn ember" onClick={async () => {
            await m.updateMe({ bio, customStatus: status, customEmoji: emoji, status: presence, activity: game ? { type: 'playing', name: game } : null });
            m.setPresence({ status: presence, customStatus: status, customEmoji: emoji, activity: game ? { type: 'playing', name: game } : null });
            toast('Профиль обновлён');
          }}>Сохранить</button>
          <label className="btn ghost">Сменить аватар<input type="file" accept="image/*" hidden onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            const meta = await uploadFile(token, file);
            await m.updateMe({ avatar: fileUrl(meta.url) });
          }} /></label>
        </div>
      )}
      {tab === 'look' && (
        <div style={{ display: 'grid', gap: 8 }}>
          {['dark','light','amoled'].map((t) => <button key={t} className="btn" onClick={() => setTheme(t)}>{t === 'dark' ? 'Тёмная' : t === 'light' ? 'Светлая' : 'AMOLED'} {theme === t ? '·' : ''}</button>)}
          <label>Свой акцент <input type="color" value={accent || '#ff6a45'} onChange={(e) => setAccent(e.target.value)} /></label>
          <button className="btn" onClick={() => setAccent('')}>Сбросить акцент</button>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={sounds} onChange={(e) => { setS(e.target.checked); setSounds(e.target.checked); }} /> Звуки уведомлений</label>
        </div>
      )}
      {tab === 'privacy' && <Privacy m={m} toast={toast} />}
      {tab === 'security' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <p style={{ color: 'var(--muted)', margin: 0 }}>2FA TOTP, пин на приложение, E2E в личных чатах.</p>
          <button className="btn" onClick={async () => {
            const data = await api('/api/2fa/setup', { token, method: 'POST', body: {} });
            setSecret(data.secret); setOtp(data.otpauth);
            setQr(await QRCode.toDataURL(data.otpauth, { margin: 1, width: 180 }));
          }}>Включить 2FA</button>
          {qr && <img src={qr} alt="QR 2FA" width="180" />}
          {secret && <code style={{ fontSize: 12 }}>{secret}</code>}
          <input className="field" placeholder="Код 2FA" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn ember" onClick={async () => { await api('/api/2fa/enable', { token, method: 'POST', body: { code } }); toast('2FA включена'); }}>Подтвердить 2FA</button>
          <input className="field" placeholder="Пин на приложение (4–6)" value={pin} onChange={(e) => setPin(e.target.value)} />
          <button className="btn" onClick={async () => { localStorage.setItem('cb_pin', await sha256(pin)); toast('Пин сохранён. Сработает при следующем запуске.'); }}>Поставить пин</button>
          <button className="btn ghost" onClick={() => { localStorage.removeItem('cb_pin'); toast('Пин снят'); }}>Снять пин</button>
          <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" defaultChecked={localStorage.getItem('cb_e2e') !== '0'} onChange={(e) => localStorage.setItem('cb_e2e', e.target.checked ? '1' : '0')} /> Шифровать личные сообщения</label>
          <Autostart />
        </div>
      )}
      {tab === 'nitro' && (
        <div>
          <h3 style={{ fontFamily: 'Fraunces, serif' }}>Cbopka Nitro</h3>
          <p style={{ color: 'var(--muted)' }}>Демо-флаг, без оплаты: кастомные эмодзи, 4K 60, файлы до 100 МБ вместо 25.</p>
          <button className="btn ember" onClick={async () => { const data = await api('/api/nitro', { token, method: 'POST', body: { enabled: !user.nitro } }); m.updateMe({}); localStorage.setItem('cb_user', JSON.stringify(data.user)); toast(data.user.nitro ? 'Nitro включён' : 'Nitro выключен'); location.reload(); }}>{user.nitro ? 'Выключить' : 'Попробовать Nitro'}</button>
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--muted)' }}>4K: {QUALITY['4k60'].label} {user.nitro ? 'доступно' : 'закрыто'}</div>
        </div>
      )}
      {tab === 'keys' && (
        <ul style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
          <li>Ctrl/⌘ K — палитра</li>
          <li>Enter — отправить, Shift+Enter — строка</li>
          <li>↑ — править последнее</li>
          <li>V — push-to-talk, если включён в звонке</li>
          <li>Ctrl+Shift+M — мут (и глобально в приложении)</li>
          <li>Esc — закрыть</li>
        </ul>
      )}
    </div>
  );
}

function Autostart() {
  const [on, setOn] = useState(false);
  useEffect(() => { window.cbopkaAPI?.getAutostart?.().then(setOn).catch(() => {}); }, []);
  if (!window.cbopkaAPI?.setAutostart) return <p style={{ color: 'var(--faint)', fontSize: 13 }}>Автозапуск доступен в нативном окне.</p>;
  return <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={!!on} onChange={(e) => { setOn(e.target.checked); window.cbopkaAPI.setAutostart(e.target.checked); }} /> Запускать Cbopka вместе с системой</label>;
}

function Privacy({ m, toast }) {
  const p = m.user.privacy || {};
  const [dm, setDm] = useState(p.dm || 'everyone');
  const [calls, setCalls] = useState(p.calls || 'everyone');
  const [seen, setSeen] = useState(p.showLastSeen || 'everyone');
  const [blocks, setBlocks] = useState([]);
  const [vcf, setVcf] = useState([]);
  useEffect(() => { api('/api/blocks', { token: m.token }).then((d) => setBlocks(d.users || [])).catch(() => {}); }, []);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label>Кто пишет в личку
        <select className="field" value={dm} onChange={(e) => setDm(e.target.value)}>{['everyone','friends','nobody'].map((v) => <option key={v}>{v}</option>)}</select>
      </label>
      <label>Кто звонит
        <select className="field" value={calls} onChange={(e) => setCalls(e.target.value)}>{['everyone','friends','nobody'].map((v) => <option key={v}>{v}</option>)}</select>
      </label>
      <label>Последний визит
        <select className="field" value={seen} onChange={(e) => setSeen(e.target.value)}>{['everyone','friends','nobody'].map((v) => <option key={v}>{v}</option>)}</select>
      </label>
      <button className="btn ember" onClick={async () => { await m.updateMe({ privacy: { dm, calls, showLastSeen: seen } }); toast('Приватность сохранена'); }}>Сохранить</button>
      <div className="section-label">Чёрный список</div>
      {blocks.map((u) => <div key={u.id} className="row"><span>{u.username}</span><button className="btn" onClick={async () => { await api('/api/users/' + u.id + '/block', { token: m.token, method: 'DELETE' }); setBlocks(blocks.filter((x) => x.id !== u.id)); }}>Разблокировать</button></div>)}
      <label className="btn ghost">Импорт контактов .vcf<input type="file" accept=".vcf,text/vcard" hidden onChange={async (e) => {
        const text = await e.target.files[0].text();
        const cards = text.split(/END:VCARD/i).map((c) => {
          const name = (c.match(/FN:(.*)/i) || [])[1];
          const tel = (c.match(/TEL[^:]*:(.*)/i) || [])[1];
          return name ? { name: name.trim(), tel: (tel || '').trim() } : null;
        }).filter(Boolean);
        setVcf(cards);
      }} /></label>
      {vcf.map((c) => <div key={c.name + c.tel} className="row"><span className="meta"><b>{c.name}</b><div className="sub">{c.tel}</div></span></div>)}
      <Activity m={m} />
    </div>
  );
}

function Activity({ m }) {
  const [items, setItems] = useState(m.boot?.activity || []);
  useEffect(() => { api('/api/activity', { token: m.token }).then((d) => setItems(d.activity || [])).catch(() => {}); }, []);
  return (
    <div>
      <div className="section-label">Лента</div>
      {items.slice(0, 8).map((a) => <div key={a.id} className="sub" style={{ padding: '4px 0' }}>{a.user?.username || 'кто-то'} · {a.type}</div>)}
    </div>
  );
}

function FriendsPanel({ m, onClose }) {
  const [name, setName] = useState('');
  const [found, setFound] = useState([]);
  const [qr, setQr] = useState('');
  useEffect(() => { QRCode.toDataURL('cbopka://add/' + m.user.username, { margin: 1, width: 160, color: { dark: '#1c1915', light: '#00000000' } }).then(setQr); }, []);
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Друзья</h3>
      {(m.boot?.incoming || []).map((r) => (
        <div key={r.id} className="row">
          <img className="avatar sm" src={r.fromUser?.avatar} alt="" />
          <span style={{ flex: 1 }}>{r.fromUser?.username}</span>
          <button className="btn ember" onClick={async () => { await api('/api/friends/accept', { token: m.token, method: 'POST', body: { requestId: r.id } }); m.refreshFriends(); }}>Принять</button>
          <button className="btn" onClick={() => api('/api/friends/decline', { token: m.token, method: 'POST', body: { requestId: r.id } }).then(m.refreshFriends)}>Нет</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input className="field" placeholder="Найти по нику" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" onClick={async () => { const d = await api('/api/users/search?q=' + encodeURIComponent(name), { token: m.token }); setFound(d.users); }}>Найти</button>
      </div>
      {found.map((u) => (
        <div key={u.id} className="row">
          <img className="avatar sm" src={u.avatar} alt="" /><span style={{ flex: 1 }}>{u.username}</span>
          <button className="btn" onClick={async () => { await api('/api/friends/request', { token: m.token, method: 'POST', body: { userId: u.id } }); m.toast('Заявка ушла'); }}>Добавить</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'center' }}>
        {qr && <img src={qr} alt="QR" width="120" />}
        <div>
          <div>QR для добавления</div>
          <code>cbopka://add/{m.user.username}</code>
          <ScanQr onFound={(raw) => { const nick = raw.split('/').pop(); setName(nick); }} />
        </div>
      </div>
      <button className="btn ghost" style={{ marginTop: 10 }} onClick={onClose}>Закрыть</button>
    </div>
  );
}

function ScanQr({ onFound }) {
  const [on, setOn] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!on) return;
    let stop = false; let stream;
    (async () => {
      if (!('BarcodeDetector' in window)) return;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      ref.current.srcObject = stream;
      await ref.current.play();
      const det = new BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (stop) return;
        try {
          const codes = await det.detect(ref.current);
          if (codes[0]) { onFound(codes[0].rawValue); stop = true; stream.getTracks().forEach((t) => t.stop()); return; }
        } catch {}
        requestAnimationFrame(tick);
      };
      tick();
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [on]);
  return (
    <div>
      <button className="btn" onClick={() => setOn(true)}>Сканировать QR</button>
      {on && <video ref={ref} style={{ width: 160, borderRadius: 12, marginTop: 8 }} muted playsInline />}
    </div>
  );
}

function AddFriend({ m, onClose }) {
  const [name, setName] = useState('');
  return (
    <form onSubmit={async (e) => { e.preventDefault(); await api('/api/friends/request', { token: m.token, method: 'POST', body: { username: name } }); m.toast('Заявка отправлена'); onClose(); }} style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Добавить друга</h3>
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="ник" />
      <button className="btn ember">Отправить заявку</button>
    </form>
  );
}

function CreateGroup({ m, onClose }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <form onSubmit={async (e) => { e.preventDefault(); const d = await api('/api/groups', { token: m.token, method: 'POST', body: { name, description: desc } }); m.setBoot((b) => ({ ...b, groups: [...(b.groups || []), d.group] })); onClose(); }} style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Новая группа</h3>
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" required />
      <input className="field" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="О чём" />
      <button className="btn ember">Создать</button>
    </form>
  );
}

function CreateChannel({ m, onClose }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const g = m.groups.find((x) => (x.channels || []).some((c) => c.id === m.activeId)) || m.groups[0];
  return (
    <form onSubmit={async (e) => { e.preventDefault(); if (!g) return; await api('/api/groups/' + g.id + '/channels', { token: m.token, method: 'POST', body: { name, type } }); const fresh = await api('/api/groups', { token: m.token }); m.setBoot((b) => ({ ...b, groups: fresh.groups })); onClose(); }} style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Канал в {g?.name}</h3>
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="название" required />
      <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="text">Текст</option>
        <option value="voice">Голос 24/7</option>
        <option value="announcement">Анонсы</option>
      </select>
      <button className="btn ember">Создать</button>
    </form>
  );
}

function InviteBox({ group, token, toast }) {
  const [inv, setInv] = useState(null);
  const [maxUses, setMaxUses] = useState(10);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Приглашение в {group.name}</h3>
      <label>Лимит использований <input className="field" type="number" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} /></label>
      <button className="btn ember" onClick={async () => {
        const d = await api('/api/groups/' + group.id + '/invites', { token, method: 'POST', body: { maxUses: Number(maxUses), expiresIn: 7 * 86400000 } });
        setInv(d.invite);
      }}>Создать ссылку</button>
      {inv && <code style={{ wordBreak: 'break-all' }}>{location.origin + location.pathname + '?invite=' + inv.code}</code>}
      {inv && <button className="btn" onClick={() => { navigator.clipboard?.writeText(location.origin + '/?invite=' + inv.code); toast('Ссылка скопирована'); }}>Копировать</button>}
    </div>
  );
}

function GifBox({ initial, onPick }) {
  const [q, setQ] = useState(initial || '');
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');
  async function run(e) {
    e?.preventDefault();
    setErr('');
    const list = await searchGifs(q || 'hello');
    setItems(list);
    if (!list.length) setErr('Tenor не ответил. Стикеры работают офлайн.');
  }
  useEffect(() => { run(); }, []);
  return (
    <div>
      <form onSubmit={run} style={{ display: 'flex', gap: 8 }}><input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск GIF" /><button className="btn">Искать</button></form>
      {err && <p style={{ color: 'var(--muted)' }}>{err}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 10, maxHeight: 360, overflow: 'auto' }}>
        {items.map((g) => <button key={g.url} onClick={() => onPick(g.url)} style={{ border: 0, padding: 0, background: 'transparent' }}><img src={g.preview || g.url} alt="" style={{ width: '100%', borderRadius: 10 }} /></button>)}
      </div>
    </div>
  );
}

function ProfileCard({ person, m, call, onClose }) {
  if (!person) return null;
  const u = { ...m.users[person.id], ...person };
  return (
    <div>
      <img className="avatar lg" src={u.avatar} alt="" />
      <h2 style={{ marginBottom: 4 }}>{u.username}</h2>
      <div style={{ color: 'var(--muted)' }}>{u.customEmoji} {u.customStatus || u.bio}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn ember" onClick={() => { const id = dmId(m.user.id, u.id); m.setActiveId(id); onClose(); }}>Написать</button>
        <button className="btn" onClick={() => { call.startCall({ toUserId: u.id, type: 'audio' }); onClose(); }}>Позвонить</button>
        <button className="btn danger" onClick={async () => { await api('/api/users/' + u.id + '/block', { token: m.token, method: 'POST' }); m.toast('Заблокирован'); onClose(); }}>Блок</button>
      </div>
      {m.active?.group && (m.active.group.members?.[m.user.id] === 'admin' || (Array.isArray(m.active.group.members) && m.active.group.members.find((x) => x.id === m.user.id)?.role === 'admin')) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {['admin','mod','member'].map((role) => <button key={role} className="btn" onClick={() => api(`/api/groups/${m.active.group.id}/members/${u.id}`, { token: m.token, method: 'PATCH', body: { role } })}>{role}</button>)}
          <button className="btn danger" onClick={() => api(`/api/groups/${m.active.group.id}/members/${u.id}`, { token: m.token, method: 'DELETE' })}>Кик</button>
        </div>
      )}
    </div>
  );
}

function ChatInfo({ m, hidden, setHidden, ttl, setTtl, onClose }) {
  const id = m.activeId;
  const h = hidden[id];
  function save(next) {
    const copy = { ...hidden, ...next };
    if (next && next[id] === null) delete copy[id];
    setHidden(copy);
    localStorage.setItem('cb_hidden', JSON.stringify(copy));
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Чат</h3>
      <p style={{ color: 'var(--muted)', margin: 0 }}>Скрытый чат размывается, когда окно теряет фокус. В нативном приложении включается защита от скриншотов.</p>
      <button className="btn" onClick={() => save({ [id]: h ? null : { ttl: ttl || 3600000 } })}>{h ? 'Убрать из скрытых' : 'Сделать скрытым'}</button>
      <label>Самоуничтожение сообщений
        <select className="field" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          <option value={0}>выкл</option>
          <option value={5000}>5 секунд</option>
          <option value={60000}>1 минута</option>
          <option value={3600000}>1 час</option>
          <option value={86400000}>1 день</option>
        </select>
      </label>
      <button className="btn ghost" onClick={onClose}>Готово</button>
    </div>
  );
}

function NitroEmoji({ m }) {
  return (
    <label className="btn" style={{ marginTop: 8 }}>Кастомный эмодзи
      <input type="file" accept="image/*" hidden onChange={async (e) => {
        const file = e.target.files?.[0]; if (!file) return;
        const meta = await uploadFile(m.token, file);
        const list = [...(m.user.customEmojis || []), { id: meta.id, name: file.name.split('.')[0], url: fileUrl(meta.url) }];
        await m.updateMe({ customEmojis: list });
        m.send({ type: 'gif', text: file.name, meta: { url: fileUrl(meta.url), kind: 'gif' } });
      }} />
    </label>
  );
}

function Palette({ onClose, m, setModal, setActiveId, openDm }) {
  const [q, setQ] = useState('');
  const items = [
    { label: 'Настройки', run: () => setModal({ type: 'settings' }) },
    { label: 'Друзья', run: () => setModal({ type: 'friends' }) },
    { label: 'Новая группа', run: () => setModal({ type: 'group' }) },
    { label: 'Избранное', run: () => setActiveId('saved:' + m.user.id) },
    ...m.friends.map((f) => ({ label: 'Написать ' + f.username, run: () => openDm(f) })),
    ...m.groups.map((g) => ({ label: 'Группа ' + g.name, run: () => setActiveId(g.channels?.[0]?.id) }))
  ].filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="palette" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <input autoFocus className="field" style={{ border: 0, borderRadius: 0, borderBottom: '1px solid var(--line)' }} placeholder="Куда прыгнуть?" value={q} onChange={(e) => setQ(e.target.value)} />
        {items.slice(0, 8).map((i) => <button key={i.label} className="row" onClick={() => { i.run(); onClose(); }}>{i.label}</button>)}
      </div>
    </div>
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
