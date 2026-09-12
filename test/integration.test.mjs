import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../server/config.mjs';
import { createGateway } from '../server/index.mjs';
import { startFakeHermes } from './helpers/fake-hermes.mjs';
import { startFakeNari } from './helpers/fake-nari.mjs';
import { connectBrowser } from './helpers/browser-client.mjs';

const TOKEN = 'integration-test-token-01';
const BYTES_PER_CHAR = 480; // 10 ms of 24 kHz PCM16 per character in the fake TTS
const quiet = { info() {}, warn() {}, error() {} };

let nari;
let hermes;
let gateway;
let gatewayUrl;

function makeConfig(extra = {}) {
  return buildConfig({
    HERMES_API_KEY: hermes.apiKey, HERMES_API_URL: hermes.url,
    NARI_API_KEY: nari.apiKey, NARI_API_URL: nari.url,
    VOICE_TOKEN: TOKEN, PORT: '0', ACK_DELAY_MS: '60000', ...extra,
  });
}

before(async () => {
  nari = await startFakeNari({ bytesPerChar: BYTES_PER_CHAR });
  hermes = await startFakeHermes();
  gateway = createGateway(makeConfig(), { log: quiet });
  const { port } = await gateway.listen();
  gatewayUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await gateway?.close();
  await hermes?.close();
  await nari?.close();
});

async function speak(client, transcript) {
  nari.setTranscript(transcript);
  client.sendAudio();
  client.sendAudio();
  client.sendJson({ type: 'speech_end' });
}

test('a full turn: audio in, transcript, Hermes stream, sentence TTS, audio out, back to listening', async () => {
  hermes.script([{ delay: 2, text: 'It is ' }, { delay: 2, tool: { name: 'terminal', status: 'started' } }, { delay: 2, text: 'noon. ' }, { delay: 2, text: 'Anything else?' }]);
  const client = await connectBrowser({ gatewayUrl, token: TOKEN, origin: gatewayUrl, session: 'browser-session-0001' });
  assert.equal((await client.waitFor((m) => m.type === 'status')).state, 'listening');

  await speak(client, 'what time is it');
  assert.equal((await client.waitFor((m) => m.type === 'partial')).text, 'partial');
  assert.equal((await client.waitFor((m) => m.type === 'final')).text, 'what time is it');
  assert.equal((await client.waitFor((m) => m.type === 'status')).state, 'thinking');
  const tool = await client.waitFor((m) => m.type === 'status' && m.detail);
  assert.equal(tool.detail, 'terminal: started');
  assert.equal((await client.waitFor((m) => m.type === 'status' && m.state === 'speaking')).state, 'speaking');
  await client.waitFor((m) => m.type === 'assistant_text' && m.done === true);
  assert.equal((await client.waitFor((m) => m.type === 'status')).state, 'listening');

  const text = client.messagesOfType('assistant_text').map((m) => m.text).join('');
  assert.equal(text, 'It is noon. Anything else?');
  const expectedBytes = ('It is noon.'.length + 'Anything else?'.length) * BYTES_PER_CHAR;
  assert.equal(client.audioBytes, expectedBytes);

  const request = hermes.requests[0];
  assert.equal(request.headers.authorization, `Bearer ${hermes.apiKey}`);
  assert.equal(request.headers['x-hermes-session-id'], 'browser-session-0001');
  assert.equal(request.body.stream, true);
  assert.equal(request.body.model, 'hermes-agent');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'what time is it' }]);

  assert.deepEqual(nari.state.ttsRequests.map((r) => r.input), ['It is noon.', 'Anything else?']);
  assert.equal(nari.state.ttsRequests[0].response_format, 'pcm');
  assert.equal(nari.state.ttsRequests[0].stream, true);
  assert.equal(nari.state.ttsRequests[0].voice, 'leon');
  assert.deepEqual(nari.state.configures[0].session, { model: 'qwen3-asr:free', language: 'en', turn_detection: null });
  assert.equal(nari.state.commits, 1);
  client.close();
});

test('an interrupted turn: barge-in aborts Hermes and TTS, flushes, and the next turn carries what was heard', async () => {
  const firstSentence = 'One two three four.';
  hermes.script([{ delay: 2, text: `${firstSentence} ` }, { delay: 2, text: 'Five six seven eight. ' }, { delay: 1500, text: 'Nine ten.' }]);
  hermes.script([{ delay: 2, text: 'Hi.' }]);
  const ttsBefore = nari.state.ttsRequests.length;
  const client = await connectBrowser({ gatewayUrl, token: TOKEN, origin: gatewayUrl, session: 'browser-session-0002' });
  await client.waitFor((m) => m.type === 'status' && m.state === 'listening');

  await speak(client, 'tell me a story');
  await client.waitFor((m) => m.type === 'status' && m.state === 'speaking');
  const firstSentenceBytes = firstSentence.length * BYTES_PER_CHAR;
  await client.waitFor(() => client.audioBytes > firstSentenceBytes);

  client.sendJson({ type: 'interrupt' });
  client.sendJson({ type: 'heard_ms', ms: 100 });
  await client.waitFor((m) => m.type === 'flush');
  assert.equal((await client.waitFor((m) => m.type === 'status')).state, 'listening');
  await client.waitFor(() => hermes.requests[1]?.aborted === true, 3000).catch(() => {});
  assert.equal(hermes.requests[1].aborted, true, 'Hermes fetch was aborted');
  const audioAtFlush = client.audioBytes;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(client.audioBytes, audioAtFlush, 'no audio after the flush');
  assert.ok(nari.state.ttsRequests.length - ttsBefore <= 3, 'later sentences were not synthesised');

  await speak(client, 'skip it and say hi');
  await client.waitFor((m) => m.type === 'assistant_text' && m.done === true);
  const request = hermes.requests[2];
  assert.equal(request.body.messages.length, 2);
  assert.equal(request.body.messages[0].role, 'system');
  assert.match(request.body.messages[0].content, /interrupted/);
  assert.match(request.body.messages[0].content, /"One two"/);
  assert.deepEqual(request.body.messages[1], { role: 'user', content: 'skip it and say hi' });
  client.close();
});

test('a slow first token triggers one spoken acknowledgement before the answer', async () => {
  const quick = createGateway(makeConfig({ ACK_DELAY_MS: '40', ACK_TEXT: 'On it.' }), { log: quiet });
  const { port } = await quick.listen();
  hermes.script([{ delay: 400, text: 'Sure.' }]);
  const ttsBefore = nari.state.ttsRequests.length;
  const client = await connectBrowser({ gatewayUrl: `http://127.0.0.1:${port}`, token: TOKEN, origin: `http://127.0.0.1:${port}`, session: 'browser-session-0003' });
  await client.waitFor((m) => m.type === 'status' && m.state === 'listening');
  await speak(client, 'do something slow');
  await client.waitFor((m) => m.type === 'assistant_text' && m.done === true);
  assert.equal((await client.waitFor((m) => m.type === 'status' && m.state === 'listening')).state, 'listening');
  assert.deepEqual(nari.state.ttsRequests.slice(ttsBefore).map((r) => r.input), ['On it.', 'Sure.']);
  client.close();
  await quick.close();
});

test('Hermes errors surface as a friendly error message and the session keeps listening', async () => {
  const broken = createGateway(makeConfig({ HERMES_API_KEY: 'wrong-key' }), { log: quiet });
  const { port } = await broken.listen();
  const client = await connectBrowser({ gatewayUrl: `http://127.0.0.1:${port}`, token: TOKEN, origin: `http://127.0.0.1:${port}`, session: 'browser-session-0004' });
  await client.waitFor((m) => m.type === 'status' && m.state === 'listening');
  await speak(client, 'hello');
  const error = await client.waitFor((m) => m.type === 'error');
  assert.match(error.message, /Hermes is unreachable/);
  assert.doesNotMatch(error.message, /wrong-key/);
  assert.equal((await client.waitFor((m) => m.type === 'status')).state, 'listening');
  client.close();
  await broken.close();
});

test('the business snapshot is prepended as a system message when the provider yields text', async () => {
  const snapshotText = 'Business snapshot (generated 2026-09-12 11:59 America/Vancouver):\nRevenue: MRR 98 CAD, 2 active subscriptions.';
  const gw = createGateway(makeConfig(), { log: quiet, snapshot: { get: async () => snapshotText } });
  const { port } = await gw.listen();
  hermes.script([{ delay: 1, text: 'Ninety eight dollars.' }]);
  const before = hermes.requests.length;
  const client = await connectBrowser({ gatewayUrl: `http://127.0.0.1:${port}`, token: TOKEN, origin: `http://127.0.0.1:${port}`, session: 'browser-snapshot-01' });
  await client.waitFor((m) => m.type === 'status' && m.state === 'listening');
  await speak(client, 'how is revenue');
  await client.waitFor((m) => m.type === 'assistant_text' && m.done === true);

  const request = hermes.requests[before];
  assert.equal(request.body.messages[0].role, 'system');
  assert.match(request.body.messages[0].content, /voice assistant for the founder/);
  assert.match(request.body.messages[0].content, /MRR 98 CAD/);
  assert.deepEqual(request.body.messages[request.body.messages.length - 1], { role: 'user', content: 'how is revenue' });
  client.close();
  await gw.close();
});

test('no snapshot system message is sent when the provider yields null', async () => {
  const gw = createGateway(makeConfig(), { log: quiet, snapshot: { get: async () => null } });
  const { port } = await gw.listen();
  hermes.script([{ delay: 1, text: 'I do not have that.' }]);
  const before = hermes.requests.length;
  const client = await connectBrowser({ gatewayUrl: `http://127.0.0.1:${port}`, token: TOKEN, origin: `http://127.0.0.1:${port}`, session: 'browser-snapshot-02' });
  await client.waitFor((m) => m.type === 'status' && m.state === 'listening');
  await speak(client, 'how is revenue');
  await client.waitFor((m) => m.type === 'assistant_text' && m.done === true);

  const request = hermes.requests[before];
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'how is revenue' }]);
  client.close();
  await gw.close();
});
