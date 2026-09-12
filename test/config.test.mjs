import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, buildConfig, nariRealtimeUrl, normalizeBasePath, parseDotEnv, parseOrigins } from '../server/config.mjs';

const valid = { HERMES_API_KEY: 'h', NARI_API_KEY: 'n', VOICE_TOKEN: 'a-long-enough-token-value' };

test('buildConfig lists every problem at once', () => {
  assert.throws(() => buildConfig({ PORT: 'abc', VOICE_TOKEN: 'short', NARI_TURN_DETECTION: 'magic' }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.problems.length, 5);
    assert.match(err.message, /HERMES_API_KEY/);
    assert.match(err.message, /NARI_API_KEY/);
    assert.match(err.message, /VOICE_TOKEN must be at least 16/);
    assert.match(err.message, /PORT/);
    assert.match(err.message, /NARI_TURN_DETECTION/);
    return true;
  });
});

test('buildConfig applies defaults and normalises URLs and base path', () => {
  const config = buildConfig({ ...valid, HERMES_API_URL: 'http://127.0.0.1:8642/', BASE_PATH: 'voice/', ALLOWED_ORIGINS: ' https://a.test, https://b.test ' });
  assert.equal(config.hermesApiUrl, 'http://127.0.0.1:8642');
  assert.equal(config.hermesModel, 'hermes-agent');
  assert.equal(config.nariVoice, 'leon');
  assert.equal(config.port, 8765);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.basePath, '/voice');
  assert.deepEqual(config.allowedOrigins, ['https://a.test', 'https://b.test']);
  assert.equal(config.trustProxy, false);
  assert.equal(config.ackDelayMs, 1500);
  assert.equal(config.nariTurnDetection, 'client');
  assert.ok(Object.isFrozen(config));
});

test('normalizeBasePath handles the common spellings', () => {
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('voice'), '/voice');
  assert.equal(normalizeBasePath('/voice/'), '/voice');
  assert.equal(normalizeBasePath('/a/b//'), '/a/b');
  assert.equal(normalizeBasePath(undefined), '');
});

test('parseDotEnv ignores comments and strips quotes', () => {
  const parsed = parseDotEnv('# comment\nA=1\nB="two words"\nC=\'x\'\nnot a pair\n\nD=a=b\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'x', D: 'a=b' });
  assert.deepEqual(parseOrigins(''), []);
});

test('nariRealtimeUrl switches to the websocket scheme and keeps the intent', () => {
  assert.equal(nariRealtimeUrl('https://api.narilabs.com'), 'wss://api.narilabs.com/v1/realtime?intent=transcription');
  assert.equal(nariRealtimeUrl('http://127.0.0.1:9999'), 'ws://127.0.0.1:9999/v1/realtime?intent=transcription');
});
