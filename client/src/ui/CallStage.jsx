import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { QUALITY } from '../lib/media.js';

function Tile({ stream, name, self, hand, muted, sharing }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && stream) ref.current.srcObject = stream; }, [stream]);
  return (
    <div className="tile">
      {stream ? <video ref={ref} autoPlay playsInline muted={self} /> : <div style={{ fontSize: 42 }}>{(name || '?')[0]}</div>}
      <div className="cap">
        {hand && <span>✋</span>}
        {muted && <Icon name="micOff" size={12} />}
        {sharing && <span>экран</span>}
        <span>{name}{self ? ' · вы' : ''}</span>
      </div>
    </div>
  );
}

export default function CallStage({ call, me, localStream, remotes, peersState, muted, camOff, sharing, recording, hand, ptt, pttHeld, quality, stats, reactions, strokes, drawOn, onMute, onCam, onShare, onQuality, onRecord, onHand, onPtt, onReact, onHangup, onDrawToggle, onStroke, onBg, bg, noise, onNoise, micMissing, viaServer }) {
  const [menu, setMenu] = useState(null);
  const [outLevel, setOutLevel] = useState(0);
  const canvasRef = useRef(null);
  useEffect(() => {
    const onLevel = (e) => setOutLevel(Number(e.detail) || 0);
    window.addEventListener('cb-out-level', onLevel);
    return () => window.removeEventListener('cb-out-level', onLevel);
  }, []);
  const drawing = useRef(false);
  const last = useRef(null);
  const local = localStream?.current;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const resize = () => { c.width = c.clientWidth; c.height = c.clientHeight; };
    resize();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ff6a45';
    ctx.lineWidth = 3;
    for (const s of strokes) {
      ctx.beginPath();
      ctx.moveTo(s.x * c.width, s.y * c.height);
      ctx.lineTo(s.px * c.width, s.py * c.height);
      ctx.stroke();
    }
  }, [strokes]);

  function pos(e) {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  function down(e) {
    if (!drawOn) return;
    drawing.current = true;
    last.current = pos(e);
  }
  function move(e) {
    if (!drawing.current || !drawOn) return;
    const p = pos(e);
    onStroke({ ...p, px: last.current.x, py: last.current.y, color: '#ff6a45' });
    last.current = p;
  }

  const tiles = [
    { id: me?.id || 'me', name: me?.username || 'Вы', stream: local, self: true, hand, muted, sharing },
    ...Object.entries(remotes).map(([id, stream]) => ({
      id, stream, name: peersState[id]?.user?.username || 'Участник', self: false,
      hand: peersState[id]?.hand, muted: peersState[id]?.muted, sharing: peersState[id]?.sharing
    }))
  ];
  const secs = Math.floor((Date.now() - (call.startedAt || Date.now())) / 1000);
  const clock = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="stage">
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 18px', color: '#d9d3c8' }}>
        <div>{call.voice ? 'Голосовой канал' : call.type === 'audio' ? 'Голосовой звонок' : 'Видеозвонок'} · {clock} · {viaServer ? 'голос через сервер' : stats}</div>
        <div style={{ color: '#8d877e', fontSize: 13 }}>{ptt ? (pttHeld ? 'PTT: говорите' : 'PTT: удерживайте V') : (outLevel > 4 ? 'вас слышно' : 'открытый микрофон')}{noise ? ' · шумодав' : ''}</div>
      </div>
      {call.phase === 'ringing' && <div className="call-fail">Ждём, пока друг нажмёт «Ответить». Он должен быть на вашей ссылке и в этом чате.</div>}
      {micMissing && <div className="call-fail">Микрофон не открыт. Нажмите «Разрешить» в окне доступа, иначе вас не слышно.</div>}
      <div className="stage-grid" style={{ position: 'relative' }}>
        {tiles.map((t) => <Tile key={t.id} {...t} />)}
        <canvas ref={canvasRef} className="draw-layer" style={{ pointerEvents: drawOn ? 'auto' : 'none' }} onMouseDown={down} onMouseMove={move} onMouseUp={() => { drawing.current = false; }} />
        {reactions.map((r) => <div key={r.id} className="float-emoji" style={{ left: `${20 + (r.id.charCodeAt(0) % 60)}%` }}>{r.emoji}</div>)}
      </div>
      <div className="dock">
        <button className={muted ? 'on' : ''} onClick={onMute} title="Микрофон"><Icon name={muted ? 'micOff' : 'mic'} /></button>
        <button className={camOff ? 'on' : ''} onClick={onCam} title="Камера"><Icon name={camOff ? 'camOff' : 'cam'} /></button>
        <button className={sharing ? 'on' : ''} onClick={() => setMenu(menu === 'q' ? null : 'q')} title="Экран"><Icon name="screen" /></button>
        <button className={recording ? 'on' : ''} onClick={onRecord} title="Запись">{recording ? '●' : '○'}</button>
        <button className={hand ? 'on' : ''} onClick={onHand} title="Рука"><Icon name="hand" /></button>
        <button className={drawOn ? 'on' : ''} onClick={onDrawToggle} title="Рисовать">✎</button>
        <button className={ptt ? 'on' : ''} onClick={onPtt} title="Push-to-talk">V</button>
        <button onClick={() => setMenu(menu === 'r' ? null : 'r')} title="Реакция">😀</button>
        <button onClick={() => setMenu(menu === 'b' ? null : 'b')} title="Фон">BG</button>
        <button className="end" onClick={onHangup}>Завершить</button>
      </div>
      {menu === 'q' && (
        <div className="modal" style={{ position: 'absolute', bottom: 88, left: '50%', transform: 'translateX(-50%)', padding: 10, width: 280 }}>
          {Object.entries(QUALITY).map(([k, v]) => (
            <button key={k} className="row" onClick={() => { onQuality(k); onShare(k); setMenu(null); }}>
              <span>{v.label}{v.nitro ? ' · Nitro' : ''}</span>
              {quality === k && <Icon name="check" size={14} />}
            </button>
          ))}
          <button className="row" onClick={() => { onShare(quality); setMenu(null); }}>{sharing ? 'Остановить экран' : 'Показать экран'}</button>
        </div>
      )}
      {menu === 'r' && (
        <div className="modal" style={{ position: 'absolute', bottom: 88, left: '50%', transform: 'translateX(-50%)', padding: 8, display: 'flex', gap: 6 }}>
          {['❤️', '👍', '😂', '🔥', '👏', '🎉'].map((e) => <button key={e} className="icon-btn" onClick={() => { onReact(e); setMenu(null); }} style={{ fontSize: 22 }}>{e}</button>)}
        </div>
      )}
      {menu === 'b' && (
        <div className="modal" style={{ position: 'absolute', bottom: 88, left: '50%', transform: 'translateX(-50%)', padding: 8, width: 240 }}>
          <button className="row" onClick={() => onBg('none')}>Без фона {bg === 'none' && '·'}</button>
          <button className="row" onClick={() => onBg('blur')}>Блюр · MediaPipe</button>
          <button className="row" onClick={() => onBg('image')}>Цветной фон</button>
          <button className="row" onClick={() => onNoise?.(!noise)}>Шумодав {noise ? 'вкл' : 'выкл'}</button>
        </div>
      )}
    </div>
  );
}
