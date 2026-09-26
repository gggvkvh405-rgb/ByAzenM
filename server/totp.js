import crypto from 'crypto';

const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(len = 20) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPH[b % 32];
  return out;
}

export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = '';
  for (const c of clean) {
    const v = ALPH.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, time = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(time / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export function verifyTotp(secret, code, window = 1) {
  if (!secret || !code) return false;
  const want = String(code).replace(/\s/g, '');
  const now = Date.now();
  for (let w = -window; w <= window; w++) {
    if (totp(secret, now + w * 30000) === want) return true;
  }
  return false;
}

export function otpauthUrl(secret, username, issuer = 'Cbopka') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
