// Streaming text to speech through Nari Labs. Output is raw 24 kHz PCM16 mono.
import { splitForTts } from './sentences.mjs';

export const TTS_SAMPLE_RATE = 24000;
export const TTS_BYTES_PER_SAMPLE = 2;

export class TtsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
  }
}

export const pcmBytesToMs = (bytes) => Math.round((bytes / (TTS_SAMPLE_RATE * TTS_BYTES_PER_SAMPLE)) * 1000);

/**
 * Synthesise `text` (split into 2048 code point pieces) and hand every audio chunk to onChunk.
 * Resolves with the total number of PCM bytes. Aborting `signal` stops the stream quietly.
 */
export async function streamSpeech({ apiUrl, apiKey, model, voice, text, signal, onChunk, fetchImpl = fetch }) {
  let total = 0;
  for (const piece of splitForTts(text)) {
    if (signal?.aborted) break;
    total += await synthesisePiece({ apiUrl, apiKey, model, voice, text: piece, signal, onChunk, fetchImpl });
  }
  return total;
}

async function synthesisePiece({ apiUrl, apiKey, model, voice, text, signal, onChunk, fetchImpl }) {
  const response = await fetchImpl(`${apiUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, voice, input: text, response_format: 'pcm', stream: true }),
    signal,
  });
  if (!response.ok) throw new TtsError(`Nari TTS responded with HTTP ${response.status}`, response.status);
  if (!response.body) throw new TtsError('Nari TTS returned no body', response.status);

  let bytes = 0;
  let carry = new Uint8Array(0);
  for await (const chunk of response.body) {
    if (signal?.aborted) break;
    const joined = concat(carry, chunk);
    const even = joined.length - (joined.length % TTS_BYTES_PER_SAMPLE);
    carry = joined.subarray(even);
    if (even > 0) {
      const frame = joined.slice(0, even);
      bytes += frame.length;
      await onChunk(frame);
    }
  }
  return bytes;
}

function concat(a, b) {
  if (a.length === 0) return b instanceof Uint8Array ? b : new Uint8Array(b);
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
