import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_SYSTEM_PREFIX,
  createSnapshotProvider,
  formatSnapshot,
  formatWow,
  prependSnapshotMessage,
  snapshotSystemMessage,
} from '../server/snapshot.mjs';

function fullPayload(overrides = {}) {
  return {
    generatedAt: '2026-09-12T18:59:00Z',
    timezone: 'America/Vancouver',
    web: {
      ga4: {
        range: { startDate: '2026-09-05', endDate: '2026-09-11' },
        previousRange: { startDate: '2026-08-29', endDate: '2026-09-04' },
        sessions: 1503,
        conversions: 0,
        wow: {
          sessions: { abs: 1356, pct: 929.2, arrow: 'up' },
          conversions: { abs: 0, pct: 0, arrow: 'flat' },
        },
      },
      gsc: {
        range: { startDate: '2026-09-03', endDate: '2026-09-09' },
        previousRange: { startDate: '2026-08-27', endDate: '2026-09-02' },
        clicks: 31,
        impressions: 1784,
        wow: {
          clicks: { abs: 3, pct: 10.7, arrow: 'up' },
          impressions: { abs: 5, pct: 0.28, arrow: 'flat' },
        },
      },
      brief: null,
    },
    revenue: { mrr: 98, currency: 'CAD', activeSubscriptions: 2 },
    members: { totalActive: 187, newThisMonth: 3 },
    dinners: { upcoming: [{ city: 'Vancouver', date: '2026-09-18', status: 'open' }, { city: 'Toronto', date: '2026-09-25', status: 'open' }] },
    errors: [],
    ...overrides,
  };
}

test('formatSnapshot renders a full payload as compact speakable text', () => {
  const text = formatSnapshot(fullPayload());
  assert.equal(text, [
    'Business snapshot (generated 2026-09-12 11:59 America/Vancouver):',
    'Web, Sep 5 to Sep 11: 1503 sessions, up 929% week over week; 0 conversions. Search Sep 3 to Sep 9: 31 clicks, 1784 impressions, clicks up 11%.',
    'Revenue: MRR 98 CAD, 2 active subscriptions.',
    'Members: 187 active, 3 new this month.',
    'Upcoming dinners: Vancouver Sep 18 (open), Toronto Sep 25 (open).',
  ].join('\n'));
});

test('formatSnapshot omits each null section and keeps the rest', () => {
  const noWeb = formatSnapshot(fullPayload({ web: null }));
  assert.doesNotMatch(noWeb, /Web/);
  assert.match(noWeb, /Revenue: MRR 98 CAD/);

  const noRevenue = formatSnapshot(fullPayload({ revenue: null }));
  assert.doesNotMatch(noRevenue, /Revenue/);
  assert.match(noRevenue, /Members: 187 active/);

  const noMembers = formatSnapshot(fullPayload({ members: null }));
  assert.doesNotMatch(noMembers, /Members/);
  assert.match(noMembers, /Upcoming dinners/);

  const noDinners = formatSnapshot(fullPayload({ dinners: null }));
  assert.doesNotMatch(noDinners, /Upcoming dinners/);
  assert.match(noDinners, /Members: 187 active/);
});

test('formatSnapshot returns null when every section is null or the payload is not an object', () => {
  assert.equal(formatSnapshot(fullPayload({ web: null, revenue: null, members: null, dinners: null })), null);
  assert.equal(formatSnapshot(null), null);
  assert.equal(formatSnapshot('nope'), null);
});

test('formatSnapshot reports an empty dinners list as none scheduled', () => {
  const text = formatSnapshot(fullPayload({ dinners: { upcoming: [] } }));
  assert.match(text, /Upcoming dinners: none scheduled\./);
});

test('formatSnapshot includes the web brief on its own line only when present', () => {
  const withBrief = formatSnapshot(fullPayload({ web: { ...fullPayload().web, brief: 'Traffic spiked from a Reddit post.' } }));
  assert.match(withBrief, /Web brief: Traffic spiked from a Reddit post\./);
  const withoutBrief = formatSnapshot(fullPayload());
  assert.doesNotMatch(withoutBrief, /Web brief/);
});

test('formatWow rounds percentages to whole numbers and speaks up, down or flat', () => {
  assert.deepEqual(formatWow({ pct: 10.7, arrow: 'up' }), { word: 'up', text: 'up 11%' });
  assert.deepEqual(formatWow({ pct: -4.6, arrow: 'down' }), { word: 'down', text: 'down 5%' });
  assert.deepEqual(formatWow({ pct: 0, arrow: 'flat' }), { word: 'flat', text: 'flat' });
  assert.equal(formatWow(null), null);
});

test('formatWow translates arrow glyphs to words and never emits a glyph', () => {
  assert.equal(formatWow({ pct: -12.4, arrow: '↓' }).word, 'down');
  assert.equal(formatWow({ pct: 3.2, arrow: '↑' }).text, 'up 3%');
  assert.equal(formatWow({ pct: 0.1, arrow: '→' }).text, 'flat');
  // Falls back to the sign of the percent when the arrow is missing.
  assert.equal(formatWow({ pct: -8 }).word, 'down');
  assert.equal(formatWow({ pct: 8 }).word, 'up');
});

test('snapshotSystemMessage and prependSnapshotMessage build the system note without mutating input', () => {
  const message = snapshotSystemMessage('SNAP');
  assert.equal(message.role, 'system');
  assert.equal(message.content, `${SNAPSHOT_SYSTEM_PREFIX}\n\nSNAP`);

  const base = [{ role: 'user', content: 'hi' }];
  const prepended = prependSnapshotMessage(base, 'SNAP');
  assert.equal(prepended.length, 2);
  assert.equal(prepended[0].role, 'system');
  assert.deepEqual(prepended[1], { role: 'user', content: 'hi' });
  assert.deepEqual(base, [{ role: 'user', content: 'hi' }], 'the input array is untouched');

  assert.strictEqual(prependSnapshotMessage(base, null), base, 'no text means no change');
});

function okResponse(json) {
  return { ok: true, status: 200, json: async () => json };
}

test('provider get returns formatted text and caches within the TTL', async () => {
  let calls = 0;
  const clock = { value: 1000 };
  const provider = createSnapshotProvider({
    url: 'https://snap.test/agent',
    token: 'secret-token',
    ttlMs: 5000,
    fetchImpl: async () => { calls += 1; return okResponse(fullPayload()); },
    now: () => clock.value,
    log: { debug() {} },
  });

  const first = await provider.get();
  assert.match(first, /Business snapshot/);
  assert.equal(calls, 1);

  clock.value = 4000; // still inside the TTL window
  await provider.get();
  assert.equal(calls, 1, 'a second get within the TTL does not refetch');

  clock.value = 7000; // past the TTL
  await provider.get();
  assert.equal(calls, 2, 'a get after the TTL refetches');
});

test('provider sends the bearer token and only asks for the brief when enabled', async () => {
  const seen = [];
  const make = (brief) => createSnapshotProvider({
    url: 'https://snap.test/agent',
    token: 'secret-token',
    brief,
    fetchImpl: async (url, options) => { seen.push({ url, options }); return okResponse(fullPayload()); },
    log: { debug() {} },
  });

  await make(false).get();
  assert.equal(seen[0].url, 'https://snap.test/agent');
  assert.equal(seen[0].options.headers.Authorization, 'Bearer secret-token');

  await make(true).get();
  assert.equal(seen[1].url, 'https://snap.test/agent?brief=1');
});

test('provider is inert and never fetches when the url or token is empty', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return okResponse(fullPayload()); };
  const noUrl = createSnapshotProvider({ url: '', token: 'secret-token', fetchImpl, log: { debug() {} } });
  const noToken = createSnapshotProvider({ url: 'https://snap.test/agent', token: '', fetchImpl, log: { debug() {} } });
  assert.equal(await noUrl.get(), null);
  assert.equal(await noToken.get(), null);
  assert.equal(calls, 0);
});

test('provider returns null on a non-200 response', async () => {
  const provider = createSnapshotProvider({
    url: 'https://snap.test/agent',
    token: 'secret-token',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    log: { debug() {} },
  });
  assert.equal(await provider.get(), null);
});

test('provider returns null when fetch throws', async () => {
  const provider = createSnapshotProvider({
    url: 'https://snap.test/agent',
    token: 'secret-token',
    fetchImpl: async () => { throw new Error('network down'); },
    log: { debug() {} },
  });
  assert.equal(await provider.get(), null);
});

test('provider returns null on malformed JSON', async () => {
  const provider = createSnapshotProvider({
    url: 'https://snap.test/agent',
    token: 'secret-token',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('unexpected token'); } }),
    log: { debug() {} },
  });
  assert.equal(await provider.get(), null);
});

test('provider does not cache a failure, so the next turn retries', async () => {
  let calls = 0;
  const provider = createSnapshotProvider({
    url: 'https://snap.test/agent',
    token: 'secret-token',
    ttlMs: 60000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return okResponse(fullPayload());
    },
    now: () => 1000,
    log: { debug() {} },
  });
  assert.equal(await provider.get(), null);
  assert.match(await provider.get(), /Business snapshot/);
  assert.equal(calls, 2);
});
