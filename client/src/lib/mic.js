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

export async function requestMic() {
  const api = window.cbopkaAPI;
  if (api?.askMicrophone) {
    const native = await api.askMicrophone();
    if (!native?.ok) {
      localStorage.setItem(KEY, 'denied');
      return {
        ok: false,
        denied: true,
        settings: !!api.openMicSettings,
        error: native.error || 'Доступ к микрофону не дан'
      };
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: 'Здесь нельзя запросить микрофон' };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    stream.getTracks().forEach((t) => t.stop());
    localStorage.setItem(KEY, 'granted');
    return { ok: true };
  } catch (e) {
    localStorage.setItem(KEY, 'denied');
    try { await api?.resetMicrophone?.(); } catch {}
    const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError' || e?.name === 'PermissionDeniedError';
    if (denied && api?.openMicSettings) {
      try { await api.openMicSettings(); } catch {}
    }
    return {
      ok: false,
      denied,
      settings: !!api?.openMicSettings,
      error: denied
        ? (api
          ? 'Windows не отдала микрофон. Включите «Разрешить классическим приложениям доступ к микрофону» и нажмите «Разрешить» ещё раз.'
          : 'Браузер запретил микрофон. Нажмите замок слева от адреса и разрешите его, затем «Разрешить» ещё раз.')
        : 'Микрофон не найден или занят другой программой.'
    };
  }
}

export function openMicSettings() {
  return window.cbopkaAPI?.openMicSettings?.();
}
