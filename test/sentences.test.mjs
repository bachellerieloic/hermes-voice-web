import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanForSpeech, emptySentenceBuffer, flushBuffer, pushDelta, splitForTts } from '../server/sentences.mjs';

function feed(deltas) {
  let state = emptySentenceBuffer;
  const out = [];
  for (const delta of deltas) {
    const r = pushDelta(state, delta);
    state = r.state;
    out.push(...r.sentences);
  }
  return { state, out };
}

test('emits a sentence once its end is followed by whitespace', () => {
  const { state, out } = feed(['Hello ', 'there. How']);
  assert.deepEqual(out, ['Hello there.']);
  assert.equal(state.text, 'How');
});

test('holds a trailing period until the next delta proves it ends a sentence', () => {
  const first = feed(['Version 3.']);
  assert.deepEqual(first.out, []);
  const r = pushDelta(first.state, '5 is out. ');
  assert.deepEqual(r.sentences, ['Version 3.5 is out.']);
});

test('treats newlines as boundaries and strips list markers', () => {
  const { out } = feed(['- item one\n- item two\n']);
  assert.deepEqual(out, ['item one', 'item two']);
});

test('replaces code blocks with a spoken placeholder and waits for the closing fence', () => {
  const { state, out } = feed(['Run this:\n```js\nconsole.log(1). done\n']);
  assert.deepEqual(out, ['Run this:']);
  assert.ok(state.text.includes('```'));
  const r = pushDelta(state, '```\nDone. ');
  assert.deepEqual(r.sentences, ['code omitted.', 'Done.']);
});

test('flush emits the remainder and treats an unclosed fence as omitted code', () => {
  const { state } = feed(['Final words', ' here ```py\nx = 1']);
  const r = flushBuffer(state);
  assert.deepEqual(r.sentences, ['Final words here code omitted.']);
  assert.equal(r.state.text, '');
});

test('cleanForSpeech strips markdown, links and inline code', () => {
  assert.equal(cleanForSpeech('**Bold** and `code` and [a link](http://x.test) here.'), 'Bold and code and a link here.');
  assert.equal(cleanForSpeech('## Heading\n> quoted _text_'), 'Heading quoted text');
  assert.equal(cleanForSpeech('<think>hidden</think>Visible.'), 'Visible.');
  assert.equal(cleanForSpeech('See https://example.test/path now'), 'See a link now');
});

test('splitForTts keeps every piece within the code point limit and splits on spaces', () => {
  const words = Array.from({ length: 900 }, (_, i) => `word${i}`);
  const text = words.join(' ');
  const pieces = splitForTts(text, 2048);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(Array.from(piece).length <= 2048);
  assert.equal(pieces.join(' '), text);
});

test('splitForTts counts code points, not UTF-16 units', () => {
  const text = '😀'.repeat(2049);
  const pieces = splitForTts(text);
  assert.equal(pieces.length, 2);
  assert.equal(Array.from(pieces[0]).length, 2048);
  assert.deepEqual(splitForTts(''), []);
});
