import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig } from '../server/config.mjs';
import { createGateway } from '../server/index.mjs';
import { frameAudio, parseWav, resampleInt16 } from '../scripts/e2e-cli.mjs';
import { startFakeHermes } from './helpers/fake-hermes.mjs';
import { startFakeNari } from './helpers/fake-nari.mjs';

const TOKEN = 'e2e-cli-test-token-0001';
const BYTES_PER_CHAR = 480;
const CLI = new URL('../scripts/e2e-cli.mjs', import.meta.url).pathname;
const quiet = { info() {}, warn() {}, error() {} };

let nari;
let hermes;
let gateway;
let wsUrl;
let dir;

function writeWav(path, { sampleRate, channels = 1, ms }) {
  const frames = Math.round((sampleRate * ms) / 1000);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    for (let c = 0; c < channels; c += 1) data.writeInt16LE(value, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return frames;
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function gatewayConfig(extra = {}) {
  return buildConfig({
    HERMES_API_KEY: hermes.apiKey, HERMES_API_URL: hermes.url, NARI_API_KEY: nari.apiKey, NARI_API_URL: nari.url,
    VOICE_TOKEN: TOKEN, PORT: '0', BASE_PATH: '/voice', ACK_DELAY_MS: '60000', ...extra,
  });
}

before(async () => {
  nari = await startFakeNari({ bytesPerChar: BYTES_PER_CHAR });
  hermes = await startFakeHermes();
  gateway = createGateway(gatewayConfig(), { log: quiet });
  const { port } = await gateway.listen();
  wsUrl = `ws://127.0.0.1:${port}/voice/ws`;
  dir = mkdtempSync(join(tmpdir(), 'hermes-voice-e2e-'));
});

after(async () => {
  await gateway?.close();
  await hermes?.close();
  await nari?.close();
});

test('resampleInt16 and parseWav handle rate changes and stereo input', () => {
  const ramp = Int16Array.from({ length: 100 }, (_, i) => i * 100);
  const down = resampleInt16(ramp, 48000, 16000);
  assert.equal(down.length, 33);
  assert.equal(down[0], 0);
  assert.equal(down[10], 3000);
  assert.equal(resampleInt16(ramp, 16000, 16000).length, 100);
  assert.deepEqual(Array.from(resampleInt16(Int16Array.from([0, 1000]), 8000, 16000)), [0, 500, 1000, 1000]);

  const path = join(dir, 'stereo.wav');
  const frames = writeWav(path, { sampleRate: 22050, channels: 2, ms: 50 });
  const wav = parseWav(readFileSync(path));
  assert.equal(wav.sampleRate, 22050);
  assert.equal(wav.channels, 2);
  assert.equal(wav.samples.length, frames);
  assert.equal(frameAudio(wav.samples, 320).length, Math.ceil(frames / 320));
  assert.throws(() => parseWav(Buffer.from('not a wav file at all')), /RIFF/);
});

test('the CLI drives a full turn from a wav at another sample rate and writes the reply', async () => {
  const wavPath = join(dir, 'question.wav');
  const frames = writeWav(wavPath, { sampleRate: 22050, ms: 300 });
  const expectedFrames = Math.ceil(Math.floor(frames / (22050 / 16000)) / 320);
  const appendsBefore = nari.state.appends;
  nari.setTranscript('what time is it');
  hermes.script([{ delay: 2, text: 'It is noon.' }]);

  const result = await runCli(['--url', wsUrl, '--token', TOKEN, '--wav', wavPath, '--out', 'reply.pcm', '--timeout', '20']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /"type":"partial"/);
  assert.match(result.stdout, /"type":"final","text":"what time is it"/);
  assert.match(result.stdout, /"type":"turn_done"/);
  assert.match(result.stdout, /summary: exit=0 transcript="what time is it" assistant_chars=11 audio_ms=\d+ first_partial_ms=\d+ \(after first frame\) first_audio_ms=\d+ \(after speech_end\) reply=reply\.pcm/);
  assert.doesNotMatch(result.stdout, new RegExp(TOKEN));
  assert.equal(statSync(join(dir, 'reply.pcm')).size, 'It is noon.'.length * BYTES_PER_CHAR);
  assert.equal(nari.state.appends - appendsBefore, expectedFrames);
  const request = hermes.requests.at(-1);
  assert.match(request.headers['x-hermes-session-id'], /^e2e-/);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'what time is it' }]);
});

test('the CLI synthesises --say through Nari when NARI_API_KEY is set', async () => {
  const ttsBefore = nari.state.ttsRequests.length;
  nari.setTranscript('hello there');
  hermes.script([{ delay: 2, text: 'Hi.' }]);
  const result = await runCli(['--url', wsUrl, '--token', TOKEN, '--say', 'hello there', '--out', 'say.pcm', '--timeout', '20'], { NARI_API_KEY: nari.apiKey, NARI_API_URL: nari.url });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(nari.state.ttsRequests[ttsBefore].input, 'hello there');
  assert.equal(nari.state.ttsRequests[ttsBefore].response_format, 'pcm');
  assert.match(result.stdout, /summary: exit=0 transcript="hello there"/);
});

test('the CLI defaults Origin to https://<host> and explains a 403 from ALLOWED_ORIGINS', async () => {
  const strict = createGateway(gatewayConfig({ ALLOWED_ORIGINS: 'https://hermes.example' }), { log: quiet });
  const { port } = await strict.listen();
  const url = `ws://127.0.0.1:${port}/voice/ws`;
  const wavPath = join(dir, 'question.wav');
  try {
    const refused = await runCli(['--url', url, '--token', TOKEN, '--wav', wavPath, '--timeout', '10']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /HTTP 403/);
    assert.match(refused.stderr, /--origin https:\/\/hermes\.example/);
    nari.setTranscript('again');
    hermes.script([{ delay: 2, text: 'Yes.' }]);
    const allowed = await runCli(['--url', url, '--token', TOKEN, '--wav', wavPath, '--origin', 'https://hermes.example', '--out', 'again.pcm', '--timeout', '20']);
    assert.equal(allowed.code, 0, allowed.stderr + allowed.stdout);
  } finally {
    await strict.close();
  }
});

test('the CLI exits 1 on a bad token and 2 on bad arguments', async () => {
  const wavPath = join(dir, 'question.wav');
  const rejected = await runCli(['--url', wsUrl, '--token', 'wrong-token-value-00', '--wav', wavPath, '--timeout', '10']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /4401/);
  assert.match(rejected.stderr, /VOICE_TOKEN/);
  const usage = await runCli(['--wav', wavPath]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--url is required/);
});
