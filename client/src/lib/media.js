export const QUALITY = {
  '720p30': { width: 1280, height: 720, frameRate: 30, label: '720p · 30' },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, label: '1080p · 30' },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, label: '1080p · 60' },
  '1440p60': { width: 2560, height: 1440, frameRate: 60, label: '1440p · 60' },
  '4k60': { width: 3840, height: 2160, frameRate: 60, label: '4K · 60', nitro: true }
};

export function screenConstraints(preset = '1080p60') {
  const q = QUALITY[preset] || QUALITY['1080p60'];
  return {
    video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } },
    audio: true
  };
}

const WORKLET = `
class CbopkaGate extends AudioWorkletProcessor {
  constructor() { super(); this.gain = 1; this.env = 0; this.hp = 0; }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / Math.max(1, input.length));
    this.env = this.env * 0.9 + rms * 0.1;
    const open = this.env > 0.008;
    const target = open ? 1 : 0.015;
    this.gain += (target - this.gain) * (open ? 0.35 : 0.08);
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.hp = this.hp * 0.97 + x * 0.03;
      output[i] = (x - this.hp) * this.gain;
    }
    return true;
  }
}
registerProcessor('cbopka-gate', CbopkaGate);
`;

let workletUrl;
export async function applyNoiseGate(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return stream;
  try {
    track.applyConstraints({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }).catch(() => {});
  } catch {}
  try {
    const ctx = new AudioContext();
    if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, 'cbopka-gate');
    const dest = ctx.createMediaStreamDestination();
    src.connect(node); node.connect(dest);
    const gated = dest.stream.getAudioTracks()[0];
    const next = new MediaStream([gated, ...stream.getVideoTracks()]);
    next.__cbAudio = { ctx, raw: track };
    return next;
  } catch (e) {
    console.warn('noise gate fallback', e);
    return stream;
  }
}

export async function tryRnnoise(stream) {
  try {
    const mod = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/+esm');
    const wasmRes = await fetch('https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoise.wasm');
    const workletRes = await fetch('https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoiseWorklet.js');
    if (!wasmRes.ok || !workletRes.ok || !mod.RnnoiseWorkletNode) throw new Error('rnnoise assets missing');
    const wasmBinary = await wasmRes.arrayBuffer();
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([await workletRes.text()], { type: 'text/javascript' })));
    const node = new mod.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    const src = ctx.createMediaStreamSource(stream);
    const dest = ctx.createMediaStreamDestination();
    src.connect(node); node.connect(dest);
    return dest.stream;
  } catch (e) {
    console.info('RNNoise недоступен, работаем на шумодаве Cbopka + WebRTC NS', e?.message || e);
    return applyNoiseGate(stream);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export async function virtualBackgroundTrack(videoTrack, mode = 'blur') {
  const video = document.createElement('video');
  video.srcObject = new MediaStream([videoTrack]);
  video.muted = true;
  video.playsInline = true;
  await video.play();
  const w = 640, h = 480;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = w; blurCanvas.height = h;
  const bctx = blurCanvas.getContext('2d');
  let selfie = null;
  let mask = null;
  try {
    if (!window.SelfieSegmentation) {
      const local = './mediapipe/selfie_segmentation.js';
      try { await loadScript(local); } catch { await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js'); }
    }
    const Ctor = window.SelfieSegmentation;
    if (Ctor) {
      selfie = new Ctor({
        locateFile: (file) => {
          if (location.protocol === 'file:') return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
          return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
        }
      });
      selfie.setOptions({ modelSelection: 1, selfieMode: true });
      selfie.onResults((res) => { mask = res.segmentationMask; });
    }
  } catch (e) {
    console.info('MediaPipe фон недоступен, блюр кадра', e?.message || e);
  }
  let running = true;
  const loop = async () => {
    if (!running) return;
    try {
      if (selfie) await selfie.send({ image: video });
      bctx.filter = 'blur(16px)';
      bctx.drawImage(video, 0, 0, w, h);
      bctx.filter = 'none';
      ctx.clearRect(0, 0, w, h);
      if (mode === 'image') {
        ctx.fillStyle = '#1b3a34';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ff6a45';
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.arc(w * 0.8, h * 0.2, 90, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(blurCanvas, 0, 0);
      }
      if (mask) {
        ctx.save();
        ctx.drawImage(mask, 0, 0, w, h);
        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
      } else if (mode !== 'none') {
        ctx.globalAlpha = 0.0;
      }
    } catch {}
    requestAnimationFrame(loop);
  };
  loop();
  const out = canvas.captureStream(24).getVideoTracks()[0];
  const oldStop = out.stop.bind(out);
  out.stop = () => { running = false; try { selfie?.close?.(); } catch {} oldStop(); videoTrack.stop(); };
  return out;
}

export async function waveformPeaks(blob, bars = 36) {
  try {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    const size = Math.floor(data.length / bars);
    const peaks = [];
    for (let i = 0; i < bars; i++) {
      let m = 0;
      for (let j = 0; j < size; j++) m = Math.max(m, Math.abs(data[i * size + j] || 0));
      peaks.push(Math.min(1, m * 1.4));
    }
    ctx.close();
    return peaks;
  } catch {
    return Array.from({ length: bars }, () => 0.2 + Math.random() * 0.8);
  }
}

export async function openWebTransport(url) {
  if (!url || typeof WebTransport === 'undefined') return null;
  try {
    const wt = new WebTransport(url);
    await wt.ready;
    return wt;
  } catch (e) {
    console.info('WebTransport недоступен', e?.message || e);
    return null;
  }
}
