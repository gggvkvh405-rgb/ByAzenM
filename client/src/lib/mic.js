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

async function openAudio(extra = false) {
  const inputs = await audioInputs();
  const virtual = /virtual|steam|obs|stereo mix|cable|blackhole|vb-audio|nvidia broadcast/i;
  const real = inputs.filter((d) => d.deviceId && !virtual.test(d.label || ''));
  const rest = inputs.filter((d) => d.deviceId && !real.includes(d));
  const plain = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const attempts = [{ audio: plain, video: false }];
  for (const d of [...real, ...rest]) {
    attempts.push({ audio: { ...plain, deviceId: { exact: d.deviceId } }, video: false });
  }
  attempts.push({ audio: true, video: false });
  if (extra) attempts.push({ audio: plain, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  let last;
  for (const constraints of attempts) {
    try {
      return await tryOnce(constraints);
    } catch (e) {
      last = e;
      await wait(500);
    }
  }
  if (last) throw last;
  const err = new Error('no-mic');
  err.name = 'NotFoundError';
  throw err;
}

function explain(e, inputs, osNames) {
  const name = e?.name || '';
  const denied = name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
  const missing = name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError' || name === 'no-mic';
  const busy = name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError';
  const seen = inputs.map((d) => d.label).filter(Boolean);
  const os = (osNames || []).filter((n) => /mic|microphone|headset|headphone|гарнитур|микрофон|наушник/i.test(n));
  if (denied) {
    return {
      denied: true,
      settings: 'privacy',
      error: window.cbopkaAPI
        ? 'Windows запретила микрофон. В открывшихся настройках включите доступ для классических приложений и нажмите «Разрешить» ещё раз.'
        : 'Браузер запретил микрофон. Нажмите замок слева от адреса, выберите «Разрешить» и нажмите кнопку ещё раз.'
    };
  }
  if (busy) {
    const names = seen.length ? ` Видит: ${seen.slice(0, 3).join(', ')}.` : '';
    return {
      denied: false,
      settings: 'recording',
      error: `Windows не открыла микрофон.${names} Сейчас откроется список записи. Выберите микрофон, нажмите «По умолчанию», затем «Свойства → Дополнительно» и снимите обе галочки «Монопольный режим». Если микрофон реально занят Discord или Zoom — закройте их и нажмите «Разрешить» ещё раз.`
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

export async function requestMic() {
  const api = window.cbopkaAPI;
  if (api?.askMicrophone) {
    const native = await api.askMicrophone();
    if (!native?.ok) {
      localStorage.setItem(KEY, 'denied');
      return { ok: false, denied: true, settings: 'privacy', error: native.error || 'Доступ к микрофону не дан' };
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: 'Здесь нельзя запросить микрофон' };
  }
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const stream = await openAudio(false);
    stream.getTracks().forEach((t) => t.stop());
    localStorage.setItem(KEY, 'granted');
    try { window.dispatchEvent(new Event('cb-mic-granted')); } catch {}
    return { ok: true };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  localStorage.setItem(KEY, 'denied');
  try { await api?.resetMicrophone?.(); } catch {}
  const inputs = await audioInputs();
  let osNames = [];
  try { osNames = (await api?.listMics?.())?.names || []; } catch {}
  const info = explain(last, inputs, osNames);
  if (api?.openMicSettings && (info.settings === 'privacy' || info.denied || !inputs.length)) {
    try { await api.openMicSettings(); } catch {}
  }
  if (api?.openRecordingPanel && info.settings === 'recording') {
    try { await api.openRecordingPanel(); } catch {}
  } else if (api?.openSoundSettings && info.settings === 'sound') {
    try { await api.openSoundSettings(); } catch {}
  }
  return { ok: false, ...info, devices: inputs.map((d) => d.label).filter(Boolean), osNames };
}

export async function openMicStream({ video = false } = {}) {
  return openAudio(video);
}
