import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthClose as PageAuthClose, EXPECTED_TOKEN_LENGTH, normalizeToken, parseTokenFragment, reconnectPolicy, refusalMessage, tokenHint } from '../public/token.js';
import { AuthClose as ServerAuthClose, parseAuthFrame } from '../server/ws-auth.mjs';

const GOOD = 'a'.repeat(EXPECTED_TOKEN_LENGTH);

test('normalizeToken trims and drops characters a token can never contain', () => {
  assert.equal(normalizeToken(`  ${GOOD}\n`), GOOD);
  assert.equal(normalizeToken(`"${GOOD}"`), GOOD);
  assert.equal(normalizeToken('ab c​d'), 'abcd');
  assert.equal(normalizeToken('x.y_z-1'), 'x.y_z-1');
  assert.equal(normalizeToken(null), '');
});

test('tokenHint counts characters and warns when the length is off', () => {
  assert.deepEqual(tokenHint(GOOD), { count: 48, ok: true, text: '48 characters' });
  assert.deepEqual(tokenHint(''), { count: 0, ok: false, text: '0 characters' });
  const extra = tokenHint(`e${GOOD}`);
  assert.equal(extra.count, 49);
  assert.equal(extra.ok, false);
  assert.match(extra.text, /49 characters, expected 48: check for an extra character at the start or end/);
  assert.equal(tokenHint('a').text, '1 character, expected 48: check for an extra character at the start or end');
});

test('parseTokenFragment reads #token= and normalises it', () => {
  assert.equal(parseTokenFragment(`#token=${GOOD}`), GOOD);
  assert.equal(parseTokenFragment(`#token=%20${GOOD}%0A`), GOOD);
  assert.equal(parseTokenFragment(`#foo=1&token=${GOOD}&bar=2`), GOOD);
  assert.equal(parseTokenFragment('#token='), null);
  assert.equal(parseTokenFragment('#other=1'), null);
  assert.equal(parseTokenFragment(''), null);
  assert.equal(parseTokenFragment(undefined), null);
});

test('reconnectPolicy never retries an auth refusal and stops after the attempt budget', () => {
  assert.deepEqual(reconnectPolicy({ closeCode: 4401, attempts: 0 }), { action: 'auth_failed', code: 4401 });
  assert.deepEqual(reconnectPolicy({ closeCode: 4429, attempts: 3 }), { action: 'auth_failed', code: 4429 });
  assert.deepEqual(reconnectPolicy({ closeCode: 1006, attempts: 0 }), { action: 'retry', delayMs: 1000 });
  assert.deepEqual(reconnectPolicy({ closeCode: 1006, attempts: 3 }), { action: 'retry', delayMs: 8000 });
  assert.deepEqual(reconnectPolicy({ closeCode: 1006, attempts: 4 }), { action: 'retry', delayMs: 10000 });
  assert.deepEqual(reconnectPolicy({ closeCode: 1006, attempts: 5 }), { action: 'give_up' });
  assert.deepEqual(reconnectPolicy({ closeCode: 4408, attempts: 0 }), { action: 'retry', delayMs: 1000 });
});

test('refusalMessage tells the user what to check', () => {
  assert.equal(refusalMessage(4401), 'Token refused, check for an extra character at the start or end');
  assert.match(refusalMessage(4429), /^Token refused, check for an extra character at the start or end/);
  assert.match(refusalMessage(4429), /wait a minute/);
});

test('the page and the server agree on the auth close codes', () => {
  assert.deepEqual({ ...PageAuthClose }, { ...ServerAuthClose });
});

test('parseAuthFrame accepts only a text auth message with a string token', () => {
  assert.equal(parseAuthFrame(Buffer.from('{"type":"auth","token":"abc"}'), false), 'abc');
  assert.equal(parseAuthFrame(Buffer.from('{"type":"auth","token":"abc"}'), true), null);
  assert.equal(parseAuthFrame(Buffer.from('{"type":"speech_start"}'), false), null);
  assert.equal(parseAuthFrame(Buffer.from('{"type":"auth","token":1}'), false), null);
  assert.equal(parseAuthFrame(Buffer.from('nope'), false), null);
});
