// In-process stand-in for api.narilabs.com: realtime transcription over WebSocket and streaming TTS.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const TTS_CHUNK_BYTES = 4800; // 100 ms of 24 kHz PCM16

export async function startFakeNari({ apiKey = 'test-nari-key', bytesPerChar = 480, chunkDelayMs = 3 } = {}) {
  const state = {
    transcript: '',
    partialText: 'partial',
    configures: [],
    appends: 0,
    commits: 0,
    ttsRequests: [],
    sockets: new Set(),
  };

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/audio/speech') return handleTts(req, res);
    res.writeHead(404);
    res.end();
  });

  function handleTts(req, res) {
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"code":"UNAUTHORIZED"}}');
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const record = { ...payload, aborted: false, bytesSent: 0 };
      state.ttsRequests.push(record);
      const totalBytes = Math.max(2, Math.round((Array.from(payload.input).length * bytesPerChar) / 2) * 2);
      res.writeHead(200, { 'Content-Type': 'audio/pcm' });
      let sent = 0;
      const tick = () => {
        if (record.aborted) return;
        if (sent >= totalBytes) return res.end();
        const size = Math.min(TTS_CHUNK_BYTES, totalBytes - sent);
        res.write(Buffer.alloc(size, 1));
        sent += size;
        record.bytesSent = sent;
        setTimeout(tick, chunkDelayMs);
      };
      res.on('close', () => { record.aborted = sent < totalBytes; });
      tick();
    });
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/v1/realtime' || url.searchParams.get('intent') !== 'transcription') {
      socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.sockets.add(ws);
      ws.on('close', () => state.sockets.delete(ws));
      let utteranceBytes = 0;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session.configure') {
          state.configures.push(msg);
          ws.send(JSON.stringify({ type: 'session.configured', session: msg.session, 'session.limits': { max_utterance_seconds: 36 } }));
        } else if (msg.type === 'input_audio_buffer.append') {
          state.appends += 1;
          const bytes = Buffer.from(msg.audio, 'base64').length;
          if (utteranceBytes === 0) ws.send(JSON.stringify({ type: 'transcript.partial', event_id: 'e1', item_id: 'u1', transcript: state.partialText, revision: 1 }));
          utteranceBytes += bytes;
        } else if (msg.type === 'input_audio_buffer.commit') {
          state.commits += 1;
          const seconds = utteranceBytes / 32000;
          utteranceBytes = 0;
          ws.send(JSON.stringify({ type: 'transcript.completed', event_id: 'e2', item_id: 'u1', transcript: state.transcript, language: 'en', commit_reason: 'manual', usage: { input_audio_seconds: seconds } }));
        }
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    state,
    setTranscript(text) { state.transcript = text; },
    async close() {
      for (const ws of state.sockets) ws.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}
