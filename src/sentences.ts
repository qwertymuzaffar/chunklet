import { pack, refine, type Piece } from './core';
import { resolveOptions, type Chunk, type ChunkOptions } from './types';

interface SentenceSegmenter {
  segment(text: string): Iterable<{ segment: string; index: number }>;
}

function getSegmenter(): SentenceSegmenter | null {
  const IntlAny = globalThis.Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity: string }) => SentenceSegmenter;
  };
  return IntlAny?.Segmenter ? new IntlAny.Segmenter(undefined, { granularity: 'sentence' }) : null;
}

/** Regex fallback when Intl.Segmenter is unavailable; tiles the input. */
export function sentencePiecesFallback(text: string): Piece[] {
  const pieces: Piece[] = [];
  const boundary = /[.!?…]+["')\]]*\s+|\n+/g;
  let cursor = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    pieces.push({ start: cursor, end });
    cursor = end;
  }
  if (cursor < text.length) pieces.push({ start: cursor, end: text.length });
  return pieces;
}

function sentencePieces(text: string): Piece[] {
  const segmenter = getSegmenter();
  if (!segmenter) return sentencePiecesFallback(text);
  const pieces: Piece[] = [];
  for (const s of segmenter.segment(text)) {
    pieces.push({ start: s.index, end: s.index + s.segment.length });
  }
  return pieces;
}

/**
 * Sentence-boundary chunking: whole sentences are packed into the token
 * budget, so a chunk never ends mid-sentence unless a single sentence is
 * itself over budget (then it degrades to word/character splitting).
 * Uses Intl.Segmenter when available, a regex fallback otherwise.
 */
export function chunkSentences(text: string, options?: ChunkOptions): Chunk[] {
  const opts = resolveOptions(options);
  if (text.trim().length === 0) return [];
  const pieces = sentencePieces(text).flatMap((piece) =>
    refine(text, piece, [' ', ''], opts),
  );
  return pack(text, pieces, opts);
}
