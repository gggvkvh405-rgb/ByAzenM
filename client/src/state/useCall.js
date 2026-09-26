import { useEffect, useRef, useState } from 'react';
import { origin } from '../lib/api.js';
import { applyNoiseGate, tryRnnoise, screenConstraints, virtualBackgroundTrack, openWebTransport } from '../lib/media.js';
import { chime } from '../lib/sounds.js';
import { reopenMicPrompt, openMicStream } from '../lib/mic.js';
import { createCallRelay, primeAudio } from '../lib/callRelay.js';

export function useCall(socket, me) {
  const pcs = useRef(new Map());
  const localRef = useRef(null);
  const rawRef = useRef(null);
  const iceRef = useRef([]);
  const callRef = useRef(null);
  const recRef = useRef(null);
  const chunks = useRef([]);
  const [call, setCall] = useState(null);
  const [remotes, setRemotes] = useState({});
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [noise, setNoise] = useState(true);
  const [bg, setBg] = useState('none');
  const [hand, setHand] = useState(false);
  const [ptt, setPtt] = useState(false);
  const [pttHeld, setPttHeld] = useState(false);
  const [quality, setQuality] = useState('1080p60');
  const [reactions, setReactions] = useState([]);
  const [peersState, setPeersState] = useState({});
  const [incoming, setIncoming] = useState(null);
  const [stats, setStats] = useState('—');
  const [strokes, setStrokes] = useState([]);
  const [drawOn, setDrawOn] = useState(false);
  const [voiceChannel, setVoiceChannel] = useState(null);
  const [micMissing, setMicMissing] = useState(false);
  const [viaServer, setViaServer] = useState(false);
  const relayRef = useRef(null);
  const mutedRef = useRef(false);

  useEffect(() => { callRef.current = call; }, [call]);

  async function ensureIce() {
    if (iceRef.current.length) return iceRef.current;
    try {
      const token = localStorage.getItem('cb_token');
      const res = await fetch(origin() + '/api/turn', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      iceRef.current = data.iceServers || [];
      if (data.transport?.webtransportUrl) openWebTransport(data.transport.webtransportUrl);
    } catch {
      iceRef.current = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    return iceRef.current;
  }

  async function grabMedia(kind) {
    const video = kind !== 'audio';
    let stream;
    try {
      stream = await openMicStream({ video });
    } catch (e) {
      if (!video) throw e;
      stream = await openMicStream({ video: false });
    }
    rawRef.current = stream;
    if (noise) {
      try { stream = await tryRnnoise(stream); } catch { stream = await applyNoiseGate(stream); }
    }
    if (video && bg !== 'none') {
      const vt = stream.getVideoTracks()[0];
      if (vt) {
        const painted = await virtualBackgroundTrack(vt, bg === 'image' ? 'image' : 'blur');
        stream = new MediaStream([painted, ...stream.getAudioTracks()]);
      }
    }
    localRef.current = stream;
    return stream;
  }

  function makePc(peerId) {
    if (pcs.current.has(peerId)) return pcs.current.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });
    const stream = localRef.current;
    stream?.getTracks().forEach((t) => { if (t.kind !== 'audio') pc.addTrack(t, stream); });
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = callRef.current;
      if (c?.voice) socket.emit('voice:signal', { channelId: c.channelId, toUserId: peerId, data: { candidate: e.candidate } });
      else socket.emit('webrtc:ice', { callId: c?.id, toUserId: peerId, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      setRemotes((r) => ({ ...r, [peerId]: stream }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce?.();
    };
    pcs.current.set(peerId, pc);
    return pc;
  }

  async function createOffer(peerId) {
    const pc = makePc(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const c = callRef.current;
    if (c?.voice) socket.emit('voice:signal', { channelId: c.channelId, toUserId: peerId, data: { offer } });
    else socket.emit('webrtc:offer', { callId: c?.id, toUserId: peerId, offer });
  }

  async function handleSignal(from, data, callId, voice) {
    await ensureIce();
    if (!localRef.current) {
      try { await grabMedia(callRef.current?.type || 'audio'); } catch {}
    }
    const pc = makePc(from);
    if (data.offer) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (voice) socket.emit('voice:signal', { channelId: callId, toUserId: from, data: { answer } });
      else socket.emit('webrtc:answer', { callId, toUserId: from, answer });
    } else if (data.answer) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    } else if (data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
    }
  }

  function relay() {
    if (!relayRef.current && socket) {
      relayRef.current = createCallRelay(socket, () => {
        const c = callRef.current;
        if (!c?.id) return null;
        if (c.voice) return { id: c.channelId, event: 'voice:audio', key: 'channelId' };
        return { id: c.id, event: 'call:audio', key: 'callId' };
      }, () => mutedRef.current);
    }
    return relayRef.current;
  }

  function beginRelay() {
    try {
      primeAudio();
      relay()?.start(localRef.current);
      setViaServer(true);
    } catch {}
  }

  function closePcs() {
    try { relayRef.current?.stop(); } catch {}
    setViaServer(false);
    for (const pc of pcs.current.values()) { try { pc.close(); } catch {} }
    pcs.current.clear();
    localRef.current?.getTracks().forEach((t) => t.stop());
    rawRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    rawRef.current = null;
    setRemotes({});
    setSharing(false);
    setHand(false);
    setStrokes([]);
  }

  useEffect(() => {
    if (!socket || !me) return;
    const onIncoming = (p) => { setIncoming(p); chime('call'); };
    const onAccepted = async ({ callId, userId }) => {
      if (userId === me.id) return;
      setCall((c) => c && c.id === callId ? { ...c, phase: 'active' } : c);
      if (callRef.current?.id === callId) await createOffer(userId);
    };
    const onRejected = () => { setCall(null); setIncoming(null); closePcs(); };
    const onLeft = ({ userId }) => {
      pcs.current.get(userId)?.close();
      pcs.current.delete(userId);
      setRemotes((r) => { const n = { ...r }; delete n[userId]; return n; });
    };
    const onEnded = () => { setCall(null); closePcs(); };
    const onOffer = ({ callId, fromUserId, offer }) => handleSignal(fromUserId, { offer }, callId, false);
    const onAnswer = ({ fromUserId, answer }) => handleSignal(fromUserId, { answer }, null, false);
    const onIce = ({ fromUserId, candidate }) => handleSignal(fromUserId, { candidate }, null, false);
    const onState = (p) => setPeersState((s) => ({ ...s, [p.userId]: { ...(s[p.userId] || {}), ...p } }));
    const onReact = (p) => {
      const id = Math.random().toString(36).slice(2);
      setReactions((r) => [...r, { ...p, id }]);
      setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 1700);
    };
    const onDraw = (p) => setStrokes((s) => [...s.slice(-400), p.stroke]);
    const onVoiceJoined = async ({ channelId, existing }) => {
      await ensureIce();
      if (!localRef.current) {
        try { await grabMedia('audio'); setMicMissing(false); }
        catch { setMicMissing(true); reopenMicPrompt(); }
      }
      const next = { id: channelId, voice: true, channelId, type: 'audio', phase: 'active', startedAt: Date.now() };
      callRef.current = next;
      setCall(next);
      beginRelay();
      setVoiceChannel(channelId);
      for (const id of existing || []) {
        if (id !== me.id) await createOffer(id);
      }
    };
    const onVoiceSignal = ({ fromUserId, channelId, data }) => handleSignal(fromUserId, data, channelId, true);
    const onVoiceState = ({ channelId, peers }) => {
      if (callRef.current?.channelId === channelId || voiceChannel === channelId) {
        const map = {};
        for (const p of peers || []) map[p.userId] = p;
        setPeersState(map);
      }
    };
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:rejected', onRejected);
    socket.on('call:ended', onEnded);
    socket.on('call:peer-left', onLeft);
    socket.on('call:state', onState);
    socket.on('call:reaction', onReact);
    socket.on('draw:stroke', onDraw);
    socket.on('webrtc:offer', onOffer);
    socket.on('webrtc:answer', onAnswer);
    socket.on('webrtc:ice', onIce);
    socket.on('voice:joined', onVoiceJoined);
    socket.on('voice:signal', onVoiceSignal);
    socket.on('voice:state', onVoiceState);
    return () => {
      ['call:incoming','call:accepted','call:rejected','call:ended','call:peer-left','call:state','call:reaction','draw:stroke','webrtc:offer','webrtc:answer','webrtc:ice','voice:joined','voice:signal','voice:state']
        .forEach((e) => socket.off(e));
    };
  }, [socket, me]);

  useEffect(() => {
    if (!call) return;
    const t = setInterval(async () => {
      const pc = [...pcs.current.values()][0];
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let lost = 0, recv = 0;
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') { lost += s.packetsLost || 0; recv += s.packetsReceived || 0; }
        });
        const ratio = recv ? lost / (lost + recv) : 0;
        setStats(ratio < 0.02 ? 'отлично' : ratio < 0.08 ? 'нормально' : 'слабо');
      } catch {}
    }, 2500);
    return () => clearInterval(t);
  }, [call]);

  function releasePreview() {
    localRef.current?.getTracks().forEach((t) => t.stop());
    rawRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    rawRef.current = null;
  }

  async function startCall({ toUserId, channelId, type }) {
    if (!socket?.connected) throw new Error('Нет связи с сервером. Подождите секунду и нажмите ещё раз.');
    if (!toUserId && !channelId) throw new Error('Сначала откройте чат с другом.');
    await ensureIce();
    let used = type === 'audio' ? 'audio' : 'video';
    let micOk = true;
    try {
      await grabMedia(used);
    } catch {
      if (used === 'video') {
        try { await grabMedia('audio'); used = 'audio'; }
        catch { micOk = false; }
      } else micOk = false;
    }
    setMicMissing(!micOk);
    if (!micOk) reopenMicPrompt();
    setCamOff(used === 'audio');
    mutedRef.current = ptt;
    setMuted(ptt);
    if (ptt) localRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
    let ack;
    try {
      ack = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Сервер не ответил на звонок')), 8000);
        socket.emit('call:invite', { toUserId, channelId, type: used, quality }, (res) => {
          clearTimeout(timer);
          if (!res?.ok) reject(new Error(res?.error || 'Звонок не начался'));
          else resolve(res);
        });
      });
    } catch (e) {
      releasePreview();
      throw e;
    }
    const next = { id: ack.callId, toUserId, channelId, type: used, phase: 'ringing', startedAt: Date.now() };
    callRef.current = next;
    setCall(next);
    beginRelay();
    return { type: used, warning: ack.warning || '', micOk };
  }

  async function acceptCall() {
    if (!incoming) throw new Error('Звонок уже завершён');
    if (!socket?.connected) throw new Error('Нет связи с сервером');
    await ensureIce();
    let micOk = true;
    try {
      await grabMedia(incoming.type === 'audio' ? 'audio' : 'video');
    } catch {
      try { await grabMedia('audio'); }
      catch { micOk = false; reopenMicPrompt(); }
    }
    setMicMissing(!micOk);
    const next = { id: incoming.callId, type: incoming.type, phase: 'active', startedAt: Date.now(), peer: incoming.from };
    callRef.current = next;
    setCall(next);
    socket.emit('call:accept', { callId: incoming.callId });
    setIncoming(null);
    beginRelay();
    return { micOk };
  }

  function rejectCall() {
    if (incoming) socket.emit('call:reject', { callId: incoming.callId });
    setIncoming(null);
  }

  function hangup() {
    const c = callRef.current;
    if (c?.voice) socket.emit('voice:leave', { channelId: c.channelId });
    else if (c?.id) socket.emit('call:leave', { callId: c.id });
    if (recording) stopRecording();
    setCall(null);
    setVoiceChannel(null);
    closePcs();
  }

  function joinVoice(channelId) {
    socket.emit('voice:join', { channelId });
  }

  function toggleMute(force) {
    const next = force != null ? force : !muted;
    mutedRef.current = next;
    setMuted(next);
    localRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
    const c = callRef.current;
    if (c?.voice) socket.emit('voice:state', { channelId: c.channelId, muted: next });
    else if (c?.id) socket.emit('call:state', { callId: c.id, muted: next });
  }

  function toggleCam() {
    const next = !camOff;
    setCamOff(next);
    localRef.current?.getVideoTracks().forEach((t) => { t.enabled = !next; });
    const c = callRef.current;
    if (c?.id && !c.voice) socket.emit('call:state', { callId: c.id, video: !next });
  }

  async function shareScreen(preset) {
    const q = preset || quality;
    setQuality(q);
    if (sharing) {
      localRef.current?.getVideoTracks().filter((t) => t.__screen).forEach((t) => t.stop());
      setSharing(false);
      return;
    }
    const display = await navigator.mediaDevices.getDisplayMedia(screenConstraints(q));
    const track = display.getVideoTracks()[0];
    track.__screen = true;
    track.onended = () => setSharing(false);
    for (const pc of pcs.current.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      else pc.addTrack(track, display);
    }
    if (!pcs.current.size) {
      localRef.current = new MediaStream([...(localRef.current?.getAudioTracks() || []), track]);
    }
    setSharing(true);
    const c = callRef.current;
    if (c?.voice) socket.emit('voice:state', { channelId: c.channelId, sharing: true });
    else if (c) socket.emit('call:state', { callId: c.id, sharing: true });
  }

  async function applyQuality(preset) {
    setQuality(preset);
    if (!sharing) return;
    const q = screenConstraints(preset).video;
    const track = [...pcs.current.values()].flatMap((pc) => pc.getSenders()).map((s) => s.track).find((t) => t?.__screen);
    try { await track?.applyConstraints(q); } catch {}
  }

  function raiseHand() {
    const next = !hand;
    setHand(next);
    const c = callRef.current;
    if (c?.voice) socket.emit('voice:state', { channelId: c.channelId, hand: next });
    else if (c) socket.emit('call:state', { callId: c.id, hand: next });
  }

  function sendReaction(emoji) {
    const c = callRef.current;
    if (!c) return;
    socket.emit('call:reaction', { callId: c.id, emoji });
    const id = Math.random().toString(36).slice(2);
    setReactions((r) => [...r, { id, emoji, userId: me?.id }]);
    setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 1700);
  }

  function pushStroke(stroke) {
    setStrokes((s) => [...s.slice(-400), stroke]);
    const c = callRef.current;
    socket.emit('draw:stroke', { callId: c?.id, channelId: c?.channelId, stroke });
  }

  async function toggleRecord() {
    if (recording) return stopRecording();
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const videos = [...document.querySelectorAll('.stage video')];
    let alive = true;
    const draw = () => {
      if (!alive) return;
      ctx.fillStyle = '#07080c';
      ctx.fillRect(0, 0, 1280, 720);
      videos.forEach((v, i) => {
        const cols = Math.max(1, Math.ceil(Math.sqrt(videos.length)));
        const w = 1280 / cols;
        const h = 720 / Math.ceil(videos.length / cols);
        const x = (i % cols) * w;
        const y = Math.floor(i / cols) * h;
        try { ctx.drawImage(v, x + 6, y + 6, w - 12, h - 12); } catch {}
      });
      requestAnimationFrame(draw);
    };
    draw();
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const add = (stream) => {
      if (!stream) return;
      try { audioCtx.createMediaStreamSource(stream).connect(dest); } catch {}
    };
    add(localRef.current);
    Object.values(remotes).forEach(add);
    const mixed = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    const rec = new MediaRecorder(mixed, { mimeType: mime });
    chunks.current = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    rec.onstop = () => {
      alive = false;
      const blob = new Blob(chunks.current, { type: 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `cbopka-call-${Date.now()}.webm`;
      a.click();
      audioCtx.close();
    };
    rec.start(1000);
    recRef.current = rec;
    setRecording(true);
  }
  function stopRecording() {
    try { recRef.current?.stop(); } catch {}
    setRecording(false);
  }

  async function setBackground(mode) {
    setBg(mode);
    const rawVideo = rawRef.current?.getVideoTracks()[0];
    if (!rawVideo || !localRef.current) return;
    let track = rawVideo;
    if (mode !== 'none') track = await virtualBackgroundTrack(rawVideo, mode === 'image' ? 'image' : 'blur');
    for (const pc of pcs.current.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video' && !s.track.__screen);
      if (sender) await sender.replaceTrack(track);
    }
  }

  useEffect(() => {
    if (!ptt) return;
    const down = (e) => {
      if (e.code !== 'KeyV' || e.repeat) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setPttHeld(true);
      toggleMute(false);
    };
    const up = (e) => {
      if (e.code !== 'KeyV') return;
      setPttHeld(false);
      toggleMute(true);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [ptt, muted]);

  useEffect(() => {
    const onGranted = async () => {
      if (!callRef.current) return;
      try {
        await grabMedia(callRef.current.type === 'video' ? 'video' : 'audio');
        setMicMissing(false);
        beginRelay();
      } catch {}
    };
    window.addEventListener('cb-mic-granted', onGranted);
    return () => window.removeEventListener('cb-mic-granted', onGranted);
  }, [socket]);

  return {
    call, setCall, remotes, localStream: localRef, incoming, muted, camOff, sharing, recording, noise, setNoise,
    micMissing, viaServer,
    bg, setBackground, hand, raiseHand, ptt, setPtt, pttHeld, quality, setQuality: applyQuality, reactions,
    peersState, stats, strokes, drawOn, setDrawOn, pushStroke, startCall, acceptCall, rejectCall, hangup,
    joinVoice, toggleMute, toggleCam, shareScreen, toggleRecord, sendReaction, voiceChannel
  };
}
