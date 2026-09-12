import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../server/config.mjs';
import { createGateway } from '../server/index.mjs';
import { AuthClose } from '../server/ws-auth.mjs';
import { openClient } from './helpers/browser-client.mjs';

const TOKEN = 'gateway-test-token-0001';
const quiet = { info() {}, warn() {}, error() {} };
let gateway;
let base;
let origin;
let wsBase;

const config = (extra = {}) => buildConfig({
  HERMES_API_KEY: 'h', NARI_API_KEY: 'n', VOICE_TOKEN: TOKEN, PORT: '0', BASE_PATH: '/voice',
  NARI_API_URL: 'http://127.0.0.1:9', HERMES_API_URL: 'http://127.0.0.1:9', ...extra,
});

before(async () => {
  gateway = createGateway(config(), { log: quiet });
  const { port } = await gateway.listen();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  origin = base;
});

after(async () => {
  await gateway?.close();
});

test('BASE_PATH: the bare prefix redirects to the slash form so relative URLs resolve', async () => {
  const res = await fetch(`${base}/voice?x=1`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/voice/?x=1');
});

test('BASE_PATH: the page and its assets are served under the prefix and nowhere else', async () => {
  const page = await fetch(`${base}/voice/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /href="\.\/manifest\.json"/);
  assert.doesNotMatch(html, /(src|href)="\//);
  assert.equal((await fetch(`${base}/voice/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/voice/token.js`)).status, 200);
  assert.equal((await fetch(`${base}/voice/worklets/mic.js`)).status, 200);
  assert.equal((await fetch(`${base}/voice/worklets/player.js`)).status, 200);
  assert.equal((await fetch(`${base}/voice/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/voice/healthz`)).status, 200);
});

test('static handler never leaves public/', async () => {
  assert.equal((await fetch(`${base}/voice/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/voice/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/voice/..%2fpackage.json`)).status, 404);
});

test('WebSocket upgrade is only served at BASE_PATH/ws', async () => {
  await assert.rejects(openClient(`${wsBase}/ws`, origin), (err) => err.statusCode === 404);
});

test('bad origin is refused with 403 before any token is looked at', async () => {
  await assert.rejects(openClient(`${wsBase}/voice/ws`, 'https://evil.test'), (err) => err.statusCode === 403);
});

test('a token in the query string is refused with 400 unless ALLOW_QUERY_TOKEN is set', async () => {
  await assert.rejects(openClient(`${wsBase}/voice/ws?token=${TOKEN}`, origin), (err) => err.statusCode === 400);
});

test('the first message authenticates: auth_ok, then the session reports listening', async () => {
  const client = await openClient(`${wsBase}/voice/ws?session=abcdefgh-1234`, origin);
  assert.deepEqual(await client.auth(TOKEN), { ok: true });
  const status = await client.waitFor((m) => m.type === 'status');
  assert.equal(status.state, 'listening');
  client.close();
});

test('a wrong token closes the socket with 4401 and never reaches the session', async () => {
  const client = await openClient(`${wsBase}/voice/ws`, origin);
  const result = await client.auth('wrong-token-value-000');
  assert.deepEqual(result, { ok: false, code: AuthClose.UNAUTHORIZED });
  assert.equal(client.messagesOfType('status').length, 0);
});

test('audio or any other frame before auth is refused with 4401', async () => {
  const client = await openClient(`${wsBase}/voice/ws`, origin);
  client.sendAudio();
  const closed = await client.waitForClose();
  assert.equal(closed.code, AuthClose.UNAUTHORIZED);
});

test('repeated bad tokens are rate limited with 4429, even for the right token', async () => {
  const limited = createGateway(config(), { log: quiet });
  const { port } = await limited.listen();
  const url = `ws://127.0.0.1:${port}/voice/ws`;
  const o = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 5; i += 1) {
      const client = await openClient(url, o);
      assert.equal((await client.auth('wrong-token-value-000')).code, AuthClose.UNAUTHORIZED);
    }
    const blocked = await openClient(url, o);
    assert.equal((await blocked.waitForClose()).code, AuthClose.RATE_LIMITED);
    const stillBlocked = await openClient(url, o);
    assert.equal((await stillBlocked.auth(TOKEN)).code, AuthClose.RATE_LIMITED);
  } finally {
    await limited.close();
  }
});

test('a socket that never authenticates is closed with 4408', async () => {
  const strict = createGateway(config(), { log: quiet, authTimeoutMs: 50 });
  const { port } = await strict.listen();
  try {
    const client = await openClient(`ws://127.0.0.1:${port}/voice/ws`, `http://127.0.0.1:${port}`);
    const closed = await client.waitForClose();
    assert.equal(closed.code, AuthClose.AUTH_TIMEOUT);
  } finally {
    await strict.close();
  }
});

test('ALLOW_QUERY_TOKEN=true restores upgrade-time checks for old clients', async () => {
  const compat = createGateway(config({ ALLOW_QUERY_TOKEN: 'true' }), { log: quiet });
  const { port } = await compat.listen();
  const url = `ws://127.0.0.1:${port}/voice/ws`;
  const o = `http://127.0.0.1:${port}`;
  try {
    const client = await openClient(`${url}?token=${TOKEN}`, o);
    await client.waitFor((m) => m.type === 'auth_ok');
    assert.equal((await client.waitFor((m) => m.type === 'status')).state, 'listening');
    client.close();
    await assert.rejects(openClient(`${url}?token=wrong-token-value-000`, o), (err) => err.statusCode === 401);
  } finally {
    await compat.close();
  }
});
