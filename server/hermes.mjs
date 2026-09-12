// Streaming client for the Hermes Agent OpenAI-compatible chat completions endpoint.
import { emptySseState, feedSse, parseHermesEvent } from './sse.mjs';

export class HermesError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HermesError';
    this.status = status;
  }
}

/**
 * Async generator over parsed Hermes events. Aborting `signal` ends the stream quietly.
 * Yields { type: 'delta' | 'tool' | 'done', ... }.
 */
export async function* streamHermes({ apiUrl, apiKey, model, messages, sessionId, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'X-Hermes-Session-Id': sessionId,
    },
    body: JSON.stringify({ model, stream: true, messages }),
    signal,
  });
  if (!response.ok) {
    throw new HermesError(`Hermes API responded with HTTP ${response.status}`, response.status);
  }
  if (!response.body) throw new HermesError('Hermes API returned no body', response.status);

  const decoder = new TextDecoder();
  let state = emptySseState;
  for await (const chunk of response.body) {
    const fed = feedSse(state, decoder.decode(chunk, { stream: true }));
    state = fed.state;
    for (const raw of fed.events) {
      const parsed = parseHermesEvent(raw);
      if (parsed.type === 'ignore') continue;
      yield parsed;
      if (parsed.type === 'done') return;
    }
  }
  const tail = feedSse(state, '\n\n');
  for (const raw of tail.events) {
    const parsed = parseHermesEvent(raw);
    if (parsed.type !== 'ignore') yield parsed;
  }
}
