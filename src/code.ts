import { pack, refine, reindex, type Piece } from './core';
import { resolveOptions, type Chunk, type ChunkMeta, type ChunkOptions, type ResolvedOptions } from './types';

export interface CodeChunkOptions extends ChunkOptions {
  /**
   * Language hint ('ts', 'python', 'sql', ...). It only decides which lines
   * count as comments and is echoed as meta.language; boundaries themselves
   * come from indentation and blank lines. Without it every common comment
   * marker is recognized.
   */
  language?: string;
}

interface CodeLine {
  start: number;
  /** Exclusive end, including the trailing newline if any. */
  end: number;
  /** Leading whitespace width; a tab counts as four columns. */
  indent: number;
  /** Trimmed content. */
  content: string;
  blank: boolean;
  comment: boolean;
  /** Starts with a closing bracket (or `end`), so the next line may start a declaration. */
  closes: boolean;
}

interface Declaration extends Piece {
  fromLine: number;
  toLine: number;
  /** First line of the declaration, when it has an indented body. */
  symbol?: string;
}

const C_STYLE = ['//', '/*', '*', '*/'];
const HASH = ['#'];
const DASH = ['--'];

const COMMENT_MARKERS: Record<string, readonly string[]> = {
  c: C_STYLE,
  cpp: C_STYLE,
  csharp: C_STYLE,
  dart: C_STYLE,
  go: C_STYLE,
  java: C_STYLE,
  javascript: C_STYLE,
  kotlin: C_STYLE,
  rust: C_STYLE,
  scala: C_STYLE,
  swift: C_STYLE,
  typescript: C_STYLE,
  php: [...C_STYLE, ...HASH],
  python: [...HASH, '"""', "'''"],
  ruby: [...HASH, '=begin', '=end'],
  shell: HASH,
  yaml: HASH,
  toml: HASH,
  perl: HASH,
  r: HASH,
  makefile: HASH,
  dockerfile: HASH,
  powershell: [...HASH, '<#'],
  sql: [...DASH, '/*', '*', '*/'],
  lua: DASH,
  haskell: [...DASH, '{-'],
  elm: [...DASH, '{-'],
  html: ['<!--'],
  xml: ['<!--'],
};

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  kt: 'kotlin',
  kts: 'kotlin',
  rs: 'rust',
  cs: 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  hs: 'haskell',
  ps1: 'powershell',
  golang: 'go',
};

const ALL_MARKERS = [...C_STYLE, ...HASH, ...DASH, '<!--'];

function commentMarkers(language?: string): readonly string[] {
  if (!language) return ALL_MARKERS;
  const key = language.toLowerCase();
  return COMMENT_MARKERS[LANGUAGE_ALIASES[key] ?? key] ?? ALL_MARKERS;
}

function toCodeLines(source: string, markers: readonly string[]): CodeLine[] {
  const lines: CodeLine[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const end = newline === -1 ? source.length : newline + 1;
    const raw = source.slice(cursor, end);
    const leading = /^[ \t]*/.exec(raw)![0];
    const content = raw.trim();
    lines.push({
      start: cursor,
      end,
      indent: leading.replace(/\t/g, '    ').length,
      content,
      blank: content === '',
      comment: markers.some((marker) => content.startsWith(marker)),
      closes: /^([}\])]|end\b)/.test(content),
    });
    cursor = end;
  }
  return lines;
}

/**
 * The first line of a declaration with an indented body, skipping comments
 * and decorators. Declarations without a body (imports, one-liners, a
 * key=value list) get no symbol - there is nothing to name.
 */
function symbolOf(lines: CodeLine[], fromLine: number, toLine: number): string | undefined {
  let hasBody = false;
  let symbol: string | undefined;
  for (let index = fromLine; index <= toLine; index++) {
    const line = lines[index];
    if (line.blank) continue;
    if (line.indent > 0) {
      hasBody = true;
      continue;
    }
    if (symbol === undefined && !line.comment && !line.content.startsWith('@')) symbol = line.content;
  }
  return hasBody ? symbol : undefined;
}

/**
 * Splits the file into top-level declarations. A declaration starts at an
 * unindented, non-comment line that follows a blank line or a closing
 * bracket (or opens the file); comment lines directly above it belong to it,
 * so a doc comment stays with its function. Trailing blank lines are left
 * out, so declarations never overlap.
 */
function findDeclarations(lines: CodeLine[]): Declaration[] {
  const firstContent = lines.findIndex((line) => !line.blank);
  if (firstContent === -1) return [];
  const starts = [firstContent];
  for (let index = firstContent + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.blank || line.comment || line.closes || line.indent > 0) continue;
    let above = index - 1;
    while (above >= 0 && lines[above].comment && lines[above].indent === 0) above--;
    const opensDeclaration = above < 0 || lines[above].blank || lines[above].closes;
    const fromLine = above + 1;
    if (opensDeclaration && fromLine > starts[starts.length - 1]) starts.push(fromLine);
  }
  return starts.map((fromLine, position) => {
    let toLine = position + 1 < starts.length ? starts[position + 1] - 1 : lines.length - 1;
    while (toLine > fromLine && lines[toLine].blank) toLine--;
    return {
      fromLine,
      toLine,
      start: lines[fromLine].start,
      end: lines[toLine].end,
      symbol: symbolOf(lines, fromLine, toLine),
    };
  });
}

/** Line indexes where a new segment may begin, given the segment's [fromLine, toLine]. */
type CutRule = (lines: CodeLine[], fromLine: number, toLine: number) => number[];

function interior(fromLine: number, toLine: number): number[] {
  const indexes: number[] = [];
  for (let index = fromLine + 1; index <= toLine; index++) indexes.push(index);
  return indexes;
}

/** Keeps only the candidates at the shallowest indentation: members of a class before statements inside them. */
function shallowest(lines: CodeLine[], candidates: number[]): number[] {
  if (candidates.length === 0) return [];
  let lowest = Infinity;
  for (const index of candidates) lowest = Math.min(lowest, lines[index].indent);
  return candidates.filter((index) => lines[index].indent === lowest);
}

/** Content lines that follow a blank line. */
const afterBlankLine: CutRule = (lines, fromLine, toLine) =>
  shallowest(
    lines,
    interior(fromLine, toLine).filter((index) => !lines[index].blank && lines[index - 1].blank),
  );

/** Lines that follow a closing bracket at their own depth or shallower, or that dedent - and do not close a bracket themselves. */
const afterStructure: CutRule = (lines, fromLine, toLine) =>
  shallowest(
    lines,
    interior(fromLine, toLine).filter((index) => {
      const line = lines[index];
      if (line.blank || line.closes) return false;
      const previous = lines[index - 1];
      if (previous.closes && line.indent <= previous.indent) return true;
      let above = index - 1;
      while (above > fromLine && lines[above].blank) above--;
      return line.indent < lines[above].indent;
    }),
  );

/** Every content line. */
const everyLine: CutRule = (lines, fromLine, toLine) =>
  interior(fromLine, toLine).filter((index) => !lines[index].blank);

const CUT_RULES: readonly CutRule[] = [afterBlankLine, afterStructure, everyLine];

/**
 * Turns the lines [fromLine, toLine] into pieces that fit the budget. A
 * segment that fits stays whole; one that does not is cut at the most
 * structural boundary available, then each part is refined the same way.
 * Only a single line that alone exceeds the budget is split inside a line.
 */
function splitLines(
  source: string,
  lines: CodeLine[],
  fromLine: number,
  toLine: number,
  opts: ResolvedOptions,
): Piece[] {
  while (toLine > fromLine && lines[toLine].blank) toLine--;
  const piece = { start: lines[fromLine].start, end: lines[toLine].end };
  if (opts.tokenizer(source.slice(piece.start, piece.end)) <= opts.maxTokens) return [piece];
  if (fromLine === toLine) return refine(source, piece, [' ', ''], opts);
  for (const rule of CUT_RULES) {
    const cuts = rule(lines, fromLine, toLine);
    if (cuts.length === 0) continue;
    const bounds = [fromLine, ...cuts, toLine + 1];
    const pieces: Piece[] = [];
    for (let position = 0; position + 1 < bounds.length; position++) {
      for (const part of splitLines(source, lines, bounds[position], bounds[position + 1] - 1, opts)) {
        pieces.push(part);
      }
    }
    return pieces;
  }
  return refine(source, piece, ['\n', ' ', ''], opts);
}

function withCodeMeta(chunk: Chunk, previousEnd: number, declarations: Declaration[], language?: string): Chunk {
  // the overlap repeated from the previous chunk does not decide which declaration this chunk belongs to
  const ownStart = Math.max(chunk.start, previousEnd);
  const enclosing = declarations.filter(
    (declaration) => declaration.start < chunk.end && declaration.end > ownStart,
  );
  const meta: ChunkMeta = {};
  if (language) meta.language = language;
  if (enclosing.length === 1 && enclosing[0].symbol) meta.symbol = enclosing[0].symbol;
  return Object.keys(meta).length > 0 ? { ...chunk, meta } : chunk;
}

/**
 * Source-code chunking: top-level declarations are the unit. Small ones are
 * packed together, a declaration that fits is never split, and an oversized
 * one starts its own chunks and is cut at blank lines before its shallowest
 * members first, then after closing brackets and at dedents, then at line
 * breaks. Chunks inside one declaration carry its first line as meta.symbol.
 */
export function chunkCode(source: string, options: CodeChunkOptions = {}): Chunk[] {
  const opts = resolveOptions(options);
  if (source.trim().length === 0) return [];
  const lines = toCodeLines(source, commentMarkers(options.language));
  const declarations = findDeclarations(lines);
  const chunks: Chunk[] = [];
  let group: Piece[] = [];
  const flush = () => {
    for (const chunk of pack(source, group, opts)) chunks.push(chunk);
    group = [];
  };
  for (const declaration of declarations) {
    const pieces = splitLines(source, lines, declaration.fromLine, declaration.toLine, opts);
    if (pieces.length === 1) {
      group.push(pieces[0]);
      continue;
    }
    // an oversized declaration always starts its own chunk
    flush();
    for (const chunk of pack(source, pieces, opts)) chunks.push(chunk);
  }
  flush();
  return reindex(chunks).map((chunk, index, all) =>
    withCodeMeta(chunk, index > 0 ? all[index - 1].end : 0, declarations, options.language),
  );
}
