import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySseState, feedSse, parseHermesEvent } from '../server/sse.mjs';

test('feedSse reassembles events split across chunks', () => {
  const a = feedSse(emptySseState, 'data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(a.events, [{ event: 'message', data: '{"a":1}' }]);
  const b = feedSse(a.state, ':2}\n\n');
  assert.deepEqual(b.events, [{ event: 'message', data: '{"b":2}' }]);
  assert.equal(b.state.buffer, '');
});

test('feedSse handles event names, comments, CRLF and multi-line data', () => {
  const r = feedSse(emptySseState, ': keepalive\r\nevent: hermes.tool.progress\r\ndata: {"x":\r\ndata: 1}\r\n\r\n');
  assert.deepEqual(r.events, [{ event: 'hermes.tool.progress', data: '{"x":\n1}' }]);
});

test('parseHermesEvent maps deltas, tool progress, finish and DONE', () => {
  const delta = parseHermesEvent({ event: 'message', data: JSON.stringify({ object: 'chat.completion.chunk', choices: [{ delta: { content: 'Hi' } }] }) });
  assert.deepEqual(delta, { type: 'delta', text: 'Hi' });
  const tool = parseHermesEvent({ event: 'message', data: JSON.stringify({ object: 'hermes.tool.progress', tool_name: 'terminal', status: 'started' }) });
  assert.deepEqual(tool, { type: 'tool', name: 'terminal', status: 'started' });
  const finish = parseHermesEvent({ event: 'message', data: JSON.stringify({ object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] }) });
  assert.deepEqual(finish, { type: 'done', finishReason: 'stop' });
  assert.deepEqual(parseHermesEvent({ event: 'message', data: '[DONE]' }), { type: 'done', finishReason: 'done' });
  assert.deepEqual(parseHermesEvent({ event: 'message', data: 'not json' }), { type: 'ignore' });
  assert.deepEqual(parseHermesEvent({ event: 'message', data: JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }) }), { type: 'ignore' });
});
