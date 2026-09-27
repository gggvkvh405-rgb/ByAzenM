/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0c0d11',
        panel: '#14161c',
        ember: '#ff6a45',
        mint: '#6ee0c2',
        paper: '#f6f1e8'
      },
      fontFamily: {
        sans: ['Outfit', 'Segoe UI', 'sans-serif'],
        display: ['Fraunces', 'Outfit', 'serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace']
      },
      boxShadow: {
        glow: '0 12px 40px rgba(255,106,69,0.28)'
      }
    }
  },
  plugins: []
};
