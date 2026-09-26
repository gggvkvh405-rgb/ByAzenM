let ctx;
function ac() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function soundsOn() {
  return localStorage.getItem('cb_sounds') !== '0';
}
export function setSounds(on) {
  localStorage.setItem('cb_sounds', on ? '1' : '0');
}
export function chime(kind = 'message') {
  if (!soundsOn()) return;
  try {
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.connect(g); g.connect(c.destination);
    const now = c.currentTime;
    const notes = kind === 'call' ? [523, 659, 784] : kind === 'mention' ? [880, 1175] : [660, 880];
    o.type = 'sine';
    notes.forEach((f, i) => o.frequency.setValueAtTime(f, now + i * 0.09));
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(kind === 'call' ? 0.07 : 0.05, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18 + notes.length * 0.08);
    o.start(now);
    o.stop(now + 0.4 + notes.length * 0.05);
  } catch {}
}
