/**
 * E2E для личных чатов в духе Signal:
 * долговременный identity-ключ (X3DH-роль IK) + эфемерный ECDH на каждое сообщение + AES-GCM.
 * Сервер хранит только ciphertext. Это не байт-совместимый libsignal (нет prekey-сервера Sesame),
 * но даёт ту же практическую гарантию: сервер не читает текст, у каждого сообщения свой эфемерный ключ.
 */
const STORE = 'cb_identity_v2';

function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function ub64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function importPub(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
async function importPriv(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function loadIdentity() {
  const raw = localStorage.getItem(STORE);
  if (raw) {
    const j = JSON.parse(raw);
    return { pubJwk: j.pub, prekeyJwk: j.pre || j.pub, priv: await importPriv(j.priv) };
  }
  const ik = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const spk = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const priv = await crypto.subtle.exportKey('jwk', ik.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', ik.publicKey);
  const pre = await crypto.subtle.exportKey('jwk', spk.publicKey);
  localStorage.setItem(STORE, JSON.stringify({ priv, pub, pre }));
  return { pubJwk: pub, prekeyJwk: pre, priv: ik.privateKey };
}

async function sharedBits(priv, pubJwk) {
  const pub = await importPub(pubJwk);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

export async function encryptDm(_peerId, theirBundle, plaintext) {
  const me = await loadIdentity();
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const secret = await sharedBits(eph.privateKey, theirBundle.identityPub);
  const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const ephPub = await crypto.subtle.exportKey('jwk', eph.publicKey);
  return { v: 2, proto: 'signal-style-ecdh', eph: ephPub, ik: me.pubJwk, iv: b64(iv), ct: b64(ct) };
}

export async function decryptDm(_peerId, payload) {
  const me = await loadIdentity();
  const secret = await sharedBits(me.priv, payload.eph);
  const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(payload.iv) }, key, ub64(payload.ct));
  return new TextDecoder().decode(pt);
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
