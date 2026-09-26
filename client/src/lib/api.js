export function origin() {
  if (typeof window === 'undefined') return '';
  const forced = window.CBOPKA_SERVER_URL || localStorage.getItem('cb_server_url') || '';
  if (forced) return String(forced).replace(/\/$/, '');
  if (location.protocol === 'file:') return 'http://127.0.0.1:3000';
  return '';
}

export async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(origin() + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'Ошибка');
  return data;
}

export async function uploadFile(token, file) {
  const health = await api('/api/health').catch(() => ({ multer: false }));
  if (health.multer) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(origin() + '/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось загрузить');
    return data.file;
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  const data = await api('/api/upload', { token, method: 'POST', body: { name: file.name, mime: file.type || 'application/octet-stream', data: btoa(binary) } });
  return data.file;
}

export function fileUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('http')) return url;
  return origin() + url;
}

export async function searchGifs(q) {
  const query = encodeURIComponent(q || 'wave');
  const tries = [
    `https://tenor.googleapis.com/v2/search?q=${query}&key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&client_key=cbopka&limit=18&media_filter=tinygif,gif`,
    `https://g.tenor.com/v1/search?q=${query}&key=LIVDSRZULELA&limit=18`
  ];
  for (const url of tries) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const results = data.results || [];
      const mapped = results.map((r) => {
        const gif = r.media_formats?.gif?.url || r.media?.[0]?.gif?.url;
        const preview = r.media_formats?.tinygif?.url || r.media?.[0]?.tinygif?.url || gif;
        return gif ? { url: gif, preview } : null;
      }).filter(Boolean);
      if (mapped.length) return mapped;
    } catch {}
  }
  return [];
}
