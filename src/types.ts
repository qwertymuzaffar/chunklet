/** Counts (or estimates) tokens in a string. Plug in js-tiktoken etc. */
export type Tokenizer = (text: string) => number;

export interface ChunkMeta {
  /** Markdown heading breadcrumb, outermost first (chunkMarkdown only). */
  headings?: string[];
}

export interface Chunk {
  /** Exactly source.slice(start, end) - never normalized or rewritten. */
  text: string;
  /** Inclusive character offset into the source. */
  start: number;
  /** Exclusive character offset into the source. */
  end: number;
  /** Token count of text, per the active tokenizer. */
  tokens: number;
  /** 0-based position in the returned array. */
  index: number;
  meta?: ChunkMeta;
}

export interface ChunkOptions {
  /** Token budget per chunk (default 512). */
  maxTokens?: number;
  /** Tokens of trailing context repeated at the start of the next chunk (default 0). */
  overlap?: number;
  /** Token counter (default: ~4 characters per token heuristic). */
  tokenizer?: Tokenizer;
}

export interface ResolvedOptions {
  maxTokens: number;
  overlap: number;
  tokenizer: Tokenizer;
}

/** The default chars/4 heuristic - close enough for budget packing. */
export const estimateTokens: Tokenizer = (text) => Math.ceil(text.length / 4);

export function resolveOptions(options: ChunkOptions = {}): ResolvedOptions {
  const maxTokens = options.maxTokens ?? 512;
  const overlap = options.overlap ?? 0;
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    throw new RangeError(`maxTokens must be >= 1, got ${maxTokens}`);
  }
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= maxTokens) {
    throw new RangeError(`overlap must be in [0, maxTokens), got ${overlap}`);
  }
  return { maxTokens, overlap, tokenizer: options.tokenizer ?? estimateTokens };
}
