import { pack, refine, reindex, type Piece } from './core';
import { resolveOptions, type Chunk, type ChunkOptions } from './types';

interface Line {
  start: number;
  end: number; // includes the trailing newline, if any
  content: string;
}

interface Block extends Piece {
  fence: boolean;
}

interface Section {
  headings: string[];
  blocks: Block[];
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let nl = text.indexOf('\n', cursor);
    if (nl === -1) nl = text.length - 1;
    const end = nl + 1;
    lines.push({ start: cursor, end, content: text.slice(cursor, Math.min(end, text.length)) });
    cursor = end;
  }
  return lines;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(\s{0,3})(`{3,}|~{3,})/;

/**
 * Parses ATX headings and fenced code blocks into sections. Each section
 * carries its heading breadcrumb (outermost first); fenced blocks are kept
 * as single atomic pieces; paragraphs are split at blank lines.
 */
export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let blocks: Block[] = [];
  let paragraph: Piece | null = null;
  let fenceOpen: { marker: string; start: number } | null = null;

  const flushParagraph = () => {
    if (paragraph) blocks.push({ ...paragraph, fence: false });
    paragraph = null;
  };
  const flushSection = () => {
    flushParagraph();
    if (blocks.length > 0) {
      sections.push({ headings: stack.map((h) => h.title), blocks });
    }
    blocks = [];
  };

  for (const line of toLines(text)) {
    const trimmed = line.content.replace(/\n$/, '');

    if (fenceOpen) {
      const close = trimmed.match(FENCE);
      if (close && close[2][0] === fenceOpen.marker[0] && close[2].length >= fenceOpen.marker.length) {
        blocks.push({ start: fenceOpen.start, end: line.end, fence: true });
        fenceOpen = null;
      }
      continue;
    }

    const fence = trimmed.match(FENCE);
    if (fence) {
      flushParagraph();
      fenceOpen = { marker: fence[2], start: line.start };
      continue;
    }

    const heading = trimmed.match(HEADING);
    if (heading) {
      flushSection();
      const level = heading[1].length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: heading[2] });
      blocks.push({ start: line.start, end: line.end, fence: false });
      continue;
    }

    if (trimmed.trim() === '') {
      flushParagraph();
      continue;
    }

    paragraph = { start: paragraph ? paragraph.start : line.start, end: line.end };
  }

  // unclosed fence: treat the rest as one atomic block
  if (fenceOpen) blocks.push({ start: fenceOpen.start, end: text.length, fence: true });
  flushSection();
  return sections;
}

/**
 * Markdown-aware chunking: sections follow the ATX heading structure and
 * every chunk carries its heading breadcrumb in meta.headings. Fenced code
 * blocks are never merged with prose mid-fence and only split internally
 * (by lines) when a fence alone exceeds the budget.
 */
export function chunkMarkdown(text: string, options?: ChunkOptions): Chunk[] {
  const opts = resolveOptions(options);
  if (text.trim().length === 0) return [];
  const all: Chunk[] = [];
  for (const section of parseSections(text)) {
    const pieces = section.blocks.flatMap((block) =>
      refine(text, block, block.fence ? ['\n', ' ', ''] : ['\n\n', '\n', '. ', ' ', ''], opts),
    );
    const meta = { headings: section.headings };
    all.push(...pack(text, pieces, opts, meta));
  }
  return reindex(all);
}
