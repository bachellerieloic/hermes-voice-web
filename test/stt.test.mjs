import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MAX_PCM_BYTES_PER_FRAME, buildAppendMessage, buildConfigureMessage, chunkPcm, createSttClient } from '../server/nari-stt.mjs';

test('chunkPcm keeps frames at or under 48 KiB and never splits a sample', () => {
  const input = Buffer.alloc(200 * 1024 + 1, 7);
  const frames = chunkPcm(input);
  assert.ok(frames.length >= 5);
  for (const frame of frames) {
    assert.ok(frame.length <= MAX_PCM_BYTES_PER_FRAME);
    assert.equal(frame.length % 2, 0);
  }
  assert.equal(frames.reduce((n, f) => n + f.length, 0), 200 * 1024);
});

test('an append message built from a maximum frame stays under the 128 KiB message limit', () => {
  const [frame] = chunkPcm(Buffer.alloc(MAX_PCM_BYTES_PER_FRAME, 1));
  const message = buildAppendMessage(frame);
  assert.ok(Buffer.byteLength(message) < 128 * 1024);
  assert.equal(JSON.parse(message).type, 'input_audio_buffer.append');
});

test('configure message nests fields under session and maps turn detection', () => {
  const manual = JSON.parse(buildConfigureMessage({ model: 'qwen3-asr:free', language: 'en', turnDetection: 'client' }));
  assert.deepEqual(manual, { type: 'session.configure', session: { model: 'qwen3-asr:free', language: 'en', turn_detection: null } });
  const auto = JSON.parse(buildConfigureMessage({ model: 'qwen3-asr:free', language: '', turnDetection: 'server_vad' }));
  assert.deepEqual(auto.session, { model: 'qwen3-asr:free', language: null, turn_detection: { type: 'server_vad' } });
});

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code) { this.emit('close', code ?? 1000, Buffer.from('')); }
  configure() {
    this.emit('open');
    this.emit('message', Buffer.from(JSON.stringify({ type: 'session.configured' })));
  }
}

test('stt client queues audio until configured, then drains audio before the pending commit', () => {
  FakeSocket.instances = [];
  const finals = [];
  const client = createSttClient({
    url: 'ws://stt.test/v1/realtime?intent=transcription',
    apiKey: 'k',
    model: 'm',
    language: 'en',
    turnDetection: 'client',
    WebSocketImpl: FakeSocket,
    onFinal: (text) => finals.push(text),
    log: { info() {}, warn() {}, error() {} },
  });
  client.sendAudio(Buffer.alloc(640));
  client.commit();
  assert.equal(FakeSocket.instances.length, 1);
  const socket = FakeSocket.instances[0];
  assert.equal(socket.options.headers.Authorization, 'Bearer k');
  assert.deepEqual(socket.sent, []);
  socket.configure();
  assert.deepEqual(socket.sent.map((m) => m.type), ['session.configure', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
  assert.ok(client.connected);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'transcript.completed', transcript: 'hello', commit_reason: 'manual' })));
  assert.deepEqual(finals, ['hello']);
});

test('stt client reconnects on the next audio after the server closes the socket', () => {
  FakeSocket.instances = [];
  const client = createSttClient({ url: 'ws://stt.test', apiKey: 'k', model: 'm', language: 'en', turnDetection: 'client', WebSocketImpl: FakeSocket, log: { info() {}, warn() {}, error() {} } });
  client.sendAudio(Buffer.alloc(2));
  FakeSocket.instances[0].configure();
  FakeSocket.instances[0].emit('close', 1000, Buffer.from('idle'));
  assert.equal(client.connected, false);
  client.sendAudio(Buffer.alloc(2));
  assert.equal(FakeSocket.instances.length, 2);
  FakeSocket.instances[1].configure();
  assert.equal(FakeSocket.instances[1].sent.length, 2);
  client.close();
});
