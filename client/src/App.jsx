import { useEffect, useState } from 'react';
import AuthScreen from './ui/AuthScreen.jsx';
import Messenger from './ui/Messenger.jsx';
import HostBar from './ui/HostBar.jsx';
import { useMessenger } from './state/useMessenger.js';
import { useCall } from './state/useCall.js';
import { sha256 } from './lib/crypto.js';

export default function App() {
  const params = new URLSearchParams(location.search);
  if (params.get('overlay') === '1') return <OverlayApp />;
  return <Root />;
}

function Root() {
  const [unlocked, setUnlocked] = useState(() => !localStorage.getItem('cb_pin'));
  if (!unlocked) return <PinGate onUnlock={() => setUnlocked(true)} />;
  return <Main />;
}

function Main() {
  const m = useMessenger();
  const call = useCall(m.socket, m.user);
  useEffect(() => {
    const theme = localStorage.getItem('cb_theme') || 'dark';
    document.documentElement.dataset.theme = theme;
    const accent = localStorage.getItem('cb_accent');
    if (accent) document.documentElement.style.setProperty('--accent', accent);
  }, []);
  if (!m.token || !m.user) {
    return <><HostBar /><AuthScreen onLogin={m.login} onRegister={m.register} onDemo={m.demo} on2fa={m.login2fa} /></>;
  }
  return <><HostBar /><Messenger m={m} call={call} /></>;
}

function PinGate({ onUnlock }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    const hash = await sha256(pin);
    if (hash === localStorage.getItem('cb_pin')) onUnlock();
    else setErr('Неверный пин');
  }
  return (
    <div className="lock">
      <form onSubmit={submit} className="modal" style={{ padding: 28, width: 360 }}>
        <img src="./icon-192.png" alt="" width="56" height="56" style={{ borderRadius: 18 }} />
        <h1 style={{ fontFamily: 'Fraunces, serif', marginBottom: 8 }}>Cbopka закрыта</h1>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>Введите пин приложения.</p>
        <input className="field" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
        {err && <div style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</div>}
        <button className="btn ember" style={{ marginTop: 12, width: '100%' }}>Открыть</button>
      </form>
    </div>
  );
}

function OverlayApp() {
  const m = useMessenger();
  const call = useCall(m.socket, m.user);
  const [text, setText] = useState('');
  if (!m.user) return <div style={{ padding: 16 }}>Войдите в основное окно Cbopka.</div>;
  const id = localStorage.getItem('cb_active') || ('saved:' + m.user.id);
  const msgs = (m.messages[id] || []).slice(-6);
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'rgba(12,13,17,.92)', padding: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <b>Оверлей</b>
        <span style={{ color: 'var(--accent-2)', fontSize: 12 }}>{call.call ? 'в голосе' : 'тишина'}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontSize: 13 }}>
        {msgs.map((msg) => <div key={msg.id} style={{ margin: '6px 0' }}><b>{msg.fromId === m.user.id ? 'вы' : '…'}</b> {msg.e2e ? '🔒' : msg.text}</div>)}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); m.send({ convoId: id, text }); setText(''); }} style={{ display: 'flex', gap: 6 }}>
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Быстрый ответ" />
        <button className="send" type="submit">↑</button>
      </form>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn" onClick={() => call.toggleMute()}>{call.muted ? 'Включить микрофон' : 'Мут'}</button>
        <button className="btn" onClick={() => call.setPtt((v) => !v)}>PTT {call.ptt ? 'вкл' : ''}</button>
      </div>
    </div>
  );
}
