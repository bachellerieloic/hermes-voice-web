import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientKey, createFailureLimiter, isOriginAllowed, tokensMatch } from '../server/auth.mjs';
import { resolveRoute } from '../server/static.mjs';
import { ProtocolError, decodeClientMessage, encode } from '../server/protocol.mjs';

test('tokensMatch is strict about type, length and content', () => {
  assert.equal(tokensMatch('secret-token-value', 'secret-token-value'), true);
  assert.equal(tokensMatch('secret-token-value', 'secret-token-valuE'), false);
  assert.equal(tokensMatch('secret-token-value', 'secret'), false);
  assert.equal(tokensMatch('secret-token-value', undefined), false);
});

test('origin policy: same host by default, explicit list, wildcard, missing origin', () => {
  assert.equal(isOriginAllowed({ origin: 'https://voice.example.test', host: 'voice.example.test', allowedOrigins: [] }), true);
  assert.equal(isOriginAllowed({ origin: 'https://evil.test', host: 'voice.example.test', allowedOrigins: [] }), false);
  assert.equal(isOriginAllowed({ origin: 'https://evil.test', host: 'voice.example.test', allowedOrigins: ['https://evil.test'] }), true);
  assert.equal(isOriginAllowed({ origin: 'https://voice.example.test', host: 'voice.example.test', allowedOrigins: ['https://other.test'] }), false);
  assert.equal(isOriginAllowed({ origin: undefined, host: 'x', allowedOrigins: [] }), false);
  assert.equal(isOriginAllowed({ origin: undefined, host: 'x', allowedOrigins: ['*'] }), true);
  assert.equal(isOriginAllowed({ origin: 'garbage', host: 'x', allowedOrigins: [] }), false);
});

test('clientKey honours X-Forwarded-For only when the proxy is trusted', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientKey(req, false), '127.0.0.1');
  assert.equal(clientKey(req, true), '203.0.113.9');
  assert.equal(clientKey({ headers: {}, socket: {} }, true), 'unknown');
});

test('failure limiter blocks after max failures and forgets after the window', () => {
  let now = 1000;
  const limiter = createFailureLimiter({ max: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.isBlocked('a'), false);
    limiter.recordFailure('a');
  }
  assert.equal(limiter.isBlocked('a'), true);
  assert.equal(limiter.isBlocked('b'), false);
  now += 1001;
  assert.equal(limiter.isBlocked('a'), false);
  limiter.recordFailure('b');
  limiter.clear('b');
  assert.equal(limiter.isBlocked('b'), false);
});

test('resolveRoute mounts under BASE_PATH and refuses traversal', () => {
  assert.deepEqual(resolveRoute('/voice', '/voice'), { kind: 'redirect', location: '/voice/' });
  assert.deepEqual(resolveRoute('/voice/', '/voice'), { kind: 'file', relative: '/index.html' });
  assert.deepEqual(resolveRoute('/voice/app.js', '/voice'), { kind: 'file', relative: '/app.js' });
  assert.deepEqual(resolveRoute('/app.js', '/voice'), { kind: 'notFound' });
  assert.deepEqual(resolveRoute('/voicechat/app.js', '/voice'), { kind: 'notFound' });
  assert.deepEqual(resolveRoute('/voice/../server/index.mjs', '/voice'), { kind: 'notFound' });
  assert.deepEqual(resolveRoute('/voice/%2e%2e/x', '/voice'), { kind: 'notFound' });
  assert.deepEqual(resolveRoute('/voice/healthz', '/voice'), { kind: 'health' });
  assert.deepEqual(resolveRoute('/', ''), { kind: 'file', relative: '/index.html' });
  assert.deepEqual(resolveRoute('/worklets/mic.js', ''), { kind: 'file', relative: '/worklets/mic.js' });
});

test('protocol decodes known client messages and rejects the rest', () => {
  assert.deepEqual(decodeClientMessage('{"type":"interrupt"}'), { type: 'interrupt' });
  assert.deepEqual(decodeClientMessage('{"type":"heard_ms","ms":1234.9}'), { type: 'heard_ms', ms: 1234 });
  assert.throws(() => decodeClientMessage('{"type":"heard_ms","ms":-1}'), ProtocolError);
  assert.throws(() => decodeClientMessage('{"type":"status"}'), ProtocolError);
  assert.throws(() => decodeClientMessage('nope'), ProtocolError);
  assert.throws(() => encode({ type: 'interrupt' }), ProtocolError);
  assert.equal(encode({ type: 'flush' }), '{"type":"flush"}');
});
