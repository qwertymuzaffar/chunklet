import { pack, refine, reindex, type Piece } from './core';
import { resolveOptions, type Chunk, type ChunkOptions } from './types';

/** Result of chunkHtml. Chunk offsets refer to `text`, the readable text extracted from the HTML. */
export interface HtmlChunkResult {
  /** Readable text: block structure kept as line breaks, tags and noise removed, entities decoded. */
  text: string;
  chunks: Chunk[];
}

interface HtmlBlock extends Piece {
  /** Preformatted or code block: split by lines only, never merged mid-block. */
  atomic: boolean;
}

interface HtmlSection {
  headings: string[];
  blocks: HtmlBlock[];
}

interface Extraction {
  text: string;
  /** starts[i] / ends[i]: the range in the original HTML that produced text[i]. */
  starts: number[];
  ends: number[];
  sections: HtmlSection[];
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  start: number;
  end: number;
}

const PARAGRAPH_BREAK = 3;
const LINE_BREAK = 2;
const CELL_BREAK = 1;
const BREAK_TEXT: Record<number, string> = { [PARAGRAPH_BREAK]: '\n\n', [LINE_BREAK]: '\n', [CELL_BREAK]: '\t' };

const PARAGRAPH_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'details', 'dialog', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'head', 'header', 'hr', 'html', 'legend',
  'main', 'menu', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'title', 'ul',
]);
const LINE_TAGS = new Set(['caption', 'dd', 'dt', 'li', 'optgroup', 'option', 'tr']);
const CELL_TAGS = new Set(['td', 'th']);
/** Elements whose content is not readable text. */
const SKIPPED_TAGS = new Set(['iframe', 'noscript', 'object', 'script', 'style', 'svg', 'template', 'textarea']);
const HEADING_TAG = /^h([1-6])$/;
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9:-]*/y;
const WHITESPACE = /\s/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwj: '', zwnj: '', shy: '',
  copy: '©', reg: '®', trade: '™', deg: '°', sect: '§', para: '¶',
  middot: '·', bull: '•', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  times: '×', divide: '÷', plusmn: '±', minus: '−', ne: '≠', le: '≤', ge: '≥',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ',
  Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
};
const ENTITY = /^&(?:#x([0-9a-f]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]*));/i;

/** Decodes the entity at html[at] === '&'; null leaves the '&' as literal text. */
function decodeEntity(html: string, at: number): { text: string; length: number } | null {
  const match = ENTITY.exec(html.slice(at, at + 40));
  if (!match) return null;
  const [whole, hex, decimal, named] = match;
  if (named !== undefined) {
    const decoded = NAMED_ENTITIES[named];
    return decoded === undefined ? null : { text: decoded, length: whole.length };
  }
  const codePoint = hex !== undefined ? parseInt(hex, 16) : parseInt(decimal!, 10);
  const valid = codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  return { text: valid ? String.fromCodePoint(codePoint) : '�', length: whole.length };
}

/**
 * Reads the markup at html[at] === '<'. Comments, doctype and processing
 * instructions are skipped; a '<' that does not open a tag is literal text.
 */
function readMarkup(html: string, at: number): Tag | { skipTo: number } | null {
  if (html.startsWith('<!--', at)) {
    const close = html.indexOf('-->', at + 4);
    return { skipTo: close === -1 ? html.length : close + 3 };
  }
  const next = html[at + 1];
  if (next === '!' || next === '?') {
    const close = html.indexOf('>', at);
    return { skipTo: close === -1 ? html.length : close + 1 };
  }
  const closing = next === '/';
  TAG_NAME.lastIndex = closing ? at + 2 : at + 1;
  const name = TAG_NAME.exec(html);
  if (!name) return null;
  const attributesStart = TAG_NAME.lastIndex;
  let cursor = attributesStart;
  let quote: string | null = null;
  while (cursor < html.length) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      break;
    }
    cursor++;
  }
  if (cursor >= html.length) {
    // an unbalanced quote must not swallow the rest of the page
    cursor = html.indexOf('>', attributesStart);
    if (cursor === -1) return null;
  }
  return { name: name[0].toLowerCase(), closing, selfClosing: html[cursor - 1] === '/', start: at, end: cursor + 1 };
}

/** Position right after the closing tag of a raw-content element, or the end of the input. */
function skipElement(lower: string, from: number, name: string): number {
  const close = lower.indexOf('</' + name, from);
  if (close === -1) return lower.length;
  const end = lower.indexOf('>', close);
  return end === -1 ? lower.length : end + 1;
}

/**
 * Turns HTML into readable text plus the block and heading structure the
 * chunker needs. Block elements become paragraph, line or cell breaks,
 * whitespace collapses like a browser renders it (except inside <pre>),
 * script/style/template/svg/iframe content and comments are dropped, and
 * entities are decoded. Every character of the text maps back to the HTML.
 */
function extract(html: string): Extraction {
  const lower = html.toLowerCase();
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const sections: HtmlSection[] = [];
  const headingStack: { level: number; title: string }[] = [];
  let section: HtmlSection = { headings: [], blocks: [] };
  let block: { start: number; atomic: boolean } | null = null;
  let contentEnd = 0;
  let pendingBreak = 0;
  let breakPosition = 0;
  let preformatted = 0;
  let headingLevel: number | null = null;
  let codeOpenedBlock = false;
  let codeJustClosed = false;

  const push = (piece: string, from: number, to: number) => {
    for (let unit = 0; unit < piece.length; unit++) {
      starts.push(from);
      ends.push(to);
    }
    text += piece;
  };

  const content = (piece: string, from: number, to: number) => {
    if (codeJustClosed) {
      // text followed the </code>, so it was inline code, not a code block
      if (block) block.atomic = preformatted > 0;
      codeJustClosed = false;
    }
    if (!block) {
      if (pendingBreak > 0 && text.length > 0) push(BREAK_TEXT[pendingBreak], breakPosition, breakPosition);
      pendingBreak = 0;
      block = { start: text.length, atomic: preformatted > 0 };
    }
    push(piece, from, to);
    contentEnd = text.length;
  };

  const whitespace = (piece: string, from: number, to: number) => {
    if (!block) return; // leading whitespace in a block: the pending break already separates it
    if (preformatted > 0) push(piece, from, to);
    else if (!WHITESPACE.test(text[text.length - 1])) push(' ', from, to);
  };

  const closeBlock = () => {
    if (block) section.blocks.push({ start: block.start, end: contentEnd, atomic: block.atomic });
    block = null;
    codeOpenedBlock = false;
    codeJustClosed = false;
  };

  const finishHeading = () => {
    if (headingLevel === null) return;
    const title = block ? text.slice(block.start, contentEnd).trim() : '';
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= headingLevel) headingStack.pop();
    if (title) headingStack.push({ level: headingLevel, title });
    section.headings = headingStack.map((entry) => entry.title);
    headingLevel = null;
  };

  const breakAt = (rank: number, position: number) => {
    finishHeading();
    closeBlock();
    if (rank > pendingBreak) {
      pendingBreak = rank;
      breakPosition = position;
    }
  };

  const lineBreak = (from: number, to: number) => {
    if (block) push('\n', from, to);
  };

  const closeCode = () => {
    if (!codeOpenedBlock || !block) return;
    // atomic unless text follows within the same block
    block.atomic = true;
    codeJustClosed = true;
    codeOpenedBlock = false;
  };

  const openHeading = (level: number, position: number) => {
    breakAt(PARAGRAPH_BREAK, position);
    if (section.blocks.length > 0) sections.push(section);
    section = { headings: section.headings, blocks: [] };
    headingLevel = level;
  };

  let at = 0;
  while (at < html.length) {
    const char = html[at];
    if (char === '<') {
      const markup = readMarkup(html, at);
      if (markup === null) {
        content('<', at, at + 1);
        at++;
        continue;
      }
      if ('skipTo' in markup) {
        at = markup.skipTo;
        continue;
      }
      at = markup.end;
      const { name } = markup;
      const heading = HEADING_TAG.exec(name);
      if (markup.closing) {
        if (name === 'pre') {
          preformatted = Math.max(0, preformatted - 1);
          breakAt(PARAGRAPH_BREAK, markup.start);
        } else if (heading || PARAGRAPH_TAGS.has(name)) {
          breakAt(PARAGRAPH_BREAK, markup.start);
        } else if (LINE_TAGS.has(name)) {
          breakAt(LINE_BREAK, markup.start);
        } else if (CELL_TAGS.has(name)) {
          breakAt(CELL_BREAK, markup.start);
        } else if (name === 'code') {
          closeCode();
        }
      } else if (SKIPPED_TAGS.has(name)) {
        if (!markup.selfClosing) at = skipElement(lower, at, name);
      } else if (name === 'br') {
        lineBreak(markup.start, markup.end);
      } else if (name === 'pre') {
        breakAt(PARAGRAPH_BREAK, markup.start);
        preformatted++;
      } else if (heading) {
        openHeading(Number(heading[1]), markup.start);
      } else if (PARAGRAPH_TAGS.has(name)) {
        breakAt(PARAGRAPH_BREAK, markup.start);
      } else if (LINE_TAGS.has(name)) {
        breakAt(LINE_BREAK, markup.start);
      } else if (CELL_TAGS.has(name)) {
        breakAt(CELL_BREAK, markup.start);
      } else if (name === 'code' && preformatted === 0 && !block) {
        codeOpenedBlock = true;
      }
      continue;
    }
    if (char === '&') {
      const entity = decodeEntity(html, at);
      if (entity) {
        if (entity.text !== '') (WHITESPACE.test(entity.text) ? whitespace : content)(entity.text, at, at + entity.length);
        at += entity.length;
        continue;
      }
    }
    (WHITESPACE.test(char) ? whitespace : content)(char, at, at + 1);
    at++;
  }
  breakAt(PARAGRAPH_BREAK, html.length);
  if (section.blocks.length > 0) sections.push(section);
  return { text, starts, ends, sections };
}

/**
 * HTML chunking: readable text is extracted first (block elements become
 * boundaries, headings become breadcrumbs, <pre> and standalone <code>
 * blocks stay atomic, script/style/comments are dropped, entities decoded)
 * and then chunked like markdown. Offsets refer to the returned text;
 * meta.source maps each chunk back to its range in the original HTML.
 */
export function chunkHtml(html: string, options?: ChunkOptions): HtmlChunkResult {
  const opts = resolveOptions(options);
  const { text, starts, ends, sections } = extract(html);
  const all: Chunk[] = [];
  for (const section of sections) {
    const pieces = section.blocks.flatMap((block) =>
      refine(text, block, block.atomic ? ['\n', ' ', ''] : ['\n\n', '\n', '. ', ' ', ''], opts),
    );
    for (const chunk of pack(text, pieces, opts, { headings: section.headings })) all.push(chunk);
  }
  const chunks = reindex(all).map((chunk) => ({
    ...chunk,
    meta: { ...chunk.meta, source: { start: starts[chunk.start], end: ends[chunk.end - 1] } },
  }));
  return { text, chunks };
}
