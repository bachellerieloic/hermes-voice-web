// Pure conversation state machine. reduce(session, event) returns a new session and a list of
// effects for the runtime to perform; nothing in here touches the network or timers.
import { assistantText, error, final, flush, status } from './protocol.mjs';

export const State = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
});

export const Effect = Object.freeze({
  SEND: 'send',
  ABORT_TURN: 'abort_turn',
  COMMIT_STT: 'commit_stt',
  START_TURN: 'start_turn',
  SPEAK_ACK: 'speak_ack',
  ARM_ACK: 'arm_ack',
  DISARM_ACK: 'disarm_ack',
});

const send = (message) => ({ type: Effect.SEND, message });

export function createSession() {
  return Object.freeze({
    state: State.IDLE,
    turn: 0,
    segments: Object.freeze([]),
    interrupted: false,
    heardMs: null,
    ackSpoken: false,
    gotFirstToken: false,
  });
}

const isBusy = (session) => session.state === State.THINKING || session.state === State.SPEAKING;
const patch = (session, changes) => Object.freeze({ ...session, ...changes });
const result = (session, effects = []) => ({ session, effects });

/** Text the user actually heard, given the audio segments sent and how many ms were played. Pure. */
export function heardText(segments, heardMs) {
  const words = [];
  let budget = heardMs;
  for (const segment of segments) {
    if (budget <= 0) break;
    if (segment.ms <= budget) {
      budget -= segment.ms;
      if (!segment.ack && segment.text) words.push(segment.text);
      continue;
    }
    if (!segment.ack && segment.text) {
      const parts = segment.text.split(' ');
      const count = Math.floor((parts.length * budget) / segment.ms);
      if (count > 0) words.push(parts.slice(0, count).join(' '));
    }
    break;
  }
  return words.join(' ').trim();
}

/** System note prepended to the next user turn after a barge-in. Pure. */
export function interruptNote(segments, heardMs) {
  const spoken = segments.filter((s) => !s.ack && s.text).map((s) => s.text).join(' ').trim();
  const heard = heardMs === null ? spoken : heardText(segments, heardMs);
  if (!heard) {
    return 'The assistant was interrupted by the user before any of its previous reply was heard. Answer the new message directly.';
  }
  return `The assistant was interrupted by the user. Of its previous reply the user heard only: "${heard}". Answer the new message; do not repeat what was already heard unless asked.`;
}

/** Messages for the next Hermes request. The transcript lives in Hermes (session header), so only the new turn is sent. */
export function buildTurnMessages(session, userText) {
  const note = session.interrupted ? [{ role: 'system', content: interruptNote(session.segments, session.heardMs) }] : [];
  return [...note, { role: 'user', content: userText }];
}

function startTurn(session, text) {
  const turn = session.turn + 1;
  const messages = buildTurnMessages(session, text);
  const next = patch(session, {
    state: State.THINKING,
    turn,
    segments: Object.freeze([]),
    interrupted: false,
    heardMs: null,
    ackSpoken: false,
    gotFirstToken: false,
  });
  return result(next, [
    send(final(text)),
    send(status(State.THINKING)),
    { type: Effect.START_TURN, turn, messages },
    { type: Effect.ARM_ACK, turn },
  ]);
}

function interrupt(session) {
  if (isBusy(session)) {
    const next = patch(session, { state: State.LISTENING, interrupted: true });
    return result(next, [{ type: Effect.ABORT_TURN }, { type: Effect.DISARM_ACK }, send(flush()), send(status(State.LISTENING))]);
  }
  if (session.state === State.LISTENING && session.segments.length > 0) {
    return result(patch(session, { interrupted: true }), [send(flush())]);
  }
  return result(session);
}

const handlers = {
  open: (session) => result(patch(createSession(), { state: State.LISTENING }), [send(status(State.LISTENING))]),

  close: (session) => result(patch(session, { state: State.IDLE }), [{ type: Effect.ABORT_TURN }, { type: Effect.DISARM_ACK }]),

  speech_start: (session) => (isBusy(session) ? interrupt(session) : result(session)),

  speech_end: (session) => (session.state === State.IDLE ? result(session) : result(session, [{ type: Effect.COMMIT_STT }])),

  interrupt: (session) => interrupt(session),

  heard_ms: (session, event) => result(patch(session, { heardMs: event.ms })),

  final: (session, event) => {
    const text = String(event.text ?? '').trim();
    if (session.state === State.IDLE || text === '') return result(session);
    if (!isBusy(session)) return startTurn(session, text);
    const stopped = patch(session, { state: State.LISTENING, interrupted: true });
    const started = startTurn(stopped, text);
    return result(started.session, [{ type: Effect.ABORT_TURN }, { type: Effect.DISARM_ACK }, send(flush()), ...started.effects]);
  },

  first_token: (session) => (session.state === State.THINKING || session.state === State.SPEAKING
    ? result(patch(session, { gotFirstToken: true }), [{ type: Effect.DISARM_ACK }])
    : result(session)),

  tool: (session, event) => (isBusy(session)
    ? result(session, [send(status(session.state, `${event.name}: ${event.status}`))])
    : result(session)),

  audio_started: (session) => (session.state === State.THINKING
    ? result(patch(session, { state: State.SPEAKING }), [send(status(State.SPEAKING))])
    : result(session)),

  segment_sent: (session, event) => (isBusy(session)
    ? result(patch(session, { segments: Object.freeze([...session.segments, { text: event.text ?? '', ms: event.ms, ack: Boolean(event.ack) }]) }))
    : result(session)),

  turn_done: (session, event) => (isBusy(session) && event.turn === session.turn
    ? result(patch(session, { state: State.LISTENING }), [send(assistantText('', true)), send(status(State.LISTENING))])
    : result(session)),

  turn_error: (session, event) => (isBusy(session) && event.turn === session.turn
    ? result(patch(session, { state: State.LISTENING }), [send(error(event.message)), send(status(State.LISTENING))])
    : result(session)),

  ack_due: (session, event) => (session.state === State.THINKING && !session.gotFirstToken && !session.ackSpoken && event.turn === session.turn
    ? result(patch(session, { ackSpoken: true }), [{ type: Effect.SPEAK_ACK, turn: session.turn }])
    : result(session)),
};

export function reduce(session, event) {
  const handler = handlers[event?.type];
  if (!handler) return result(session);
  return handler(session, event);
}
