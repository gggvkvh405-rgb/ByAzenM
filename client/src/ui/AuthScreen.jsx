import { useState } from 'react';
import { motion } from 'framer-motion';
import Icon from './icons.jsx';

export default function AuthScreen({ onLogin, onRegister, onDemo, on2fa }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [ticket, setTicket] = useState('');
  const [code, setCode] = useState('');
  const [p2p, setP2p] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      if (ticket) {
        await on2fa(ticket, code);
        return;
      }
      if (mode === 'login') {
        const data = await onLogin(username.trim(), password, code);
        if (data?.need2fa) { setTicket(data.ticket); setErr(''); }
      } else {
        await onRegister(username.trim(), password);
      }
    } catch (ex) { setErr(ex.message); }
    setLoading(false);
  }

  return (
    <div className="auth">
      <div className="auth-brand">
        <div>
          <img src="./icon-192.png" alt="" width="64" height="64" style={{ borderRadius: 20 }} />
          <div className="word">Место,<br/>где свои<br/>слышны.</div>
          <p style={{ maxWidth: 460, color: 'var(--muted)', fontSize: 17, lineHeight: 1.5 }}>
            Чаты как в Telegram — быстрые, с голосовыми и ответами. Комнаты как в Discord — каналы, роли, голос 24/7.
            И звонок, который доходит за NAT, а не только в одной квартире.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 18, color: 'var(--muted)', fontSize: 13 }}>
          <span>E2E в личных</span>
          <span>4K-экран</span>
          <span>Трей, не вкладка</span>
        </div>
      </div>
      <div className="auth-card">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="modal" style={{ padding: 28, width: 'min(420px, 100%)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            <img src="./icon-192.png" alt="" width="36" height="36" style={{ borderRadius: 12 }} />
            <div>
              <div style={{ fontFamily: 'Fraunces, serif', fontSize: 28, lineHeight: 1 }}>Cbopka</div>
              <div style={{ color: 'var(--faint)', fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase' }}>версия 2.0</div>
            </div>
          </div>
          {!ticket && (
            <div style={{ display: 'flex', background: 'var(--bg)', borderRadius: 999, padding: 4, marginBottom: 16, border: '1px solid var(--line)' }}>
              {['login', 'register'].map((m) => (
                <button key={m} onClick={() => setMode(m)} className="btn" style={{ flex: 1, background: mode === m ? 'var(--text)' : 'transparent', color: mode === m ? 'var(--bg)' : 'var(--muted)', borderRadius: 999 }}>{m === 'login' ? 'Вход' : 'Регистрация'}</button>
              ))}
            </div>
          )}
          <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
            {ticket ? (
              <>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>Введите код из приложения-аутентификатора.</p>
                <input className="field" inputMode="numeric" autoFocus placeholder="000 000" value={code} onChange={(e) => setCode(e.target.value)} />
              </>
            ) : (
              <>
                <input className="field" placeholder="Ник" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} autoComplete="username" />
                <input className="field" type="password" placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={4} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              </>
            )}
            {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
            <button className="btn ember" disabled={loading}>{loading ? 'Секунду…' : ticket ? 'Подтвердить' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
          </form>
          {!ticket && (
            <button className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={() => onDemo().catch((e) => setErr(e.message))}>
              Быстрый вход гостем
            </button>
          )}
          <button onClick={() => setP2p((v) => !v)} style={{ marginTop: 14, background: 'none', border: 0, color: 'var(--accent-2)', fontSize: 13 }}>
            {p2p ? 'Скрыть P2P' : 'P2P без сервера — по ID'}
          </button>
          {p2p && <P2PPanel />}
        </motion.div>
      </div>
    </div>
  );
}

function P2PPanel() {
  const [myId, setMyId] = useState('');
  const [other, setOther] = useState('');
  const [text, setText] = useState('');
  const [log, setLog] = useState([]);
  const [peer, setPeer] = useState(null);
  const [conn, setConn] = useState(null);
  const [err, setErr] = useState('');

  async function boot() {
    setErr('');
    try {
      const { default: Peer } = await import('peerjs');
      const p = new Peer({ debug: 0 });
      p.on('open', setMyId);
      p.on('error', (e) => setErr(e.message || 'PeerJS недоступен'));
      p.on('connection', (c) => bind(c));
      p.on('call', async (call) => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        call.answer(stream);
        call.on('stream', (s) => { const v = document.getElementById('p2p-remote'); if (v) v.srcObject = s; });
      });
      setPeer(p);
    } catch (e) { setErr(e.message); }
  }
  function bind(c) {
    setConn(c);
    c.on('data', (d) => setLog((l) => [...l, d]));
  }
  function connect() {
    if (!peer || !other) return;
    bind(peer.connect(other.trim()));
  }
  async function call() {
    if (!peer || !other) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const local = document.getElementById('p2p-local');
    if (local) local.srcObject = stream;
    const c = peer.call(other.trim(), stream);
    c.on('stream', (s) => { const v = document.getElementById('p2p-remote'); if (v) v.srcObject = s; });
  }
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>Прямое соединение через PeerJS. Нужен интернет до их брокера, дальше медиа идёт P2P.</p>
      {!peer ? <button className="btn" onClick={boot}>Получить ID</button> : <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{myId || '…'}</code>}
      <input className="field" placeholder="ID друга" value={other} onChange={(e) => setOther(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={connect}>Чат</button>
        <button className="btn" onClick={call}><Icon name="phone" size={14} /> Звонок</button>
      </div>
      {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
      <div style={{ maxHeight: 80, overflow: 'auto', fontSize: 13 }}>{log.map((l, i) => <div key={i}>{String(l)}</div>)}</div>
      <form onSubmit={(e) => { e.preventDefault(); conn?.send(text); setLog((l) => [...l, 'вы: ' + text]); setText(''); }} style={{ display: 'flex', gap: 6 }}>
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Сообщение" />
        <button className="send" type="submit"><Icon name="send" size={16} /></button>
      </form>
      <div style={{ display: 'flex', gap: 8 }}>
        <video id="p2p-local" autoPlay muted playsInline style={{ width: 120, borderRadius: 12, background: '#000' }} />
        <video id="p2p-remote" autoPlay playsInline style={{ width: 120, borderRadius: 12, background: '#000' }} />
      </div>
    </div>
  );
}
