// Incremental Server-Sent Events parser plus the Hermes-specific event mapping. Pure functions.

export const emptySseState = Object.freeze({ buffer: '' });

/** Feed a text chunk; returns the new parser state and the complete events found. */
export function feedSse(state, chunk) {
  const text = state.buffer + chunk;
  const blocks = text.split(/\r?\n\r?\n/);
  const remainder = blocks.pop() ?? '';
  const events = blocks.map(parseBlock).filter((e) => e !== null);
  return { state: Object.freeze({ buffer: remainder }), events };
}

function parseBlock(block) {
  const lines = block.split(/\r?\n/);
  const dataLines = [];
  let event = 'message';
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Map one SSE event from the Hermes chat completions stream to something the gateway understands:
 * { type: 'delta', text } | { type: 'tool', name, status } | { type: 'done', finishReason } | { type: 'ignore' }
 */
export function parseHermesEvent({ event, data }) {
  if (data.trim() === '[DONE]') return { type: 'done', finishReason: 'done' };
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return { type: 'ignore' };
  }
  if (!payload || typeof payload !== 'object') return { type: 'ignore' };
  if (payload.object === 'hermes.tool.progress' || event === 'hermes.tool.progress') {
    return {
      type: 'tool',
      name: String(payload.tool_name ?? payload.tool ?? payload.name ?? 'tool'),
      status: String(payload.status ?? payload.phase ?? payload.event ?? 'running'),
    };
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!choice) return { type: 'ignore' };
  const text = choice.delta?.content;
  if (typeof text === 'string' && text.length > 0) return { type: 'delta', text };
  if (choice.finish_reason) return { type: 'done', finishReason: String(choice.finish_reason) };
  return { type: 'ignore' };
}
