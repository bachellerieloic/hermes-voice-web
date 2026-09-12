// Environment loading and validation. Fails fast with every problem listed at once.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULTS = Object.freeze({
  HERMES_API_URL: 'http://127.0.0.1:8642',
  HERMES_MODEL: 'hermes-agent',
  NARI_API_URL: 'https://api.narilabs.com',
  NARI_TTS_MODEL: 'qwen3-tts:free',
  NARI_VOICE: 'leon',
  NARI_STT_MODEL: 'qwen3-asr:free',
  NARI_LANGUAGE: 'en',
  NARI_TURN_DETECTION: 'client',
  HOST: '127.0.0.1',
  PORT: '8765',
  ALLOWED_ORIGINS: '',
  BASE_PATH: '',
  TRUST_PROXY: 'false',
  ALLOW_QUERY_TOKEN: 'false',
  ACK_DELAY_MS: '1500',
  // Pipe-separated pool. The gateway picks one at random per turn and never
  // repeats the previous one, so the wait never sounds scripted. Set to a
  // single line to always say the same thing, or to "" to stay silent.
  ACK_TEXT: 'Right away.|One moment.|Let me check.|On it.|Looking into that.|Give me a second.|Checking now.|Working on it.',
});

const MIN_TOKEN_LENGTH = 16;
const TURN_DETECTION_MODES = new Set(['client', 'server_vad']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Parse KEY=VALUE lines. Comments and blank lines are ignored, quotes are stripped. */
export function parseDotEnv(text) {
  return text.split(/\r?\n/).reduce((acc, rawLine) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return acc;
    const eq = line.indexOf('=');
    if (eq <= 0) return acc;
    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1).trim());
    return { ...acc, [key]: value };
  }, {});
}

function stripQuotes(value) {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

/** Normalise a mount prefix: "" for root, otherwise "/prefix" with no trailing slash. */
export function normalizeBasePath(raw) {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === '/') return '';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
}

export function parseOrigins(raw) {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Parse the pipe-separated acknowledgement pool. Empty means stay silent. */
export function parseAckLines(raw) {
  return (raw ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseBoolean(raw) {
  return ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Build a validated config from an env-like object. Throws ConfigError listing every problem. */
export function buildConfig(env) {
  const get = (key) => (env[key] !== undefined && env[key] !== '' ? String(env[key]) : DEFAULTS[key]);
  const problems = [];

  const hermesApiKey = env.HERMES_API_KEY ?? '';
  const nariApiKey = env.NARI_API_KEY ?? '';
  const voiceToken = env.VOICE_TOKEN ?? '';
  const hermesApiUrl = get('HERMES_API_URL');
  const nariApiUrl = get('NARI_API_URL');
  const port = Number(get('PORT'));
  const ackDelayMs = Number(get('ACK_DELAY_MS'));
  const turnDetection = get('NARI_TURN_DETECTION');

  if (!hermesApiKey) problems.push('HERMES_API_KEY is required (the API_SERVER_KEY of your Hermes Agent)');
  if (!nariApiKey) problems.push('NARI_API_KEY is required (https://narilabs.com)');
  if (!voiceToken) problems.push('VOICE_TOKEN is required');
  else if (voiceToken.length < MIN_TOKEN_LENGTH) problems.push(`VOICE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  if (!isHttpUrl(hermesApiUrl)) problems.push('HERMES_API_URL must be an http(s) URL');
  if (!isHttpUrl(nariApiUrl)) problems.push('NARI_API_URL must be an http(s) URL');
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push('PORT must be an integer between 0 and 65535');
  if (!Number.isFinite(ackDelayMs) || ackDelayMs < 0) problems.push('ACK_DELAY_MS must be a non-negative number');
  if (!TURN_DETECTION_MODES.has(turnDetection)) problems.push('NARI_TURN_DETECTION must be "client" or "server_vad"');

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    hermesApiUrl: hermesApiUrl.replace(/\/+$/, ''),
    hermesApiKey,
    hermesModel: get('HERMES_MODEL'),
    nariApiUrl: nariApiUrl.replace(/\/+$/, ''),
    nariApiKey,
    nariTtsModel: get('NARI_TTS_MODEL'),
    nariVoice: get('NARI_VOICE'),
    nariSttModel: get('NARI_STT_MODEL'),
    nariLanguage: get('NARI_LANGUAGE'),
    nariTurnDetection: turnDetection,
    voiceToken,
    host: get('HOST'),
    port,
    allowedOrigins: Object.freeze(parseOrigins(get('ALLOWED_ORIGINS'))),
    basePath: normalizeBasePath(get('BASE_PATH')),
    trustProxy: parseBoolean(get('TRUST_PROXY')),
    allowQueryToken: parseBoolean(get('ALLOW_QUERY_TOKEN')),
    ackDelayMs,
    // Read raw so an explicit empty ACK_TEXT means "stay silent", not "use the default pool".
    ackLines: Object.freeze(parseAckLines(env.ACK_TEXT !== undefined ? String(env.ACK_TEXT) : DEFAULTS.ACK_TEXT)),
  });
}

/** Read .env (if present) merged under process.env, then validate. */
export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const dotEnvPath = resolve(cwd, '.env');
  const fileEnv = existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {};
  return buildConfig({ ...fileEnv, ...env });
}

/** ws(s) URL for the Nari realtime transcription endpoint, derived from the API base URL. */
export function nariRealtimeUrl(nariApiUrl) {
  const url = new URL('/v1/realtime', nariApiUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('intent', 'transcription');
  return url.toString();
}
