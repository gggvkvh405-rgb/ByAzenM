import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import '@fontsource/fraunces/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import './index.css';
import App from './App.jsx';

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0c0d11', color: '#f6f1e8', fontFamily: 'Outfit, Segoe UI, sans-serif', padding: 24 }}>
          <div style={{ maxWidth: 480 }}>
            <h1 style={{ fontWeight: 560 }}>Интерфейс споткнулся</h1>
            <p style={{ color: '#a39c92' }}>{String(this.state.error.message || this.state.error)}</p>
            <button onClick={() => location.reload()} style={{ background: '#ff6a45', color: '#1a0d08', border: 0, borderRadius: 12, padding: '10px 14px', fontWeight: 700 }}>Перезагрузить</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const boot = document.getElementById('boot');
createRoot(document.getElementById('root')).render(<Boundary><App /></Boundary>);
requestAnimationFrame(() => boot?.remove());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
