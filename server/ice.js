/** STUN + TURN (coturn). Public relay is only a fallback so calls work before you deploy coturn. */
export function iceServers() {
  const stun = {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478'
    ]
  };
  const fromEnv = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) {
    return [
      stun,
      {
        urls: fromEnv,
        username: process.env.TURN_USER || 'cbopka',
        credential: process.env.TURN_PASS || 'cbopka-turn'
      }
    ];
  }
  // Metered Open Relay demo credentials (published for testing). Prefer coturn in production.
  return [
    stun,
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
}

export function transportInfo() {
  return {
    websocket: true,
    socketio: true,
    webtransport: Boolean(process.env.WEBTRANSPORT_URL),
    webtransportUrl: process.env.WEBTRANSPORT_URL || null,
    note: 'Signaling is Socket.IO. WebTransport is used as an optional datagram side-channel when WEBTRANSPORT_URL is set and the browser supports it.'
  };
}
