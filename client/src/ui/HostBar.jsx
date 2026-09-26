import { useEffect, useState } from 'react';
import { origin } from '../lib/api.js';

export default function HostBar() {
  const [info, setInfo] = useState({ url: '', status: '' });
  const [join, setJoin] = useState(false);
  const [remote, setRemote] = useState('');
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch((origin() || '') + '/api/host');
        const data = await res.json();
        if (!stop) setInfo({ url: data.url || '', status: data.status || '' });
      } catch {}
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  if (hidden) return null;
  if (!info.url && !info.status) return null;

  async function copy() {
    try { await navigator.clipboard.writeText(info.url); setCopied(true); } catch {}
  }

  async function joinServer(e) {
    e.preventDefault();
    const url = remote.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) return;
    localStorage.setItem('cb_server_url', url);
    try { await window.cbopkaAPI?.setServerUrl?.(url); } catch {}
    location.href = url;
  }

  return (
    <div className="hostbar">
      <div style={{ fontWeight: 680, marginBottom: 4 }}>
        {local ? 'Хост для звонка другу' : 'Ты на общем сервере'}
      </div>
      {info.url ? (
        <>
          <div className="host-url">{info.url}</div>
          <p>
            {local
              ? 'Ссылка новая, пока эта программа открыта. Отправь её другу — пусть откроет в браузере и зарегистрируется со своим ником. Потом добавь его через «+» и нажми трубку. Или оба зайдите в группу Cbopka HQ → «Голосовой зал».'
              : 'Зарегистрируйся со своим ником. Хозяин сервера добавит тебя в друзья и позвонит. Можно сразу зайти в «Голосовой зал».'}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {local && <button className="btn ember" onClick={copy}>{copied ? 'Скопировано' : 'Скопировать ссылку'}</button>}
            <button className="btn" onClick={() => setHidden(true)}>Скрыть</button>
            {local && <button className="btn" onClick={() => setJoin((v) => !v)}>Зайти на сервер друга</button>}
          </div>
        </>
      ) : (
        <p style={{ margin: 0 }}>{info.status || 'Открываем адрес…'}</p>
      )}
      {join && (
        <form onSubmit={joinServer} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input className="field" value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="https://….trycloudflare.com" />
          <button className="btn ember">Открыть</button>
        </form>
      )}
    </div>
  );
}
