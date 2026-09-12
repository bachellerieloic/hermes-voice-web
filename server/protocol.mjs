// JSON control messages exchanged with the browser. Binary WebSocket frames carry audio:
// browser to gateway = 16 kHz PCM16 mono, gateway to browser = 24 kHz PCM16 mono.

export const ServerMessage = Object.freeze({
  PARTIAL: 'partial',
  FINAL: 'final',
  STATUS: 'status',
  ASSISTANT_TEXT: 'assistant_text',
  TURN_DONE: 'turn_done',
  FLUSH: 'flush',
  ERROR: 'error',
});

export const ClientMessage = Object.freeze({
  INTERRUPT: 'interrupt',
  HEARD_MS: 'heard_ms',
  SPEECH_START: 'speech_start',
  SPEECH_END: 'speech_end',
});

const CLIENT_TYPES = new Set(Object.values(ClientMessage));
const SERVER_TYPES = new Set(Object.values(ServerMessage));
const MAX_CONTROL_BYTES = 4096;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export const partial = (text) => ({ type: ServerMessage.PARTIAL, text });
export const final = (text) => ({ type: ServerMessage.FINAL, text });
export const status = (state, detail) => (detail === undefined ? { type: ServerMessage.STATUS, state } : { type: ServerMessage.STATUS, state, detail });
export const assistantText = (text, done = false) => ({ type: ServerMessage.ASSISTANT_TEXT, text, done });
export const turnDone = (turn) => ({ type: ServerMessage.TURN_DONE, turn });
export const flush = () => ({ type: ServerMessage.FLUSH });
export const error = (message) => ({ type: ServerMessage.ERROR, message });

export function encode(message) {
  if (!message || !SERVER_TYPES.has(message.type)) {
    throw new ProtocolError(`Unknown server message type: ${message?.type}`);
  }
  return JSON.stringify(message);
}

/** Parse a text frame from the browser. Throws ProtocolError on anything unexpected. */
export function decodeClientMessage(text) {
  if (typeof text !== 'string' || text.length > MAX_CONTROL_BYTES) {
    throw new ProtocolError('Control message too large or not text');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError('Control message is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !CLIENT_TYPES.has(parsed.type)) {
    throw new ProtocolError(`Unknown client message type: ${parsed?.type}`);
  }
  if (parsed.type === ClientMessage.HEARD_MS) {
    const ms = Number(parsed.ms);
    if (!Number.isFinite(ms) || ms < 0) throw new ProtocolError('heard_ms.ms must be a non-negative number');
    return { type: ClientMessage.HEARD_MS, ms: Math.floor(ms) };
  }
  return { type: parsed.type };
}
