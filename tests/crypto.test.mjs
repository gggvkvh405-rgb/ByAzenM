import test from 'node:test';
import assert from 'node:assert/strict';

// WebCrypto round-trip of the same construction the client uses.
test('ephemeral ECDH roundtrip', async () => {
  const bob = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bobPub = await crypto.subtle.exportKey('jwk', bob.publicKey);
  const ephPub = await crypto.subtle.exportKey('jwk', eph.publicKey);
  async function bits(priv, jwk) {
    const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  }
  const s1 = await bits(eph.privateKey, bobPub);
  const s2 = await bits(bob.privateKey, ephPub);
  assert.deepEqual(s1, s2);
  const key = await crypto.subtle.importKey('raw', s1, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('секрет'));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  assert.equal(new TextDecoder().decode(pt), 'секрет');
});
