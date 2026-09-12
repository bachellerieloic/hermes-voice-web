// First-message authentication for an accepted WebSocket. The token travels inside the socket, never
// in the URL, so reverse proxy access logs cannot capture it. Refusals use application close codes the
// browser can read (an HTTP 401 on the upgrade is invisible to a page, it only sees 1006).
import { tokensMatch } from './auth.mjs';
import { authOk, encode } from './protocol.mjs';

export const AuthClose = Object.freeze({ UNAUTHORIZED: 4401, RATE_LIMITED: 4429, AUTH_TIMEOUT: 4408 });
export const AUTH_TIMEOUT_MS = 5000;
const MAX_AUTH_BYTES = 1024;

/** Token from the first frame, or null when the frame is not a valid auth message. Pure. */
export function parseAuthFrame(data, isBinary) {
  if (isBinary) return null;
  const text = data.toString();
  if (text.length > MAX_AUTH_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.type === 'auth' && typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
}

/**
 * Wait for the first frame, verify the token, then call onAuthenticated. Failures record against the
 * limiter key and close the socket with a 44xx code. Blocked keys are closed immediately.
 */
export function awaitAuth({ socket, expectedToken, limiter, key, timeoutMs = AUTH_TIMEOUT_MS, log = console, onAuthenticated }) {
  if (limiter.isBlocked(key)) {
    socket.close(AuthClose.RATE_LIMITED, 'too many failed tokens');
    return;
  }
  const timer = setTimeout(() => socket.close(AuthClose.AUTH_TIMEOUT, 'no auth message'), timeoutMs);
  socket.once('close', () => clearTimeout(timer));
  socket.once('message', (data, isBinary) => {
    clearTimeout(timer);
    const token = parseAuthFrame(data, isBinary);
    if (token === null || !tokensMatch(expectedToken, token)) {
      limiter.recordFailure(key);
      log.warn(`[ws] bad token from ${key}`);
      socket.close(AuthClose.UNAUTHORIZED, 'bad token');
      return;
    }
    limiter.clear(key);
    socket.send(encode(authOk()));
    onAuthenticated();
  });
}
