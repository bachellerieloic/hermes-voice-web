import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../server/config.mjs';
import { createGateway } from '../server/index.mjs';
import { openClient } from './helpers/browser-client.mjs';

const TOKEN = 'gateway-test-token-0001';
const quiet = { info() {}, warn() {}, error() {} };
let gateway;
let base;
let origin;

before(async () => {
  const config = buildConfig({
    HERMES_API_KEY: 'h', NARI_API_KEY: 'n', VOICE_TOKEN: TOKEN, PORT: '0', BASE_PATH: '/voice',
    NARI_API_URL: 'http://127.0.0.1:9', HERMES_API_URL: 'http://127.0.0.1:9',
  });
  gateway = createGateway(config, { log: quiet });
  const { port } = await gateway.listen();
  base = `http://127.0.0.1:${port}`;
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
  await assert.rejects(openClient(`${base.replace('http', 'ws')}/ws?token=${TOKEN}`, origin), (err) => err.statusCode === 404);
});

test('bad origin is refused with 403 even with a valid token', async () => {
  await assert.rejects(openClient(`${base.replace('http', 'ws')}/voice/ws?token=${TOKEN}`, 'https://evil.test'), (err) => err.statusCode === 403);
});

test('a good token and origin opens a session that reports listening', async () => {
  const client = await openClient(`${base.replace('http', 'ws')}/voice/ws?token=${TOKEN}&session=abcdefgh-1234`, origin);
  const status = await client.waitFor((m) => m.type === 'status');
  assert.equal(status.state, 'listening');
  client.close();
});

test('wrong tokens get 401 and repeated failures get rate limited with 429', async () => {
  const url = `${base.replace('http', 'ws')}/voice/ws?token=wrong-token-value`;
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(openClient(url, origin), (err) => err.statusCode === 401);
  }
  await assert.rejects(openClient(url, origin), (err) => err.statusCode === 429);
  await assert.rejects(openClient(`${base.replace('http', 'ws')}/voice/ws?token=${TOKEN}`, origin), (err) => err.statusCode === 429);
});
