import { useEffect, useState } from 'react';
import Icon from './icons.jsx';
import { micGranted, openMicSettings, requestMic } from '../lib/mic.js';

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
        <div className="mic-ask-icon"><Icon name="mic" size={28} /></div>
        <h2 id="mic-title">Доступ к микрофону</h2>
        <p>Cbopka запрашивает микрофон, чтобы вас было слышно в звонке. Нажмите «Разрешить» и подтвердите запрос Windows или браузера.</p>
        {err && <p className="mic-ask-err">{err}</p>}
        <div className="mic-ask-actions">
          <button className="btn ember" disabled={busy} onClick={allow}>{busy ? 'Запрашиваем…' : 'Разрешить'}</button>
          {err && <button className="btn" onClick={() => openMicSettings()}>Открыть настройки</button>}
          <button className="btn" disabled={busy} onClick={later}>Не сейчас</button>
        </div>
      </div>
    </div>
  );
}
