// WebSocket client for Nari Labs realtime transcription with chunking, lazy connect and reconnect.

export const MAX_PCM_BYTES_PER_FRAME = 48 * 1024;
export const MAX_QUEUED_PCM_BYTES = 16000 * 2 * 8; // 8 seconds of 16 kHz PCM16 while (re)connecting
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const NORMAL_CLOSE = 1000;

/** Split PCM into frames of at most `max` bytes, never cutting a 16-bit sample in half. Pure. */
export function chunkPcm(buffer, max = MAX_PCM_BYTES_PER_FRAME) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const evenMax = max - (max % 2);
  const usable = bytes.length - (bytes.length % 2);
  const frames = [];
  for (let offset = 0; offset < usable; offset += evenMax) {
    frames.push(bytes.subarray(offset, Math.min(offset + evenMax, usable)));
  }
  return frames;
}

export function buildAppendMessage(frame) {
  return JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(frame).toString('base64') });
}

export function buildCommitMessage() {
  return JSON.stringify({ type: 'input_audio_buffer.commit' });
}

export function buildConfigureMessage({ model, language, turnDetection }) {
  return JSON.stringify({
    type: 'session.configure',
    session: {
      model,
      language: language || null,
      turn_detection: turnDetection === 'server_vad' ? { type: 'server_vad' } : null,
    },
  });
}

function describeServerError(payload) {
  const err = payload.error ?? payload;
  const code = err.code ?? err.type ?? 'error';
  const message = err.message ?? 'unknown transcription error';
  return `${code}: ${message}`;
}

/**
 * Create a lazy transcription client. Audio sent before the session is configured is queued.
 * Callbacks: onPartial(text), onFinal(text, reason), onError(message), onOpen().
 */
export function createSttClient({ url, apiKey, model, language, turnDetection, WebSocketImpl, onPartial, onFinal, onError, onOpen, log = console }) {
  let socket = null;
  let configured = false;
  let closedByUs = false;
  let failures = 0;
  let nextAttemptAt = 0;
  let queue = [];
  let queuedBytes = 0;
  let pendingCommit = false;

  const connected = () => socket !== null && configured;

  function connect() {
    if (socket) return;
    if (Date.now() < nextAttemptAt) return;
    const ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    socket = ws;
    configured = false;
    ws.on('open', () => ws.send(buildConfigureMessage({ model, language, turnDetection })));
    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('error', (err) => {
      if (ws !== socket) return;
      log.warn(`[stt] socket error: ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      if (ws !== socket) return;
      socket = null;
      const wasConfigured = configured;
      configured = false;
      if (closedByUs) return;
      if (!wasConfigured) {
        failures += 1;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (failures - 1));
        nextAttemptAt = Date.now() + delay;
        onError?.(`Transcription connection failed (${code} ${String(reason ?? '')}); retrying in ${Math.round(delay / 1000)} s`);
      } else if (code !== NORMAL_CLOSE) {
        log.info(`[stt] connection closed (${code}); will reconnect on next audio`);
      }
    });
  }

  function handleMessage(ws, data) {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (payload.type) {
      case 'session.configured':
        configured = true;
        failures = 0;
        nextAttemptAt = 0;
        onOpen?.();
        drain(ws);
        break;
      case 'transcript.partial':
        onPartial?.(String(payload.transcript ?? ''));
        break;
      case 'transcript.completed':
        onFinal?.(String(payload.transcript ?? ''), String(payload.commit_reason ?? 'manual'));
        break;
      case 'error':
        onError?.(describeServerError(payload));
        break;
      default:
        break;
    }
  }

  function drain(ws) {
    for (const frame of queue) ws.send(buildAppendMessage(frame));
    queue = [];
    queuedBytes = 0;
    if (pendingCommit) {
      pendingCommit = false;
      ws.send(buildCommitMessage());
    }
  }

  function enqueue(frame) {
    if (queuedBytes + frame.length > MAX_QUEUED_PCM_BYTES) {
      const drop = queue.shift();
      if (drop) queuedBytes -= drop.length;
    }
    queue = [...queue, frame];
    queuedBytes += frame.length;
  }

  return {
    get connected() {
      return connected();
    },
    sendAudio(pcm) {
      const frames = chunkPcm(pcm);
      if (connected()) {
        for (const frame of frames) socket.send(buildAppendMessage(frame));
        return;
      }
      for (const frame of frames) enqueue(frame);
      connect();
    },
    commit() {
      if (connected()) {
        socket.send(buildCommitMessage());
        return;
      }
      if (queue.length > 0) {
        pendingCommit = true;
        connect();
      }
    },
    close() {
      closedByUs = true;
      queue = [];
      queuedBytes = 0;
      if (socket) {
        try {
          socket.close(NORMAL_CLOSE);
        } catch {
          // already closing
        }
        socket = null;
      }
    },
  };
}
