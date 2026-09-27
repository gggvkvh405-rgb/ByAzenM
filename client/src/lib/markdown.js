function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function highlight(code) {
  return esc(code)
    .replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g, '<span class="str">$1</span>')
    .replace(/\b(const|let|var|function|return|if|else|import|export|from|class|async|await|def|for|while|in|of|true|false|null|None|self|new|try|catch)\b/g, '<span class="kw">$1</span>');
}

export function renderMarkdown(src) {
  const fences = [];
  let text = String(src || '').replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    fences.push(`<pre class="code"><code>${highlight(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000F${i}\u0000`;
  });
  text = esc(text);
  text = text.replace(/`([^`]+)`/g, '<code class="code" style="display:inline;padding:1px 5px">$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" style="color:var(--accent)">$1</a>');
  text = text.replace(/(^|\n)&gt; (.+)/g, '$1<blockquote style="border-left:2px solid var(--accent);margin:4px 0;padding-left:8px;color:var(--muted)">$2</blockquote>');
  text = text.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[Number(i)] || '');
  return text.replace(/\n/g, '<br/>');
}

export const COMMANDS = [
  { cmd: '/help', hint: 'что умеет бот' },
  { cmd: '/gif ', hint: 'гифка из Tenor' },
  { cmd: '/poll ', hint: 'вопрос | да | нет' },
  { cmd: '/me ', hint: 'действие от вашего имени' },
  { cmd: '/shrug', hint: '¯\\_(ツ)_/¯' },
  { cmd: '/status ', hint: 'кастомный статус' },
  { cmd: '/dice', hint: 'кость' },
  { cmd: '/weather ', hint: 'погода в городе' },
  { cmd: '/code', hint: 'блок кода' }
];
