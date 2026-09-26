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

async function openAudio(extra = false) {
  const inputs = await audioInputs();
  const attempts = [
    { audio: true, video: extra || false },
    { audio: true, video: false },
    { audio: { deviceId: 'default' }, video: false },
    { audio: { deviceId: 'communications' }, video: false }
  ];
  for (const d of inputs) {
    if (d.deviceId) attempts.push({ audio: { deviceId: { ideal: d.deviceId } }, video: false });
  }
  let last;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream.getAudioTracks().length) return stream;
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      last = e;
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
    return {
      denied: false,
      settings: 'sound',
      error: 'Микрофон занят другой программой. Закройте Discord, Zoom или браузер с звонком и нажмите «Разрешить» ещё раз.'
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
  if (api?.openSoundSettings && info.settings === 'sound') {
    try { await api.openSoundSettings(); } catch {}
  }
  return { ok: false, ...info, devices: inputs.map((d) => d.label).filter(Boolean), osNames };
}

export async function openMicStream({ video = false } = {}) {
  return openAudio(video);
}
