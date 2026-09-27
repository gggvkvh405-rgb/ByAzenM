/**
 * Optional mediasoup SFU. Never imported unless ENABLE_MEDIASOUP=1,
 * so Electron (which sets that unset and disables native modules) cannot crash on it.
 * Group calls fall back to a mesh coordinated by Socket.IO when this returns null.
 */
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {} },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } }
];

export async function createSfu() {
  if (process.env.ENABLE_MEDIASOUP !== '1') {
    return { available: false, reason: 'ENABLE_MEDIASOUP is not 1 — mesh fallback' };
  }
  let mediasoup;
  try {
    mediasoup = (await import('mediasoup')).default || (await import('mediasoup'));
  } catch (e) {
    return { available: false, reason: 'mediasoup not installed: ' + e.message };
  }
  const worker = await mediasoup.createWorker({
    rtcMinPort: Number(process.env.RTC_MIN_PORT || 40000),
    rtcMaxPort: Number(process.env.RTC_MAX_PORT || 49999),
    logLevel: 'warn'
  });
  worker.on('died', () => {
    console.error('mediasoup worker died');
    process.exit(1);
  });
  const router = await worker.createRouter({ mediaCodecs });
  const announcedIp = process.env.ANNOUNCED_IP || '127.0.0.1';
  const rooms = new Map();

  async function webRtcTransport() {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 2_000_000
    });
    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      }
    };
  }

  return {
    available: true,
    reason: 'mediasoup',
    router,
    getRtpCapabilities() {
      return router.rtpCapabilities;
    },
    async join(roomId, userId) {
      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const room = rooms.get(roomId);
      const send = await webRtcTransport();
      const recv = await webRtcTransport();
      const peer = { userId, send: send.transport, recv: recv.transport, producers: new Map(), consumers: [] };
      room.set(userId, peer);
      return {
        rtpCapabilities: router.rtpCapabilities,
        send: send.params,
        recv: recv.params,
        peers: [...room.keys()].filter((id) => id !== userId)
      };
    },
    async connect(roomId, userId, transportId, dtlsParameters) {
      const peer = rooms.get(roomId)?.get(userId);
      if (!peer) throw new Error('no peer');
      const transport = peer.send.id === transportId ? peer.send : peer.recv;
      await transport.connect({ dtlsParameters });
    },
    async produce(roomId, userId, { kind, rtpParameters }) {
      const peer = rooms.get(roomId)?.get(userId);
      if (!peer) throw new Error('no peer');
      const producer = await peer.send.produce({ kind, rtpParameters });
      peer.producers.set(producer.id, producer);
      return { id: producer.id, kind };
    },
    async consume(roomId, userId, producerId, rtpCapabilities) {
      if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('cannot consume');
      const peer = rooms.get(roomId)?.get(userId);
      if (!peer) throw new Error('no peer');
      const consumer = await peer.recv.consume({ producerId, rtpCapabilities, paused: false });
      peer.consumers.push(consumer);
      return { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
    },
    producersIn(roomId, except) {
      const room = rooms.get(roomId);
      if (!room) return [];
      const list = [];
      for (const [uid, peer] of room) {
        if (uid === except) continue;
        for (const producer of peer.producers.values()) list.push({ userId: uid, producerId: producer.id, kind: producer.kind });
      }
      return list;
    },
    leave(roomId, userId) {
      const room = rooms.get(roomId);
      const peer = room?.get(userId);
      if (!peer) return;
      try { peer.send.close(); } catch {}
      try { peer.recv.close(); } catch {}
      room.delete(userId);
    }
  };
}
