#!/usr/bin/env node
// Headless client that speaks the exact browser protocol against a live gateway, so a VPS can be
// verified with real audio before anyone opens the page. Only `ws` and node built-ins are used.
//
//   node scripts/e2e-cli.mjs --url ws://127.0.0.1:8765/voice/ws --token <t> --wav question.wav [--say "text"]
//
// Options: --out reply.pcm (24 kHz s16le), --session <id>, --timeout <seconds, 90>,
// --origin <url> (the Origin header; defaults to https://<host of --url>, so a gateway with
// ALLOWED_ORIGINS set needs the real page origin passed explicitly).
// With --say and NARI_API_KEY in the environment the text is synthesised through Nari first.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

export const FRAME_MS = 20;
export const TARGET_RATE = 16000;
export const REPLY_RATE = 24000;
const DEFAULT_TIMEOUT_S = 90;
const DEFAULT_OUT = 'reply.pcm';
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, timeout: DEFAULT_TIMEOUT_S, session: `e2e-${randomUUID()}` };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    i += 1;
    if (key === 'timeout') options.timeout = Number(value);
    else options[key] = value;
  }
  if (!options.url) throw new Error('--url is required');
  if (!options.token) throw new Error('--token is required');
  if (!options.wav && !options.say) throw new Error('--wav or --say is required');
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout must be a positive number of seconds');
  return options;
}

/** Minimal RIFF/WAVE reader: PCM16, any rate, first channel only. */
export function parseWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = { format: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('wav is missing its fmt or data chunk');
  if (![WAVE_FORMAT_PCM, WAVE_FORMAT_EXTENSIBLE].includes(fmt.format) || fmt.bits !== 16) {
    throw new Error(`wav must be PCM16 (got format ${fmt.format}, ${fmt.bits} bits)`);
  }
  const stride = 2 * fmt.channels;
  const frames = Math.floor(data.length / stride);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = data.readInt16LE(i * stride);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/** Linear interpolation resampler for Int16 mono audio. */
export function resampleInt16(input, fromRate, toRate) {
  if (fromRate === toRate) return Int16Array.from(input);
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index];
    const b = input[Math.min(index + 1, input.length - 1)];
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** Cut PCM16 samples into fixed-size binary frames (the last one may be shorter). */
export function frameAudio(samples, frameSamples) {
  const frames = [];
  for (let start = 0; start < samples.length; start += frameSamples) {
    const slice = samples.subarray(start, Math.min(start + frameSamples, samples.length));
    frames.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
  }
  return frames;
}

async function synthesise(text, env) {
  const base = (env.NARI_API_URL || 'https://api.narilabs.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NARI_API_KEY}` },
    body: JSON.stringify({ model: env.NARI_TTS_MODEL || 'qwen3-tts:free', voice: env.NARI_VOICE || 'leon', input: text, response_format: 'pcm', stream: false }),
  });
  if (!response.ok) throw new Error(`Nari TTS responded with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const even = bytes.length - (bytes.length % 2);
  return new Int16Array(bytes.buffer, bytes.byteOffset, even / 2);
}

async function loadAudio(options, env) {
  if (options.say && env.NARI_API_KEY) {
    console.log(`synthesising ${JSON.stringify(options.say)} through Nari`);
    return resampleInt16(await synthesise(options.say, env), REPLY_RATE, TARGET_RATE);
  }
  if (!options.wav) throw new Error('--say needs NARI_API_KEY in the environment, or pass --wav');
  const wav = parseWav(readFileSync(options.wav));
  if (wav.channels > 1) console.log(`wav has ${wav.channels} channels; using the first`);
  return resampleInt16(wav.samples, wav.sampleRate, TARGET_RATE);
}

const sleepUntil = (at) => new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

// The token is sent as the first message on the socket, never in the URL (proxy logs would keep it).
export async function run(options, env = process.env) {
  const audio = await loadAudio(options, env);
  const frames = frameAudio(audio, (TARGET_RATE * FRAME_MS) / 1000);
  const url = new URL(options.url);
  url.searchParams.delete('token');
  url.searchParams.set('session', options.session);
  const origin = options.origin ?? `https://${url.host}`;
  console.log(`audio: ${audio.length} samples at ${TARGET_RATE} Hz (${Math.round((audio.length / TARGET_RATE) * 1000)} ms, ${frames.length} frames of ${FRAME_MS} ms)`);

  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    const t0 = Date.now();
    const stamp = () => `+${String(Date.now() - t0).padStart(6)} ms`;
    const stats = { chunks: [], audioBytes: 0, transcript: '', assistant: '', firstFrameAt: null, speechEndAt: null, firstPartialAt: null, firstAudioAt: null };
    let finished = false;

    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      writeFileSync(options.out, Buffer.concat(stats.chunks));
      const audioMs = Math.round(stats.audioBytes / ((REPLY_RATE * 2) / 1000));
      const firstPartial = stats.firstPartialAt && stats.firstFrameAt ? stats.firstPartialAt - stats.firstFrameAt : null;
      const firstAudio = stats.firstAudioAt && stats.speechEndAt ? stats.firstAudioAt - stats.speechEndAt : null;
      console.log(`summary: exit=${code} transcript=${JSON.stringify(stats.transcript)} assistant_chars=${stats.assistant.length} audio_ms=${audioMs} first_partial_ms=${firstPartial ?? 'n/a'} (after first frame) first_audio_ms=${firstAudio ?? 'n/a'} (after speech_end) reply=${options.out}`);
      try { ws.close(); } catch { /* already closed */ }
      resolve(code);
    };
    const timer = setTimeout(() => {
      console.error(`timed out after ${options.timeout} s`);
      finish(1);
    }, options.timeout * 1000);

    ws.on('unexpected-response', (_req, res) => {
      console.error(`upgrade rejected: HTTP ${res.statusCode}`);
      if (res.statusCode === 403) {
        console.error(`hint: the gateway refused Origin ${origin}. Pass --origin with the page origin it allows, for example --origin https://hermes.example (one of its ALLOWED_ORIGINS, or its public host when that list is empty).`);
      } else if (res.statusCode === 401) {
        console.error('hint: the token does not match VOICE_TOKEN on the gateway.');
      } else if (res.statusCode === 429) {
        console.error('hint: too many bad tokens from this address; wait a minute and retry.');
      }
      finish(1);
    });
    ws.on('error', (err) => {
      console.error(`socket error: ${err.message}`);
      finish(1);
    });
    ws.on('close', (code, reason) => {
      if (finished) return;
      if (code === 4401) console.error('token rejected (4401): the token does not match VOICE_TOKEN on the gateway; check for an extra character at the start or end');
      else if (code === 4429) console.error('rate limited (4429): too many bad tokens from this address, wait a minute and retry');
      else if (code === 4408) console.error('auth timeout (4408): the gateway did not receive the auth message in time');
      else console.error(`socket closed (${code} ${reason?.toString() ?? ''}) before turn_done`);
      finish(1);
    });
    ws.on('open', () => {
      console.log(`${stamp()} connected to ${url}, authenticating`);
      ws.send(JSON.stringify({ type: 'auth', token: options.token }));
    });
    const streamAudio = async () => {
      ws.send(JSON.stringify({ type: 'speech_start' }));
      const start = Date.now();
      stats.firstFrameAt = start;
      for (let i = 0; i < frames.length; i += 1) {
        await sleepUntil(start + i * FRAME_MS);
        if (finished) return;
        ws.send(frames[i], { binary: true });
      }
      stats.speechEndAt = Date.now();
      ws.send(JSON.stringify({ type: 'speech_end' }));
      console.log(`${stamp()} sent ${frames.length} frames and speech_end`);
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (stats.firstAudioAt === null) {
          stats.firstAudioAt = Date.now();
          console.log(`${stamp()} first audio chunk (${data.length} bytes)`);
        }
        stats.audioBytes += data.length;
        stats.chunks.push(Buffer.from(data));
        return;
      }
      const text = data.toString();
      console.log(`${stamp()} ${text}`);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.type === 'auth_ok') streamAudio().catch((err) => { console.error(err.message); finish(1); });
      else if (message.type === 'partial' && stats.firstPartialAt === null) stats.firstPartialAt = Date.now();
      else if (message.type === 'final') stats.transcript = message.text;
      else if (message.type === 'assistant_text' && message.text) stats.assistant += message.text;
      else if (message.type === 'error') finish(1);
      else if (message.type === 'turn_done') finish(0);
    });
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('usage: node scripts/e2e-cli.mjs --url ws://127.0.0.1:8765/ws --token <t> --wav question.wav [--say "text"] [--origin https://host] [--out reply.pcm] [--timeout 90]');
    process.exit(2);
  }
  try {
    process.exit(await run(options));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
