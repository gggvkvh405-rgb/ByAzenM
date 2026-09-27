const KEY = 'cb_mic';

export function micGranted() {
  return localStorage.getItem(KEY) === 'granted';
}

export function ensureMic() {
  if (micGranted()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onDone = (e) => {
      window.removeEventListener('cb-mic-done', onDone);
      resolve(!!e.detail?.ok);
    };
    window.addEventListener('cb-mic-done', onDone);
    window.dispatchEvent(new Event('cb-mic-request'));
  });
}

export function reopenMicPrompt() {
  try { localStorage.removeItem(KEY); } catch {}
  try { window.cbopkaAPI?.resetMicrophone?.(); } catch {}
  window.dispatchEvent(new Event('cb-mic-request'));
}

export function openMicSettings() {
  return window.cbopkaAPI?.openMicSettings?.() || false;
}

export function openSoundSettings() {
  return window.cbopkaAPI?.openSoundSettings?.() || false;
}

async function audioInputs() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

function release(stream) {
  stream?.getTracks?.().forEach((t) => { try { t.stop(); } catch {} });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryOnce(constraints) {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  if (stream.getAudioTracks().length) return stream;
  release(stream);
  const err = new Error('no-audio');
  err.name = 'NotFoundError';
  throw err;
}

function placeholderStream() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    const stream = dest.stream;
    stream.cbNative = true;
    stream.__cbCtx = ctx;
    return stream;
  } catch {
    const stream = new MediaStream();
    stream.cbNative = true;
    return stream;
  }
}

let nativeState = 'unknown';

async function openWindowsMic() {
  const api = window.cbopkaAPI;
  if (!api?.startNativeMic || api.platform !== 'win32') return null;
  const n = await api.startNativeMic();
  if (n?.ok) {
    nativeState = 'ok';
    window.__cbNativeMic = true;
    return n;
  }
  window.__cbNativeMic = false;
  return n || null;
}

async function openAudio(extra = false) {
  const plain = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const attempts = [
    { audio: true, video: false },
    { audio: plain, video: false }
  ];
  if (extra) attempts.unshift({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  let last;
  for (const constraints of attempts) {
    try {
      return await tryOnce(constraints);
    } catch (e) {
      last = e;
      await wait(700);
    }
  }
  if (last) throw last;
  const err = new Error('no-mic');
  err.name = 'NotFoundError';
  throw err;
}

function explain(e, inputs, osNames, nativeFail) {
  const name = e?.name || '';
  const denied = name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
  const missing = name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError' || name === 'no-mic';
  const busy = name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError';
  const seen = inputs.map((d) => d.label).filter(Boolean);
  const os = (osNames || []).filter((n) => /mic|microphone|headset|headphone|гарнитур|микрофон|наушник/i.test(n));
  const nativeCode = String(nativeFail?.code || '').toUpperCase();
  const privacyBlock = nativeCode === '80070005' || nativeCode === '5';
  if (denied || privacyBlock) {
    return {
      denied: true,
      settings: 'privacy',
      error: window.cbopkaAPI
        ? 'Windows запретила микрофон. В открывшихся настройках включите доступ для классических приложений и нажмите «Разрешить» ещё раз.'
        : 'Браузер запретил микрофон. Нажмите замок слева от адреса, выберите «Разрешить» и нажмите кнопку ещё раз.'
    };
  }
  if (busy || nativeFail) {
    const names = seen.length ? ` Видит: ${seen.slice(0, 2).join(', ')}.` : '';
    const extra = nativeFail?.error ? ` ${nativeFail.error}.` : '';
    const compile = /не собрался/.test(nativeFail?.error || '');
    const who = nativeFail?.holder
      ? ` Сейчас микрофон может держать ${nativeFail.holder}. Закройте эту программу и нажмите «Разрешить» ещё раз.`
      : ' Если открыты игра, Discord или Voicemod — закройте их и нажмите «Разрешить» ещё раз.';
    return {
      denied: false,
      settings: 'none',
      error: compile
        ? `Микрофон на месте, но запасной захват не запустился.${names} Закройте программу полностью, включая трей, и откройте её ещё раз.`
        : `Микрофон виден, но Windows его не открыла.${names}${extra}${who}`
    };
  }
  if (missing || !inputs.length) {
    const where = os.length ? ` Windows видит: ${os.slice(0, 3).join(', ')}.` : (seen.length ? ` Браузер видит: ${seen.slice(0, 3).join(', ')}.` : '');
    return {
      denied: false,
      settings: os.length || seen.length ? 'sound' : 'privacy',
      error: `Микрофон не найден.${where} Откройте настройки звука и в разделе «Ввод» включите микрофон. Если списка нет — подключите гарнитуру и включите доступ к микрофону для классических приложений.`
    };
  }
  return {
    denied: false,
    settings: 'sound',
    error: 'Не удалось открыть микрофон. Проверьте, что он выбран в «Параметры → Система → Звук → Ввод», и нажмите «Разрешить» ещё раз.'
  };
}

function friendlyLabel(inputs, fallback) {
  const label = (inputs || []).map((d) => d.label).find((l) => l && /mic|microphone|headset|микрофон|гарнитур/i.test(l) && !/virtual|voicemod|stereo mix/i.test(l));
  return label || fallback || 'микрофон Windows';
}

export function wavFromPcm16(chunksB64, rate = 16000) {
  const parts = (chunksB64 || []).map((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  });
  const len = parts.reduce((n, p) => n + p.length, 0);
  const data = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { data.set(p, o); o += p.length; }
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + len, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, len, true);
  return new Blob([header, data], { type: 'audio/wav' });
}

export async function requestMic() {
  nativeState = 'unknown';
  const api = window.cbopkaAPI;
  if (api?.askMicrophone) {
    const gate = await api.askMicrophone();
    if (!gate?.ok) {
      localStorage.setItem(KEY, 'denied');
      return { ok: false, denied: true, settings: 'privacy', error: gate.error || 'Доступ к микрофону не дан' };
    }
  }
  try { await api?.unlockMicrophone?.(); } catch {}
  const native = await openWindowsMic();
  if (!native?.ok && native) await wait(400);
  if (native?.ok) {
    const inputs = await audioInputs();
    localStorage.setItem(KEY, 'granted');
    try { window.dispatchEvent(new Event('cb-mic-granted')); } catch {}
    return { ok: true, device: friendlyLabel(inputs, native.device), via: 'windows' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: native?.error || 'Здесь нельзя запросить микрофон' };
  }
  let last;
  try {
    const stream = await openAudio(false);
    stream.getTracks().forEach((t) => t.stop());
    window.__cbNativeMic = false;
    localStorage.setItem(KEY, 'granted');
    try { window.dispatchEvent(new Event('cb-mic-granted')); } catch {}
    return { ok: true };
  } catch (e) {
    last = e;
  }
  localStorage.setItem(KEY, 'denied');
  try { await api?.resetMicrophone?.(); } catch {}
  const inputs = await audioInputs();
  let osNames = [];
  try { osNames = (await api?.listMics?.())?.names || []; } catch {}
  const info = explain(last, inputs, osNames, native);
  if (api?.openMicSettings && (info.settings === 'privacy' || info.denied)) {
    try { await api.openMicSettings(); } catch {}
  } else if (api?.openSoundSettings && info.settings === 'sound') {
    try { await api.openSoundSettings(); } catch {}
  }
  return { ok: false, ...info, devices: inputs.map((d) => d.label).filter(Boolean), osNames };
}

export async function openMicStream({ video = false } = {}) {
  if (!video) {
    const native = await openWindowsMic();
    if (native?.ok) return placeholderStream();
  }
  try {
    const stream = await openAudio(video);
    if (!video) window.__cbNativeMic = false;
    return stream;
  } catch (e) {
    if (!video) throw e;
    const native = await openWindowsMic();
    if (native?.ok) return placeholderStream();
    throw e;
  }
}
