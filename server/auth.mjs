// Token comparison, origin allowlist and a small failure rate limiter for the WebSocket upgrade.
import { timingSafeEqual } from 'node:crypto';

export function tokensMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Origin policy: an explicit list wins; "*" allows everything; an empty list allows only
 * origins whose host (including port) equals the request Host header. A missing Origin is
 * rejected unless "*" is listed.
 */
export function isOriginAllowed({ origin, host, allowedOrigins }) {
  const list = allowedOrigins ?? [];
  if (list.includes('*')) return true;
  if (!origin) return false;
  if (list.length > 0) return list.includes(origin);
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Key used for rate limiting: the socket address, or the first X-Forwarded-For entry when trusted. */
export function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Blocks a key after `max` failures inside `windowMs`. */
export function createFailureLimiter({ max = 5, windowMs = 60_000, now = Date.now } = {}) {
  const entries = new Map();

  const current = (key) => {
    const entry = entries.get(key);
    if (!entry || now() - entry.since >= windowMs) return { since: now(), count: 0 };
    return entry;
  };

  return {
    isBlocked(key) {
      return current(key).count >= max;
    },
    recordFailure(key) {
      const entry = current(key);
      entries.set(key, { since: entry.since, count: entry.count + 1 });
    },
    clear(key) {
      entries.delete(key);
    },
  };
}
