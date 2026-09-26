import { useEffect, useState } from 'react';
import { micGranted, openMicSettings, openSoundSettings, requestMic } from '../lib/mic.js';

function MicMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="#1a0d08" />
      <path d="M6 11a6 6 0 0 0 12 0" fill="none" stroke="#1a0d08" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 17v3M9 21h6" fill="none" stroke="#1a0d08" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function MicPrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const show = () => { setErr(''); setOpen(true); };
    if (!micGranted() && sessionStorage.getItem('cb_mic_later') !== '1') {
      const t = setTimeout(show, 500);
      window.addEventListener('cb-mic-request', show);
      return () => { clearTimeout(t); window.removeEventListener('cb-mic-request', show); };
    }
    window.addEventListener('cb-mic-request', show);
    return () => window.removeEventListener('cb-mic-request', show);
  }, []);

  function finish(ok) {
    setOpen(false);
    setBusy(false);
    window.dispatchEvent(new CustomEvent('cb-mic-done', { detail: { ok } }));
  }

  async function allow() {
    setBusy(true);
    setErr('');
    const res = await requestMic();
    setBusy(false);
    if (res.ok) { finish(true); return; }
    setErr(res.error || 'Не удалось получить микрофон');
  }

  function later() {
    sessionStorage.setItem('cb_mic_later', '1');
    finish(false);
  }

  if (!open) return null;
  return (
    <div className="modal-back" style={{ zIndex: 85 }} role="dialog" aria-modal="true" aria-labelledby="mic-title">
      <div className="modal mic-ask" onClick={(e) => e.stopPropagation()}>
        <div className="mic-ask-icon"><MicMark /></div>
        <h2 id="mic-title">Доступ к микрофону</h2>
        <p>Cbopka запрашивает микрофон, чтобы вас было слышно в звонке. Нажмите «Разрешить». Если Windows спросит отдельно — тоже нажмите «Разрешить».</p>
        {err && <p className="mic-ask-err">{err}</p>}
        <div className="mic-ask-actions">
          <button className="btn ember" disabled={busy} onClick={allow}>{busy ? 'Ищем микрофон…' : 'Разрешить'}</button>
          {err && <button className="btn" onClick={() => window.cbopkaAPI?.openRecordingPanel?.()}>Устройства записи</button>}
          {err && <button className="btn" onClick={() => openMicSettings()}>Доступ Windows</button>}
          {err && <button className="btn" onClick={() => openSoundSettings()}>Звук</button>}
          <button className="btn" disabled={busy} onClick={later}>Не сейчас</button>
        </div>
      </div>
    </div>
  );
}
