// Business awareness: turns the read-only agent snapshot endpoint into compact, speakable text and
// caches it, so the voice assistant can cite live numbers without any analytics logic living here.

const DEFAULT_TTL_MS = 120000;

// Prepended verbatim to every injected snapshot. Kept as a constant so it is easy to test and audit.
export const SNAPSHOT_SYSTEM_PREFIX = 'You are a voice assistant for the founder. Here is current business data you may cite directly and concisely when asked. Do not read it out unless asked. If a number the user asks for is not here, say you do not have it rather than guessing.';

// Arrows may arrive as glyphs or as words; we always speak the word, never a glyph.
const ARROW_WORDS = Object.freeze({
  '↑': 'up',
  '↓': 'down',
  '→': 'flat',
  '↔': 'flat',
  up: 'up',
  down: 'down',
  flat: 'flat',
});

/** A finite number or null. Everything from the network is treated as untrusted. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "N word" or "N words", with singular kept clean. Pure. */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Direction word for a week-over-week entry, from its arrow first, then the sign of its percent. Pure. */
function arrowWord(wow) {
  const raw = typeof wow.arrow === 'string' ? wow.arrow.trim() : '';
  if (ARROW_WORDS[raw]) return ARROW_WORDS[raw];
  const pct = Number(wow.pct);
  if (!Number.isFinite(pct) || pct === 0) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

/**
 * Render a week-over-week entry as { word, text }. word is one of up/down/flat.
 * Percentages are rounded to whole numbers. Returns null when there is nothing usable.
 * Pure and exported so the wording and rounding can be unit tested directly.
 */
export function formatWow(wow) {
  if (!wow || typeof wow !== 'object') return null;
  const word = arrowWord(wow);
  if (word === 'flat') return { word: 'flat', text: 'flat' };
  const pct = Number(wow.pct);
  if (!Number.isFinite(pct)) return null;
  return { word, text: `${word} ${Math.round(Math.abs(pct))}%` };
}

/** "Sep 5" from an ISO date, formatted in UTC so a bare date never shifts a day. Pure. */
function formatDay(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  } catch {
    return '';
  }
}

/** "Sep 5 to Sep 11" from a { startDate, endDate } range. Empty string when either end is missing. Pure. */
function formatDayRange(range) {
  if (!range || typeof range !== 'object') return '';
  const start = formatDay(range.startDate);
  const end = formatDay(range.endDate);
  return start && end ? `${start} to ${end}` : '';
}

/** "2026-09-12 11:59" in the snapshot time zone, falling back to UTC then to empty. Pure. */
function formatGeneratedAt(generatedAt, timeZone) {
  if (!generatedAt) return '';
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return '';
  const zones = [];
  if (typeof timeZone === 'string' && timeZone.trim() !== '') zones.push(timeZone.trim());
  zones.push('UTC');
  for (const zone of zones) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date);
      const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
      return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
    } catch {
      // Try the next zone (an invalid time zone throws a RangeError).
    }
  }
  return '';
}

function formatHeader(generatedAt, timeZone) {
  const when = formatGeneratedAt(generatedAt, timeZone);
  const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? ` ${timeZone.trim()}` : '';
  return when ? `Business snapshot (generated ${when}${zone}):` : 'Business snapshot:';
}

function formatGa4(ga4) {
  const range = formatDayRange(ga4.range);
  const label = range ? `Web, ${range}:` : 'Web:';
  const segments = [];
  const sessions = num(ga4.sessions);
  if (sessions !== null) {
    const wow = formatWow(ga4.wow?.sessions);
    segments.push(wow && wow.word !== 'flat'
      ? `${sessions} sessions, ${wow.text} week over week`
      : `${sessions} sessions`);
  }
  const conversions = num(ga4.conversions);
  if (conversions !== null) {
    const wow = formatWow(ga4.wow?.conversions);
    segments.push(wow && wow.word !== 'flat'
      ? `${conversions} conversions, ${wow.text}`
      : `${conversions} conversions`);
  }
  return segments.length ? `${label} ${segments.join('; ')}.` : '';
}

function formatGsc(gsc) {
  const range = formatDayRange(gsc.range);
  const label = range ? `Search ${range}:` : 'Search:';
  const counts = [];
  const clicks = num(gsc.clicks);
  const impressions = num(gsc.impressions);
  if (clicks !== null) counts.push(`${clicks} clicks`);
  if (impressions !== null) counts.push(`${impressions} impressions`);
  if (counts.length === 0) return '';
  const suffixes = [];
  const clicksWow = formatWow(gsc.wow?.clicks);
  if (clicksWow && clicksWow.word !== 'flat') suffixes.push(`clicks ${clicksWow.text}`);
  const impressionsWow = formatWow(gsc.wow?.impressions);
  if (impressionsWow && impressionsWow.word !== 'flat') suffixes.push(`impressions ${impressionsWow.text}`);
  const tail = suffixes.length ? `, ${suffixes.join(', ')}` : '';
  return `${label} ${counts.join(', ')}${tail}.`;
}

function formatWebLine(web) {
  const parts = [];
  if (web.ga4 && typeof web.ga4 === 'object') {
    const text = formatGa4(web.ga4);
    if (text) parts.push(text);
  }
  if (web.gsc && typeof web.gsc === 'object') {
    const text = formatGsc(web.gsc);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join(' ') : '';
}

function formatRevenue(revenue) {
  const parts = [];
  const mrr = num(revenue.mrr);
  const currency = typeof revenue.currency === 'string' && revenue.currency.trim() !== '' ? ` ${revenue.currency.trim()}` : '';
  if (mrr !== null) parts.push(`MRR ${mrr}${currency}`);
  const subs = num(revenue.activeSubscriptions);
  if (subs !== null) parts.push(plural(subs, 'active subscription'));
  return parts.length ? `Revenue: ${parts.join(', ')}.` : '';
}

function formatMembers(members) {
  const parts = [];
  const active = num(members.totalActive);
  if (active !== null) parts.push(`${active} active`);
  const fresh = num(members.newThisMonth);
  if (fresh !== null) parts.push(`${fresh} new this month`);
  return parts.length ? `Members: ${parts.join(', ')}.` : '';
}

function formatDinner(dinner) {
  if (!dinner || typeof dinner !== 'object' || !dinner.city) return '';
  const day = formatDay(dinner.date);
  const when = day ? ` ${day}` : '';
  const status = dinner.status ? ` (${dinner.status})` : '';
  return `${dinner.city}${when}${status}`;
}

function formatDinners(dinners) {
  if (!Array.isArray(dinners.upcoming)) return '';
  if (dinners.upcoming.length === 0) return 'Upcoming dinners: none scheduled.';
  const items = dinners.upcoming.map(formatDinner).filter((item) => item !== '');
  return items.length ? `Upcoming dinners: ${items.join(', ')}.` : '';
}

/**
 * Turn a snapshot payload into compact, speakable text: one line per non-null section, each with
 * its date range and week-over-week direction. Returns null when there is nothing worth saying.
 * Pure and exported so it is fully unit testable.
 */
export function formatSnapshot(json) {
  if (!json || typeof json !== 'object') return null;
  const lines = [];

  if (json.web && typeof json.web === 'object') {
    const webLine = formatWebLine(json.web);
    if (webLine) lines.push(webLine);
    if (json.web.brief) lines.push(`Web brief: ${String(json.web.brief).trim()}`);
  }
  if (json.revenue && typeof json.revenue === 'object') {
    const line = formatRevenue(json.revenue);
    if (line) lines.push(line);
  }
  if (json.members && typeof json.members === 'object') {
    const line = formatMembers(json.members);
    if (line) lines.push(line);
  }
  if (json.dinners && typeof json.dinners === 'object') {
    const line = formatDinners(json.dinners);
    if (line) lines.push(line);
  }

  if (lines.length === 0) return null;
  return [formatHeader(json.generatedAt, json.timezone), ...lines].join('\n');
}

/** The system message that carries the snapshot text. Pure. */
export function snapshotSystemMessage(text) {
  return { role: 'system', content: `${SNAPSHOT_SYSTEM_PREFIX}\n\n${text}` };
}

/**
 * Return a new messages array with the snapshot system message prepended. When there is no text the
 * original array is returned unchanged. Never mutates the input, never clobbers an existing message.
 * Pure.
 */
export function prependSnapshotMessage(messages, text) {
  if (!text) return messages;
  return [snapshotSystemMessage(text), ...messages];
}

/** Append ?brief=1 to the endpoint URL, tolerating a URL that is not absolute. Pure. */
function withBriefParam(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('brief', '1');
    return url.toString();
  } catch {
    return rawUrl.includes('?') ? `${rawUrl}&brief=1` : `${rawUrl}?brief=1`;
  }
}

/**
 * Build a snapshot provider. get() returns the latest snapshot as compact text, cached for ttlMs and
 * refetched lazily once stale. It returns null and logs at debug on any failure (unset url or token,
 * non-200, network error, bad JSON, or an empty snapshot), and never throws. Successful results are
 * cached; failures are not, so a transient outage is retried on the next turn.
 */
export function createSnapshotProvider({
  url = '',
  token = '',
  ttlMs = DEFAULT_TTL_MS,
  brief = false,
  fetchImpl = fetch,
  now = Date.now,
  log = console,
} = {}) {
  const inert = !url || !token;
  const debug = (message) => {
    try {
      log?.debug?.(`[snapshot] ${message}`);
    } catch {
      // A broken logger must never break a turn.
    }
  };

  let cachedText = null;
  let fetchedAt = null;
  let inFlight = null;

  async function refresh() {
    try {
      const target = brief ? withBriefParam(url) : url;
      const response = await fetchImpl(target, { headers: { Authorization: `Bearer ${token}` } });
      if (!response || !response.ok) {
        debug(`endpoint returned HTTP ${response ? response.status : 'no response'}`);
        return null;
      }
      const json = await response.json();
      const text = formatSnapshot(json);
      if (!text) debug('snapshot had no usable sections');
      return text;
    } catch (err) {
      debug(`fetch failed: ${err?.message ?? err}`);
      return null;
    }
  }

  async function get() {
    if (inert) return null;
    if (fetchedAt !== null && now() - fetchedAt < ttlMs) return cachedText;
    if (!inFlight) {
      inFlight = refresh().then((text) => {
        if (text) {
          cachedText = text;
          fetchedAt = now();
        }
        inFlight = null;
        return text;
      });
    }
    return inFlight;
  }

  return Object.freeze({ get });
}
