// Turns a stream of text deltas into speakable sentences and cleans them for TTS.
// Sentence detection and the markdown cleaner follow the approach in jarvis_ai (MIT), see NOTICE.

export const TTS_MAX_CODE_POINTS = 2048;
const CODE_OMITTED = ' code omitted. ';
const FENCE = '```';

export const emptySentenceBuffer = Object.freeze({ text: '' });

/** Remove markdown and anything that reads badly aloud. Pure. */
export function cleanForSpeech(input) {
  if (!input) return '';
  return input
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```[\s\S]*?```/g, CODE_OMITTED)
    .replace(/```[\s\S]*$/g, CODE_OMITTED)
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Index of the first unmatched code fence, or -1 when every fence is closed. */
function unclosedFenceIndex(text) {
  let index = text.indexOf(FENCE);
  let open = false;
  let openAt = -1;
  while (index !== -1) {
    open = !open;
    openAt = open ? index : -1;
    index = text.indexOf(FENCE, index + FENCE.length);
  }
  return open ? openAt : -1;
}

/** Position just after the first sentence boundary in text, or -1. */
function firstBoundary(text) {
  const newline = text.indexOf('\n');
  const punctuation = /[.!?]+(?=\s|$)/.exec(text);
  const punctuationEnd = punctuation ? punctuation.index + punctuation[0].length : -1;
  const candidates = [newline === -1 ? -1 : newline + 1, punctuationEnd].filter((i) => i > 0);
  if (candidates.length === 0) return -1;
  const end = Math.min(...candidates);
  // A boundary at the very end of the buffer is only safe when whitespace follows it,
  // otherwise the next delta may continue the token (for example "3." then "5").
  return end === text.length && !/\s$/.test(text) && punctuationEnd === end ? -1 : end;
}

function extract(text, force) {
  const sentences = [];
  let rest = text;
  for (;;) {
    rest = rest.replace(/```[\s\S]*?```/g, CODE_OMITTED).replace(/^\s+/, '');
    const fenceAt = unclosedFenceIndex(rest);
    const eligible = fenceAt === -1 ? rest : rest.slice(0, fenceAt);
    const cut = firstBoundary(eligible);
    if (cut === -1) break;
    const cleaned = cleanForSpeech(eligible.slice(0, cut));
    if (cleaned) sentences.push(cleaned);
    rest = rest.slice(cut);
  }
  if (force) {
    const cleaned = cleanForSpeech(rest);
    if (cleaned) sentences.push(cleaned);
    rest = '';
  }
  return { state: Object.freeze({ text: rest }), sentences };
}

/** Append a delta; returns the new buffer state and any complete sentences. Pure. */
export function pushDelta(state, delta) {
  return extract(state.text + (delta ?? ''), false);
}

/** Emit whatever is left (end of the assistant turn). Pure. */
export function flushBuffer(state) {
  return extract(state.text, true);
}

/** Split text into pieces of at most maxCodePoints, preferring word boundaries. Pure. */
export function splitForTts(text, maxCodePoints = TTS_MAX_CODE_POINTS) {
  const points = Array.from(text ?? '');
  if (points.length === 0) return [];
  if (points.length <= maxCodePoints) return [text];
  const pieces = [];
  let start = 0;
  while (start < points.length) {
    const hardEnd = Math.min(start + maxCodePoints, points.length);
    let end = hardEnd;
    if (hardEnd < points.length) {
      const lastSpace = points.lastIndexOf(' ', hardEnd - 1);
      if (lastSpace > start) end = lastSpace;
    }
    const piece = points.slice(start, end).join('').trim();
    if (piece) pieces.push(piece);
    start = end;
  }
  return pieces;
}
