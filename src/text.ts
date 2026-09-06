import { DEFAULT_SEPARATORS, pack, refine } from './core';
import { resolveOptions, type Chunk, type ChunkOptions } from './types';

/**
 * General-purpose chunking: splits on paragraphs, then lines, sentences,
 * and words - only as finely as needed to fit the token budget - and packs
 * the pieces back into budget-sized chunks with optional overlap.
 */
export function chunkText(text: string, options?: ChunkOptions): Chunk[] {
  const opts = resolveOptions(options);
  if (text.trim().length === 0) return [];
  const pieces = refine(text, { start: 0, end: text.length }, DEFAULT_SEPARATORS, opts);
  return pack(text, pieces, opts);
}
