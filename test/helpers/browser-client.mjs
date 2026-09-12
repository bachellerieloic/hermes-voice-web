// A fake browser: opens the gateway WebSocket and records everything in order.
import { WebSocket } from 'ws';

export function connectBrowser({ gatewayUrl, token, origin, session = 'browser-session-0001' }) {
  const url = new URL('/ws', gatewayUrl);
  url.protocol = 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('session', session);
  return openClient(url.toString(), origin);
}

export function openClient(url, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: origin ? { Origin: origin } : {} });
    const client = {
      ws,
      log: [],
      cursor: 0,
      audioBytes: 0,
      closed: null,
      sendJson(message) { ws.send(JSON.stringify(message)); },
      sendAudio(bytes = 640) { ws.send(Buffer.alloc(bytes), { binary: true }); },
      close() { ws.close(); },
      async waitFor(predicate, timeoutMs = 5000) {
        const started = Date.now();
        for (;;) {
          for (let i = client.cursor; i < client.log.length; i += 1) {
            if (predicate(client.log[i])) {
              client.cursor = i + 1;
              return client.log[i];
            }
          }
          if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting; log tail: ${JSON.stringify(client.log.slice(-6))}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      },
      messagesOfType(type) { return client.log.filter((m) => m.type === type); },
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        client.audioBytes += data.length;
        client.log.push({ type: 'audio', bytes: data.length });
      } else {
        client.log.push(JSON.parse(data.toString()));
      }
    });
    ws.on('open', () => resolve(client));
    ws.on('close', (code, reason) => { client.closed = { code, reason: reason.toString() }; });
    ws.on('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`upgrade rejected with ${res.statusCode}`), { statusCode: res.statusCode }));
    });
    ws.on('error', (err) => reject(err));
  });
}
