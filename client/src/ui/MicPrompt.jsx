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
  const [note, setNote] = useState('');
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!open || !window.cbopkaAPI?.onNativePcm) return;
    const id = window.cbopkaAPI.onNativePcm((b64) => {
      try {
        const bin = atob(b64);
        let peak = 0;
        for (let i = 0; i + 1 < bin.length; i += 16) {
          const s = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
          const v = s > 32767 ? s - 65536 : s;
          if (Math.abs(v) > peak) peak = Math.abs(v);
        }
        const next = Math.min(100, Math.round((peak / 32768) * 100));
        window.__cbMicLevel = next;
        setLevel(next);
      } catch {}
    });
    return () => window.cbopkaAPI.offNativePcm?.(id);
  }, [open]);

  useEffect(() => {
    const show = () => { setErr(''); setNote(''); setLevel(0); setOpen(true); };
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
    setNote('');
    const res = await requestMic();
    setBusy(false);
    if (res.ok) {
      setNote('Микрофон открыт. Скажите слово — если полоска двигается, вас слышно.');
      const started = Date.now();
      const wait = setInterval(() => {
        const heard = Number(window.__cbMicLevel || 0) > 4;
        if (heard) setNote('Вас слышно. Можно звонить — друг должен нажать «Ответить».');
        if (heard || Date.now() - started > 7000) {
          clearInterval(wait);
          setTimeout(() => finish(true), heard ? 900 : 400);
        }
      }, 200);
      return;
    }
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
        <p>Нажмите «Разрешить». Появится маленькое окно Cbopka — это микрофон, его не закрывайте. Скажите слово: полоска должна сдвинуться. Если Windows спросит доступ — нажмите «Да».</p>
        {note && <p className="mic-ask-ok">{note}</p>}
        {(busy || level > 0) && <div className="mic-level" aria-hidden="true"><span style={{ width: `${level}%` }} /></div>}
        {err && <p className="mic-ask-err">{err}</p>}
        <div className="mic-ask-actions">
          <button className="btn ember" disabled={busy} onClick={allow}>{busy ? 'Открываю микрофон…' : 'Разрешить'}</button>
          {err && <button className="btn" onClick={() => window.cbopkaAPI?.openRecordingPanel?.()}>Устройства записи</button>}
          {err && <button className="btn" onClick={() => openMicSettings()}>Доступ Windows</button>}
          {err && <button className="btn" onClick={() => openSoundSettings()}>Звук</button>}
          <button className="btn" disabled={busy} onClick={later}>Не сейчас</button>
        </div>
      </div>
    </div>
  );
}
