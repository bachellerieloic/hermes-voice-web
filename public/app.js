// Browser client: mic capture, Silero VAD barge-in, echo-safe playback, and the gateway protocol.
// Everything is relative to the page URL so the app works under any BASE_PATH.

const STORAGE_TOKEN = 'hermes-voice.token';
const STORAGE_SESSION = 'hermes-voice.session';
const MIC_FRAME_MS = 40;
const PREROLL_MS = 300;
const POST_PLAYBACK_GATE_MS = 500;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const VAD_OPTIONS = Object.freeze({
  model: 'v5',
  positiveSpeechThreshold: 0.6,
  negativeSpeechThreshold: 0.4,
  redemptionMs: 700,
  preSpeechPadMs: 300,
  minSpeechMs: 300,
});

const el = {
  orb: document.getElementById('orb'),
  status: document.getElementById('status'),
  partial: document.getElementById('partial'),
  assistant: document.getElementById('assistant'),
  mute: document.getElementById('mute'),
  stop: document.getElementById('stop'),
  dialog: document.getElementById('tokenDialog'),
  tokenInput: document.getElementById('tokenInput'),
  tokenSave: document.getElementById('tokenSave'),
  changeToken: document.getElementById('changeToken'),
  newConversation: document.getElementById('newConversation'),
  loopback: document.getElementById('loopback'),
};

const app = {
  audioContext: null,
  micStream: null,
  micNode: null,
  playerNode: null,
  vad: null,
  socket: null,
  wakeLock: null,
  sessionOpen: false,
  muted: false,
  serverState: 'idle',
  vadSpeaking: false,
  playedMs: 0,
  queuedAudio: false,
  gateUntil: 0,
  preroll: [],
  reconnectDelay: RECONNECT_MIN_MS,
  reconnectTimer: null,
  assistantBuffer: '',
};

// ---------- small helpers ----------

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

function setOrb(state) {
  el.orb.dataset.state = state;
}

function refreshOrb() {
  if (!app.sessionOpen) return setOrb('idle');
  if (app.vadSpeaking) return setOrb('hearing');
  if (app.serverState === 'speaking' || app.queuedAudio) return setOrb('speaking');
  setOrb(app.serverState);
}

function sessionId() {
  const existing = storage.get(STORAGE_SESSION);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  storage.set(STORAGE_SESSION, fresh);
  return fresh;
}

function gatewayUrl(token) {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('session', sessionId());
  return url.toString();
}

function sendJson(message) {
  if (app.socket?.readyState === WebSocket.OPEN) app.socket.send(JSON.stringify(message));
}

function micOpen() {
  if (!app.sessionOpen || app.muted || app.socket?.readyState !== WebSocket.OPEN) return false;
  if (app.serverState === 'listening' && !app.queuedAudio) return Date.now() >= app.gateUntil;
  return app.vadSpeaking;
}

// ---------- audio graph ----------

async function ensureAudioContext() {
  if (!app.audioContext) {
    app.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }
  if (app.audioContext.state !== 'running') await app.audioContext.resume();
  return app.audioContext;
}

async function setupPlayback(context) {
  await context.audioWorklet.addModule(new URL('worklets/player.js', location.href));
  const player = new AudioWorkletNode(context, 'hermes-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  player.port.onmessage = (event) => {
    const data = event.data;
    if (data?.type === 'played') {
      app.playedMs = data.ms;
      app.queuedAudio = true;
      refreshOrb();
    } else if (data?.type === 'drained') {
      app.playedMs = data.ms;
      app.queuedAudio = false;
      app.gateUntil = Date.now() + POST_PLAYBACK_GATE_MS;
      refreshOrb();
    }
  };
  app.playerNode = player;
  const routed = await routeThroughLoopback(context, player).catch(() => false);
  if (!routed) player.connect(context.destination);
}

// Chromium's echo canceller only sees audio that leaves through a media element, not Web Audio.
// Route the player into a local WebRTC loopback and play the remote track in an <audio> element.
async function routeThroughLoopback(context, player) {
  if (typeof RTCPeerConnection === 'undefined') return false;
  const destination = context.createMediaStreamDestination();
  player.connect(destination);
  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  sender.onicecandidate = (e) => e.candidate && receiver.addIceCandidate(e.candidate).catch(() => {});
  receiver.onicecandidate = (e) => e.candidate && sender.addIceCandidate(e.candidate).catch(() => {});
  receiver.ontrack = (e) => {
    el.loopback.srcObject = e.streams[0];
    el.loopback.play().catch(() => {});
  };
  for (const track of destination.stream.getAudioTracks()) sender.addTrack(track, destination.stream);
  const offer = await sender.createOffer();
  await sender.setLocalDescription(offer);
  await receiver.setRemoteDescription(offer);
  const answer = await receiver.createAnswer();
  await receiver.setLocalDescription(answer);
  await sender.setRemoteDescription(answer);
  app.loopback = { sender, receiver };
  return true;
}

async function setupMic(context) {
  app.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  await context.audioWorklet.addModule(new URL('worklets/mic.js', location.href));
  const source = context.createMediaStreamSource(app.micStream);
  const mic = new AudioWorkletNode(context, 'hermes-mic', { processorOptions: { frameMs: MIC_FRAME_MS } });
  mic.port.onmessage = (event) => onMicFrame(event.data);
  source.connect(mic);
  app.micNode = mic;
}

function onMicFrame(buffer) {
  if (micOpen()) {
    flushPreroll();
    app.socket.send(buffer);
    return;
  }
  app.preroll.push(buffer);
  const maxFrames = Math.ceil(PREROLL_MS / MIC_FRAME_MS);
  while (app.preroll.length > maxFrames) app.preroll.shift();
}

function flushPreroll() {
  if (app.preroll.length === 0 || app.socket?.readyState !== WebSocket.OPEN) return;
  for (const frame of app.preroll) app.socket.send(frame);
  app.preroll = [];
}

async function setupVad(context) {
  if (!window.vad?.MicVAD) throw new Error('VAD bundle missing: run npm install (it vendors public/vad)');
  const assets = new URL('vad/', location.href).href;
  app.vad = await window.vad.MicVAD.new({
    ...VAD_OPTIONS,
    audioContext: context,
    baseAssetPath: assets,
    onnxWASMBasePath: assets,
    getStream: async () => app.micStream,
    pauseStream: async () => {},
    resumeStream: async (stream) => stream,
    startOnLoad: false,
    onSpeechStart: onSpeechStart,
    onSpeechRealStart: onSpeechRealStart,
    onSpeechEnd: onSpeechEnd,
    onVADMisfire: onVadMisfire,
  });
  await app.vad.start();
}

// ---------- VAD callbacks ----------

function onSpeechStart() {
  if (app.muted) return;
  app.vadSpeaking = true;
  refreshOrb();
}

// Fires once the utterance has lasted minSpeechMs, so a cough does not stop the assistant.
function onSpeechRealStart() {
  if (app.muted) return;
  const assistantBusy = app.serverState === 'thinking' || app.serverState === 'speaking' || app.queuedAudio;
  if (assistantBusy) interruptAssistant();
  flushPreroll();
  sendJson({ type: 'speech_start' });
}

function onSpeechEnd() {
  if (!app.vadSpeaking) return;
  app.vadSpeaking = false;
  sendJson({ type: 'speech_end' });
  refreshOrb();
}

function onVadMisfire() {
  app.vadSpeaking = false;
  refreshOrb();
}

function interruptAssistant() {
  const heard = app.playedMs;
  sendJson({ type: 'interrupt' });
  clearPlayback();
  sendJson({ type: 'heard_ms', ms: heard });
}

function clearPlayback() {
  app.playerNode?.port.postMessage('clear');
  app.playedMs = 0;
  app.queuedAudio = false;
}

// ---------- gateway socket ----------

function connect(token) {
  const socket = new WebSocket(gatewayUrl(token));
  socket.binaryType = 'arraybuffer';
  app.socket = socket;

  socket.onopen = () => {
    app.reconnectDelay = RECONNECT_MIN_MS;
    setStatus('Listening');
  };
  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      app.queuedAudio = true;
      app.playerNode?.port.postMessage(event.data, [event.data]);
      refreshOrb();
      return;
    }
    handleControl(JSON.parse(event.data));
  };
  socket.onclose = (event) => {
    if (app.socket !== socket) return;
    app.socket = null;
    app.serverState = 'idle';
    if (!app.sessionOpen) return;
    if (event.code === 1008 || event.code === 4401) {
      endSession('Token rejected');
      el.dialog.showModal();
      return;
    }
    setStatus(`Reconnecting in ${Math.round(app.reconnectDelay / 1000)} s`, true);
    setOrb('error');
    app.reconnectTimer = setTimeout(() => {
      app.reconnectDelay = Math.min(RECONNECT_MAX_MS, app.reconnectDelay * 2);
      if (app.sessionOpen) connect(token);
    }, app.reconnectDelay);
  };
  socket.onerror = () => {};
}

function handleControl(message) {
  switch (message.type) {
    case 'status':
      app.serverState = message.state;
      if (message.state === 'thinking' && !message.detail) {
        clearPlayback();
        app.assistantBuffer = '';
        el.assistant.textContent = '';
      }
      setStatus(statusLabel(message));
      refreshOrb();
      break;
    case 'partial':
      el.partial.textContent = message.text;
      el.partial.classList.add('tentative');
      break;
    case 'final':
      el.partial.textContent = message.text;
      el.partial.classList.remove('tentative');
      break;
    case 'assistant_text':
      if (message.text) {
        app.assistantBuffer += message.text;
        el.assistant.textContent = app.assistantBuffer;
        el.assistant.scrollTop = el.assistant.scrollHeight;
      }
      break;
    case 'turn_done':
      break;
    case 'flush':
      clearPlayback();
      break;
    case 'error':
      setStatus(message.message, true);
      break;
    default:
      break;
  }
}

function statusLabel(message) {
  if (message.detail) return `${capitalize(message.state)}: ${message.detail}`;
  return { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', idle: 'Idle' }[message.state] ?? message.state;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- session lifecycle ----------

async function startSession() {
  const token = storage.get(STORAGE_TOKEN);
  if (!token) {
    el.dialog.showModal();
    return;
  }
  try {
    setStatus('Starting audio');
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'play-and-record'; } catch { /* unsupported value */ }
    }
    const context = await ensureAudioContext();
    if (!app.playerNode) await setupPlayback(context);
    if (!app.micStream) await setupMic(context);
    if (!app.vad) await setupVad(context);
    app.sessionOpen = true;
    app.muted = false;
    el.mute.disabled = false;
    el.stop.disabled = false;
    el.mute.textContent = 'Mute';
    el.orb.classList.remove('muted');
    await requestWakeLock();
    connect(token);
    refreshOrb();
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Could not start', true);
    setOrb('error');
  }
}

function endSession(reason = 'Session ended') {
  app.sessionOpen = false;
  clearTimeout(app.reconnectTimer);
  const socket = app.socket;
  app.socket = null;
  socket?.close();
  clearPlayback();
  app.serverState = 'idle';
  app.vadSpeaking = false;
  el.mute.disabled = true;
  el.stop.disabled = true;
  releaseWakeLock();
  setStatus(reason);
  refreshOrb();
}

function toggleMute() {
  app.muted = !app.muted;
  for (const track of app.micStream?.getAudioTracks() ?? []) track.enabled = !app.muted;
  el.mute.textContent = app.muted ? 'Unmute' : 'Mute';
  el.mute.classList.toggle('active', app.muted);
  el.orb.classList.toggle('muted', app.muted);
  if (app.muted && app.vadSpeaking) onSpeechEnd();
}

async function requestWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* denied or unsupported */ }
}

function releaseWakeLock() {
  app.wakeLock?.release().catch(() => {});
  app.wakeLock = null;
}

// ---------- wiring ----------

el.orb.addEventListener('click', () => {
  if (app.sessionOpen) {
    ensureAudioContext().catch(() => {});
    return;
  }
  startSession();
});
el.mute.addEventListener('click', toggleMute);
el.stop.addEventListener('click', () => endSession());
el.changeToken.addEventListener('click', () => {
  el.tokenInput.value = storage.get(STORAGE_TOKEN) ?? '';
  el.dialog.showModal();
});
el.newConversation.addEventListener('click', () => {
  storage.set(STORAGE_SESSION, crypto.randomUUID());
  el.assistant.textContent = '';
  el.partial.textContent = '';
  if (app.sessionOpen) {
    const token = storage.get(STORAGE_TOKEN);
    app.socket?.close();
    app.socket = null;
    connect(token);
  }
  setStatus('New conversation');
});
el.dialog.addEventListener('close', () => {
  const value = el.tokenInput.value.trim();
  if (value) storage.set(STORAGE_TOKEN, value);
  el.tokenInput.value = '';
  if (value && !app.sessionOpen) startSession();
});

// iOS suspends the AudioContext on any route change; resume on every gesture.
for (const type of ['pointerdown', 'touchend', 'keydown']) {
  document.addEventListener(type, () => {
    if (app.audioContext && app.audioContext.state !== 'running') app.audioContext.resume().catch(() => {});
  }, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.sessionOpen) {
    requestWakeLock();
    ensureAudioContext().catch(() => {});
  }
});

if (!storage.get(STORAGE_TOKEN)) setStatus('Tap the orb, then paste your voice token');
