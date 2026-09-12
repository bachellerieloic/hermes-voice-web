// A fake browser: opens the gateway WebSocket, authenticates with the first message, records everything.
import { WebSocket } from 'ws';

/** Open, authenticate and resolve once auth_ok arrived. Rejects with { statusCode } or { closeCode }. */
export async function connectBrowser({ gatewayUrl, token, origin, session = 'browser-session-0001' }) {
  const url = new URL('/ws', gatewayUrl);
  url.protocol = 'ws:';
  url.searchParams.set('session', session);
  const client = await openClient(url.toString(), origin);
  const result = await client.auth(token);
  if (!result.ok) throw Object.assign(new Error(`auth refused with close code ${result.code}`), { closeCode: result.code });
  return client;
}

/** Open the socket without authenticating. Resolves on open, rejects on a refused upgrade. */
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
      auth(token) {
        return new Promise((resolveAuth) => {
          const onClose = (code) => resolveAuth({ ok: false, code });
          ws.once('close', onClose);
          client.waitFor((m) => m.type === 'auth_ok').then(() => {
            ws.off('close', onClose);
            resolveAuth({ ok: true });
          }, () => resolveAuth({ ok: false, code: client.closed?.code ?? 0 }));
          ws.send(JSON.stringify({ type: 'auth', token }));
        });
      },
      waitForClose(timeoutMs = 5000) {
        return new Promise((resolveClose, rejectClose) => {
          if (client.closed) return resolveClose(client.closed);
          const timer = setTimeout(() => rejectClose(new Error('socket did not close')), timeoutMs);
          ws.once('close', () => { clearTimeout(timer); resolveClose(client.closed); });
        });
      },
      async waitFor(predicate, timeoutMs = 5000) {
        const started = Date.now();
        for (;;) {
          for (let i = client.cursor; i < client.log.length; i += 1) {
            if (predicate(client.log[i])) {
              client.cursor = i + 1;
              return client.log[i];
            }
          }
          if (client.closed) throw new Error(`socket closed (${client.closed.code}) while waiting`);
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
