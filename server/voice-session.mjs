// One browser socket = one voice session. Wires the pure state machine to Nari STT, Hermes and Nari TTS.
import { nariRealtimeUrl } from './config.mjs';
import { streamHermes } from './hermes.mjs';
import { createSttClient } from './nari-stt.mjs';
import { pcmBytesToMs, streamSpeech } from './nari-tts.mjs';
import { assistantText, decodeClientMessage, encode, error as errorMessage } from './protocol.mjs';
import { emptySentenceBuffer, flushBuffer, pushDelta } from './sentences.mjs';
import { Effect, State, createSession, reduce } from './session.mjs';

const OPEN = 1;

function friendlyError(err) {
  if (err?.name === 'HermesError') return `Hermes is unreachable (${err.message})`;
  if (err?.name === 'TtsError') return `Speech synthesis failed (${err.message})`;
  return 'Something went wrong while answering';
}

export function createVoiceSession({ socket, config, sessionId, deps }) {
  const { fetchImpl = fetch, WebSocketImpl, log = console } = deps;
  let session = createSession();
  let active = null;
  let ackTimer = null;

  const sendJson = (message) => {
    if (socket.readyState === OPEN) socket.send(encode(message));
  };
  const sendBinary = (bytes) => {
    if (socket.readyState === OPEN) socket.send(bytes, { binary: true });
  };

  const stt = createSttClient({
    url: nariRealtimeUrl(config.nariApiUrl),
    apiKey: config.nariApiKey,
    model: config.nariSttModel,
    language: config.nariLanguage,
    turnDetection: config.nariTurnDetection,
    WebSocketImpl,
    log,
    onPartial: (text) => sendJson({ type: 'partial', text }),
    onFinal: (text) => dispatch({ type: 'final', text }),
    onError: (message) => sendJson(errorMessage(message)),
  });

  function dispatch(event) {
    const next = reduce(session, event);
    session = next.session;
    for (const effect of next.effects) runEffect(effect);
  }

  function runEffect(effect) {
    switch (effect.type) {
      case Effect.SEND:
        sendJson(effect.message);
        break;
      case Effect.ABORT_TURN:
        abortActive();
        break;
      case Effect.COMMIT_STT:
        stt.commit();
        break;
      case Effect.START_TURN:
        startTurn(effect.messages, effect.turn);
        break;
      case Effect.SPEAK_ACK:
        if (active && active.turn === effect.turn) enqueueSpeech(active, config.ackText, true);
        break;
      case Effect.ARM_ACK:
        clearTimeout(ackTimer);
        ackTimer = setTimeout(() => dispatch({ type: 'ack_due', turn: effect.turn }), config.ackDelayMs);
        break;
      case Effect.DISARM_ACK:
        clearTimeout(ackTimer);
        ackTimer = null;
        break;
      default:
        log.warn(`[session] unknown effect ${effect.type}`);
    }
  }

  function abortActive() {
    if (!active) return;
    const ctx = active;
    active = null;
    ctx.hermesAbort.abort();
    ctx.ttsAbort.abort();
  }

  function startTurn(messages, turn) {
    const ctx = {
      turn,
      hermesAbort: new AbortController(),
      ttsAbort: new AbortController(),
      ttsChain: Promise.resolve(),
      audioStarted: false,
      firstToken: false,
    };
    active = ctx;
    runHermesTurn(ctx, messages).catch((err) => log.error(`[session] turn ${turn} crashed: ${err.message}`));
  }

  async function runHermesTurn(ctx, messages) {
    let buffer = emptySentenceBuffer;
    try {
      const events = streamHermes({
        apiUrl: config.hermesApiUrl,
        apiKey: config.hermesApiKey,
        model: config.hermesModel,
        messages,
        sessionId,
        signal: ctx.hermesAbort.signal,
        fetchImpl,
      });
      for await (const event of events) {
        if (ctx !== active) return;
        if (event.type === 'delta') {
          if (!ctx.firstToken) {
            ctx.firstToken = true;
            dispatch({ type: 'first_token' });
          }
          sendJson(assistantText(event.text));
          const pushed = pushDelta(buffer, event.text);
          buffer = pushed.state;
          for (const sentence of pushed.sentences) enqueueSpeech(ctx, sentence, false);
        } else if (event.type === 'tool') {
          dispatch({ type: 'tool', name: event.name, status: event.status });
        } else if (event.type === 'done') {
          break;
        }
      }
      if (ctx !== active) return;
      const flushed = flushBuffer(buffer);
      for (const sentence of flushed.sentences) enqueueSpeech(ctx, sentence, false);
      await ctx.ttsChain;
      if (ctx !== active) return;
      dispatch({ type: 'turn_done', turn: ctx.turn });
    } catch (err) {
      if (ctx.hermesAbort.signal.aborted || ctx !== active) return;
      log.error(`[session] hermes turn failed: ${err.message}`);
      dispatch({ type: 'turn_error', turn: ctx.turn, message: friendlyError(err) });
    } finally {
      if (active === ctx) active = null;
    }
  }

  function enqueueSpeech(ctx, text, isAck) {
    ctx.ttsChain = ctx.ttsChain.then(async () => {
      if (ctx !== active || ctx.ttsAbort.signal.aborted) return;
      try {
        const bytes = await streamSpeech({
          apiUrl: config.nariApiUrl,
          apiKey: config.nariApiKey,
          model: config.nariTtsModel,
          voice: config.nariVoice,
          text,
          signal: ctx.ttsAbort.signal,
          fetchImpl,
          onChunk: (chunk) => {
            if (ctx !== active) return;
            if (!isAck && !ctx.audioStarted) {
              ctx.audioStarted = true;
              dispatch({ type: 'audio_started' });
            }
            sendBinary(chunk);
          },
        });
        if (ctx === active) dispatch({ type: 'segment_sent', text: isAck ? '' : text, ms: pcmBytesToMs(bytes), ack: isAck });
      } catch (err) {
        if (ctx.ttsAbort.signal.aborted || ctx !== active) return;
        log.error(`[session] tts failed: ${err.message}`);
        sendJson(errorMessage(friendlyError(err)));
      }
    });
  }

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      if (session.state !== State.IDLE) stt.sendAudio(data);
      return;
    }
    try {
      const message = decodeClientMessage(data.toString());
      dispatch(message);
    } catch (err) {
      sendJson(errorMessage(err.message));
    }
  });

  socket.on('close', () => {
    dispatch({ type: 'close' });
    stt.close();
  });

  socket.on('error', (err) => log.warn(`[session] browser socket error: ${err.message}`));

  dispatch({ type: 'open' });

  return {
    get state() {
      return session.state;
    },
  };
}
