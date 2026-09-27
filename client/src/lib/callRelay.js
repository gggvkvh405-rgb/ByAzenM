let shared;

export function primeAudio() {
  try {
    if (!shared || shared.state === 'closed') shared = new AudioContext();
    shared.resume().catch(() => {});
  } catch {}
  return shared;
}

function downsample(input, inRate, outRate) {
  if (!input.length || inRate === outRate) return input;
  const ratio = inRate / outRate;
  const len = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) { sum += input[j]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function pcmPeak(b64) {
  try {
    const bin = atob(b64);
    let peak = 0;
    for (let i = 0; i + 1 < bin.length; i += 24) {
      const s = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
      const v = s > 32767 ? s - 65536 : s;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    return Math.min(100, Math.round((peak / 32768) * 100));
  } catch {
    return 0;
  }
}

function toB64(pcm) {
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function createCallRelay(socket, getMeta, isMuted) {
  let proc = null;
  let source = null;
  let silent = null;
  let next = 0;
  let alive = false;

  function play(b64) {
    const audio = primeAudio();
    if (!audio) return;
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    const pcm = fromB64(b64);
    if (!pcm.length) return;
    const buf = audio.createBuffer(1, pcm.length, 16000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = audio.createBufferSource();
    src.buffer = buf;
    src.connect(audio.destination);
    const now = audio.currentTime;
    if (next < now + 0.02) next = now + 0.05;
    if (next > now + 0.5) next = now + 0.05;
    src.start(next);
    next += buf.duration;
  }

  function onAudio(msg) {
    const meta = getMeta();
    if (!meta || !msg?.chunk || msg[meta.key] !== meta.id) return;
    play(msg.chunk);
  }

  function stopCapture() {
    try { proc?.disconnect(); } catch {}
    try { source?.disconnect(); } catch {}
    try { silent?.disconnect(); } catch {}
    proc = null;
    source = null;
    silent = null;
  }

  let pcmId = 0;

  function start(stream) {
    stopCapture();
    if (pcmId) { try { window.cbopkaAPI?.offNativePcm?.(pcmId); } catch {} pcmId = 0; }
    alive = true;
    socket.off('call:audio', onAudio);
    socket.off('voice:audio', onAudio);
    socket.on('call:audio', onAudio);
    socket.on('voice:audio', onAudio);
    primeAudio();
    if (window.__cbNativeMic || stream?.cbNative) {
      pcmId = window.cbopkaAPI?.onNativePcm?.((b64) => {
        if (!alive || isMuted() || !b64) return;
        const meta = getMeta();
        if (!meta?.id) return;
        socket.emit(meta.event, { [meta.key]: meta.id, chunk: b64 });
        try { window.dispatchEvent(new CustomEvent('cb-out-level', { detail: pcmPeak(b64) })); } catch {}
      }) || 0;
      return;
    }
    const audio = primeAudio();
    const track = stream?.getAudioTracks?.().find((t) => t.readyState === 'live');
    if (!audio || !track) return;
    source = audio.createMediaStreamSource(new MediaStream([track]));
    proc = audio.createScriptProcessor(4096, 1, 1);
    silent = audio.createGain();
    silent.gain.value = 0;
    source.connect(proc);
    proc.connect(silent);
    silent.connect(audio.destination);
    proc.onaudioprocess = (e) => {
      if (!alive || isMuted()) return;
      const meta = getMeta();
      if (!meta?.id) return;
      const input = e.inputBuffer.getChannelData(0);
      const down = downsample(input, audio.sampleRate, 16000);
      const pcm = new Int16Array(down.length);
      for (let i = 0; i < down.length; i++) {
        const s = Math.max(-1, Math.min(1, down[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      socket.emit(meta.event, { [meta.key]: meta.id, chunk: toB64(pcm) });
    };
  }

  function stop() {
    alive = false;
    if (pcmId) { try { window.cbopkaAPI?.offNativePcm?.(pcmId); } catch {} pcmId = 0; }
    socket.off('call:audio', onAudio);
    socket.off('voice:audio', onAudio);
    stopCapture();
    next = 0;
  }

  return { start, stop };
}
