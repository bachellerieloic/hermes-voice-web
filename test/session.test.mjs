import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, State, buildTurnMessages, createSession, heardText, interruptNote, reduce } from '../server/session.mjs';

const run = (events, start = createSession()) => events.reduce((acc, event) => {
  const r = reduce(acc.session, event);
  return { session: r.session, effects: [...acc.effects, ...r.effects] };
}, { session: start, effects: [] });

const types = (effects) => effects.map((e) => e.type);
const sent = (effects) => effects.filter((e) => e.type === Effect.SEND).map((e) => e.message);

test('open moves to listening and announces it', () => {
  const r = reduce(createSession(), { type: 'open' });
  assert.equal(r.session.state, State.LISTENING);
  assert.deepEqual(sent(r.effects), [{ type: 'status', state: 'listening' }]);
});

test('speech_end asks the runtime to commit the transcription', () => {
  const r = run([{ type: 'open' }, { type: 'speech_end' }]);
  assert.ok(types(r.effects).includes(Effect.COMMIT_STT));
});

test('a final transcript starts a turn with just the user message and arms the ack timer', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: '  what time is it ' }]);
  assert.equal(r.session.state, State.THINKING);
  assert.equal(r.session.turn, 1);
  const start = r.effects.find((e) => e.type === Effect.START_TURN);
  assert.deepEqual(start.messages, [{ role: 'user', content: 'what time is it' }]);
  assert.ok(types(r.effects).includes(Effect.ARM_ACK));
  assert.ok(sent(r.effects).some((m) => m.type === 'final' && m.text === 'what time is it'));
});

test('an empty final is ignored', () => {
  const opened = reduce(createSession(), { type: 'open' }).session;
  const r = reduce(opened, { type: 'final', text: '   ' });
  assert.equal(r.session, opened);
  assert.deepEqual(r.effects, []);
});

test('first token disarms the ack, audio starts speaking, turn_done returns to listening', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'first_token' }, { type: 'audio_started' }, { type: 'segment_sent', text: 'Hello.', ms: 500 }, { type: 'turn_done', turn: 1 }]);
  assert.equal(r.session.state, State.LISTENING);
  assert.ok(types(r.effects).includes(Effect.DISARM_ACK));
  assert.ok(sent(r.effects).some((m) => m.type === 'status' && m.state === 'speaking'));
  assert.ok(sent(r.effects).some((m) => m.type === 'assistant_text' && m.done === true));
});

test('a stale turn_done does not touch the current turn', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'turn_done', turn: 0 }]);
  assert.equal(r.session.state, State.THINKING);
});

test('tool progress is surfaced as a status detail while thinking', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'tool', name: 'terminal', status: 'started' }]);
  assert.ok(sent(r.effects).some((m) => m.type === 'status' && m.state === 'thinking' && m.detail === 'terminal: started'));
});

test('ack is spoken once when no token has arrived, never after the first token', () => {
  const early = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'ack_due', turn: 1 }, { type: 'ack_due', turn: 1 }]);
  assert.equal(types(early.effects).filter((t) => t === Effect.SPEAK_ACK).length, 1);
  const late = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'first_token' }, { type: 'ack_due', turn: 1 }]);
  assert.ok(!types(late.effects).includes(Effect.SPEAK_ACK));
});

test('barge-in while speaking aborts the turn, flushes the client and records what was heard', () => {
  const speaking = run([{ type: 'open' }, { type: 'final', text: 'tell me a story' }, { type: 'first_token' }, { type: 'audio_started' }, { type: 'segment_sent', text: 'Once upon a time there was a fox.', ms: 2000 }, { type: 'segment_sent', text: 'It was clever.', ms: 1000 }]);
  const interrupted = reduce(speaking.session, { type: 'interrupt' });
  assert.equal(interrupted.session.state, State.LISTENING);
  assert.equal(interrupted.session.interrupted, true);
  assert.deepEqual(types(interrupted.effects).slice(0, 2), [Effect.ABORT_TURN, Effect.DISARM_ACK]);
  assert.ok(sent(interrupted.effects).some((m) => m.type === 'flush'));
  const heard = reduce(interrupted.session, { type: 'heard_ms', ms: 1000 });
  const next = reduce(heard.session, { type: 'final', text: 'stop, what about the hen' });
  const start = next.effects.find((e) => e.type === Effect.START_TURN);
  assert.equal(start.messages.length, 2);
  assert.equal(start.messages[0].role, 'system');
  assert.match(start.messages[0].content, /interrupted/);
  assert.match(start.messages[0].content, /"Once upon a time"/);
  assert.deepEqual(start.messages[1], { role: 'user', content: 'stop, what about the hen' });
  assert.equal(next.session.interrupted, false);
  assert.deepEqual(next.session.segments, []);
});

test('speech_start while thinking counts as an interrupt', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'speech_start' }]);
  assert.equal(r.session.state, State.LISTENING);
  assert.ok(types(r.effects).includes(Effect.ABORT_TURN));
});

test('a final transcript arriving mid-answer aborts the old turn and starts a new one with a note', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: 'first' }, { type: 'audio_started' }, { type: 'segment_sent', text: 'Sure thing.', ms: 800 }, { type: 'final', text: 'second' }]);
  assert.equal(r.session.state, State.THINKING);
  assert.equal(r.session.turn, 2);
  const starts = r.effects.filter((e) => e.type === Effect.START_TURN);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].messages[0].role, 'system');
  assert.ok(types(r.effects).includes(Effect.ABORT_TURN));
});

test('an interrupt while audio is still draining after the turn ended still flushes and annotates', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'audio_started' }, { type: 'segment_sent', text: 'Hello friend.', ms: 900 }, { type: 'turn_done', turn: 1 }, { type: 'interrupt' }, { type: 'heard_ms', ms: 0 }, { type: 'final', text: 'again' }]);
  assert.ok(sent(r.effects).filter((m) => m.type === 'flush').length >= 1);
  const start = r.effects.filter((e) => e.type === Effect.START_TURN).at(-1);
  assert.match(start.messages[0].content, /before any of its previous reply was heard/);
});

test('close aborts and goes idle; interrupts while idle are ignored', () => {
  const r = run([{ type: 'open' }, { type: 'final', text: 'hi' }, { type: 'close' }]);
  assert.equal(r.session.state, State.IDLE);
  assert.ok(types(r.effects).includes(Effect.ABORT_TURN));
  const idle = reduce(r.session, { type: 'interrupt' });
  assert.deepEqual(idle.effects, []);
  assert.deepEqual(reduce(r.session, { type: 'unknown' }).effects, []);
});

test('heardText truncates by played milliseconds, proportionally inside a segment', () => {
  const segments = [{ text: 'one two three four', ms: 1000 }, { text: 'five six', ms: 500 }];
  assert.equal(heardText(segments, 1250), 'one two three four five');
  assert.equal(heardText(segments, 1500), 'one two three four five six');
  assert.equal(heardText(segments, 100), '');
  assert.equal(heardText(segments, 0), '');
});

test('heardText skips the acknowledgement audio but still spends its time', () => {
  const segments = [{ text: '', ms: 400, ack: true }, { text: 'a b c d', ms: 1000 }];
  assert.equal(heardText(segments, 900), 'a b');
});

test('interruptNote falls back to everything sent when heard_ms is unknown', () => {
  assert.match(interruptNote([{ text: 'Hello there.', ms: 500 }], null), /"Hello there\."/);
  assert.match(interruptNote([], null), /before any/);
  const session = { ...createSession(), interrupted: true, segments: [{ text: 'A b c.', ms: 300 }], heardMs: 300 };
  assert.equal(buildTurnMessages(session, 'x').length, 2);
});
