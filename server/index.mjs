// HTTP + WebSocket gateway: serves public/ and turns authenticated sockets into voice sessions.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { clientKey, createFailureLimiter, isOriginAllowed, tokensMatch } from './auth.mjs';
import { ConfigError, loadConfig } from './config.mjs';
import { authOk, encode } from './protocol.mjs';
import { createStaticHandler } from './static.mjs';
import { createVoiceSession } from './voice-session.mjs';
import { AUTH_TIMEOUT_MS, awaitAuth } from './ws-auth.mjs';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_CONTROL_PAYLOAD = 64 * 1024;

function rejectUpgrade(socket, statusCode, text, body = '') {
  socket.write(`HTTP/1.1 ${statusCode} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  socket.destroy();
}

export function createGateway(config, deps = {}) {
  const log = deps.log ?? console;
  const limiter = deps.limiter ?? createFailureLimiter();
  const authTimeoutMs = deps.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const serveStatic = createStaticHandler({ publicDir: deps.publicDir ?? PUBLIC_DIR, basePath: config.basePath });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_PAYLOAD });
  const sessions = new Set();

  const server = createServer(async (req, res) => {
    try {
      if (await serveStatic(req, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (err) {
      log.error(`[http] ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  function startSession(ws, sessionId) {
    const voice = createVoiceSession({
      socket: ws,
      config,
      sessionId,
      deps: { fetchImpl: deps.fetchImpl ?? fetch, WebSocketImpl: deps.WebSocketImpl ?? WebSocket, log },
    });
    sessions.add(voice);
    ws.on('close', () => sessions.delete(voice));
    log.info(`[ws] session opened (${sessions.size} active)`);
  }

  // Compatibility path (ALLOW_QUERY_TOKEN=true): verify ?token= during the upgrade like old clients expect.
  function checkQueryToken(socket, key, token) {
    if (limiter.isBlocked(key)) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return false;
    }
    if (!tokensMatch(config.voiceToken, token)) {
      limiter.recordFailure(key);
      log.warn(`[ws] bad query token from ${key}`);
      rejectUpgrade(socket, 401, 'Unauthorized');
      return false;
    }
    limiter.clear(key);
    return true;
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== `${config.basePath}/ws`) return rejectUpgrade(socket, 404, 'Not Found');

    const origin = req.headers.origin;
    if (!isOriginAllowed({ origin, host: req.headers.host, allowedOrigins: config.allowedOrigins })) {
      log.warn(`[ws] origin rejected: ${origin ?? '(none)'}`);
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    const key = clientKey(req, config.trustProxy);
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null && !config.allowQueryToken) {
      log.warn(`[ws] token in query string refused from ${key}`);
      return rejectUpgrade(socket, 400, 'Bad Request', 'send the token as the first message {"type":"auth","token":...}, not in the URL (ALLOW_QUERY_TOKEN=true restores the old behaviour)\n');
    }
    const preAuthenticated = queryToken !== null;
    if (preAuthenticated && !checkQueryToken(socket, key, queryToken)) return;

    const requested = url.searchParams.get('session') ?? '';
    const sessionId = SESSION_ID_PATTERN.test(requested) ? requested : randomUUID();

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (preAuthenticated) {
        ws.send(encode(authOk()));
        startSession(ws, sessionId);
        return;
      }
      awaitAuth({
        socket: ws,
        expectedToken: config.voiceToken,
        limiter,
        key,
        timeoutMs: authTimeoutMs,
        log,
        onAuthenticated: () => startSession(ws, sessionId),
      });
    });
  });

  return {
    server,
    listen() {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const address = server.address();
          resolveListen({ host: address.address, port: address.port });
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      console.error('\nCopy .env.example to .env and fill in the values.');
      process.exit(1);
    }
    throw err;
  }
  const gateway = createGateway(config);
  const { host, port } = await gateway.listen();
  console.log(`hermes-voice-web listening on http://${host}:${port}${config.basePath}/`);
  const shutdown = async () => {
    console.log('shutting down');
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
