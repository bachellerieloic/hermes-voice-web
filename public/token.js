// Token handling shared by the page and the tests: normalisation, the length hint, the magic-link
// fragment and the reconnect policy. No DOM access, so node:test can import this file directly.

export const EXPECTED_TOKEN_LENGTH = 48; // openssl rand -hex 24
const TOKEN_DISALLOWED = /[^A-Za-z0-9._-]/g;

// Close codes the gateway uses after it has accepted the socket but refused the token.
export const AuthClose = Object.freeze({ UNAUTHORIZED: 4401, RATE_LIMITED: 4429, AUTH_TIMEOUT: 4408 });

export const RECONNECT = Object.freeze({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000 });

/** Trim and drop anything a token can never contain (an iOS selection often grabs a stray neighbour). */
export function normalizeToken(raw) {
  return String(raw ?? '').trim().replace(TOKEN_DISALLOWED, '');
}

/** Character count shown next to the field, with a hint when it does not match the expected length. */
export function tokenHint(token, expected = EXPECTED_TOKEN_LENGTH) {
  const count = token.length;
  const label = `${count} character${count === 1 ? '' : 's'}`;
  if (count === 0 || count === expected) return { count, ok: count === expected, text: label };
  return { count, ok: false, text: `${label}, expected ${expected}: check for an extra character at the start or end` };
}

/** Read a token from a URL fragment such as "#token=abc" (never sent to the server or its logs). */
export function parseTokenFragment(hash) {
  const match = /^#(?:.*&)?token=([^&]*)/.exec(hash ?? '');
  if (!match) return null;
  let raw = match[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep the raw value; normalisation strips what it can
  }
  const token = normalizeToken(raw);
  return token === '' ? null : token;
}

export function isAuthCloseCode(code) {
  return code === AuthClose.UNAUTHORIZED || code === AuthClose.RATE_LIMITED;
}

/** What to do after the socket closed: stop on an auth refusal, retry with backoff, then give up. */
export function reconnectPolicy({ closeCode, attempts, maxAttempts = RECONNECT.maxAttempts, baseDelayMs = RECONNECT.baseDelayMs, maxDelayMs = RECONNECT.maxDelayMs }) {
  if (isAuthCloseCode(closeCode)) return { action: 'auth_failed', code: closeCode };
  if (attempts >= maxAttempts) return { action: 'give_up' };
  return { action: 'retry', delayMs: Math.min(maxDelayMs, baseDelayMs * 2 ** attempts) };
}

export function refusalMessage(code) {
  const base = 'Token refused, check for an extra character at the start or end';
  return code === AuthClose.RATE_LIMITED ? `${base} (too many attempts, wait a minute before retrying)` : base;
}
