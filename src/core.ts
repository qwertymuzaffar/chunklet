import type { Chunk, ChunkMeta, ResolvedOptions } from './types';

/** A half-open [start, end) slice of the source; pieces never overlap. */
export interface Piece {
  start: number;
  end: number;
}

export const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' ', ''] as const;

const tokensOf = (text: string, piece: Piece, opts: ResolvedOptions): number =>
  opts.tokenizer(text.slice(piece.start, piece.end));

/**
 * Splits a piece on a separator, keeping each separator attached to the
 * piece it terminates so the pieces tile the input exactly.
 */
export function splitOn(text: string, piece: Piece, separator: string): Piece[] {
  const out: Piece[] = [];
  let cursor = piece.start;
  while (cursor < piece.end) {
    const found = text.indexOf(separator, cursor);
    if (found === -1 || found + separator.length > piece.end) break;
    out.push({ start: cursor, end: found + separator.length });
    cursor = found + separator.length;
  }
  if (cursor < piece.end) out.push({ start: cursor, end: piece.end });
  return out;
}

/** Largest prefix of the piece that fits the token budget (>= 1 char). */
function fittingPrefix(text: string, piece: Piece, opts: ResolvedOptions): number {
  let lo = piece.start + 1;
  let hi = piece.end;
  // binary search the largest end with tokens <= maxTokens
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (opts.tokenizer(text.slice(piece.start, mid)) <= opts.maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(lo, piece.start + 1);
}

/** Hard character split for text with no usable separators. */
function hardSplit(text: string, piece: Piece, opts: ResolvedOptions): Piece[] {
  const out: Piece[] = [];
  let cursor = piece.start;
  while (cursor < piece.end) {
    const end = fittingPrefix(text, { start: cursor, end: piece.end }, opts);
    out.push({ start: cursor, end });
    cursor = end;
  }
  return out;
}

/**
 * Recursively splits a piece until every resulting piece fits maxTokens,
 * trying coarser separators first (paragraphs, lines, sentences, words).
 */
export function refine(
  text: string,
  piece: Piece,
  separators: readonly string[],
  opts: ResolvedOptions,
): Piece[] {
  if (piece.start >= piece.end) return [];
  if (tokensOf(text, piece, opts) <= opts.maxTokens) return [piece];
  const [separator, ...rest] = separators;
  if (separator === undefined || separator === '') return hardSplit(text, piece, opts);
  const parts = splitOn(text, piece, separator);
  if (parts.length <= 1) return refine(text, piece, rest, opts);
  return parts.flatMap((part) =>
    tokensOf(text, part, opts) <= opts.maxTokens ? [part] : refine(text, part, rest, opts),
  );
}

/** Largest suffix of a piece within `budget` tokens (possibly empty). */
function fittingSuffix(text: string, piece: Piece, budget: number, opts: ResolvedOptions): Piece | null {
  if (budget <= 0) return null;
  let lo = piece.start;
  let hi = piece.end - 1;
  // binary search the smallest start with tokens <= budget
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (opts.tokenizer(text.slice(mid, piece.end)) <= budget) hi = mid;
    else lo = mid + 1;
  }
  if (opts.tokenizer(text.slice(lo, piece.end)) > budget) return null;
  return { start: lo, end: piece.end };
}

/**
 * Trailing context worth at most `overlap` tokens: whole trailing pieces
 * while they fit, then a suffix of the next one so overlap is honored even
 * when a single piece is larger than the overlap budget.
 */
function overlapTail(text: string, pieces: Piece[], opts: ResolvedOptions): Piece[] {
  if (opts.overlap === 0) return [];
  const tail: Piece[] = [];
  let total = 0;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const t = tokensOf(text, pieces[i], opts);
    if (total + t > opts.overlap) {
      const suffix = fittingSuffix(text, pieces[i], opts.overlap - total, opts);
      if (suffix) tail.unshift(suffix);
      break;
    }
    tail.unshift(pieces[i]);
    total += t;
  }
  return tail;
}

/**
 * Packs contiguous-ish pieces into chunks within the token budget.
 * A chunk spans from its first piece's start to its last piece's end, so
 * any un-pieced gap between them (e.g. blank lines) is preserved verbatim.
 * Edges are whitespace-trimmed WITH offset adjustment, preserving the
 * `text === source.slice(start, end)` invariant.
 */
export function pack(
  text: string,
  pieces: Piece[],
  opts: ResolvedOptions,
  meta?: ChunkMeta,
): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Piece[] = [];
  let currentTokens = 0;

  const emit = () => {
    if (current.length === 0) return;
    let start = current[0].start;
    let end = current[current.length - 1].end;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start >= end) return;
    const sliced = text.slice(start, end);
    chunks.push({
      text: sliced,
      start,
      end,
      tokens: opts.tokenizer(sliced),
      index: chunks.length,
      ...(meta ? { meta } : {}),
    });
  };

  for (const piece of pieces) {
    const t = tokensOf(text, piece, opts);
    if (current.length > 0 && currentTokens + t > opts.maxTokens) {
      emit();
      const tail = overlapTail(text, current, opts);
      current = [...tail];
      currentTokens = tail.reduce((sum, p) => sum + tokensOf(text, p, opts), 0);
    }
    current.push(piece);
    currentTokens += t;
  }
  emit();
  return chunks;
}

/** Reassigns sequential indexes after concatenating chunk groups. */
export function reindex(chunks: Chunk[]): Chunk[] {
  return chunks.map((chunk, index) => ({ ...chunk, index }));
}
