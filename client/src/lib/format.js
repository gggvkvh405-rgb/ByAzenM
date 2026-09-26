export function timeShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
export function lastSeen(ts, online) {
  if (online) return 'в сети';
  if (!ts) return 'был(а) давно';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'был(а) только что';
  if (diff < 3600_000) return `был(а) ${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86400_000) return `был(а) в ${timeShort(ts)}`;
  return `был(а) ${new Date(ts).toLocaleDateString('ru-RU')}`;
}
export function dmId(a, b) {
  return 'dm:' + [a, b].sort().join(':');
}
export function bytes(n) {
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
  return (n / 1024 / 1024).toFixed(1) + ' МБ';
}
export function statusColor(status) {
  if (status === 'dnd') return 'dnd';
  if (status === 'idle') return 'idle';
  if (status === 'playing') return 'playing';
  if (status === 'offline') return 'offline';
  return 'online';
}
