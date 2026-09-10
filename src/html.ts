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

/** The break a block-level tag introduces, or null for an inline tag. */
function breakRankOf(name: string, isHeading: boolean): number | null {
  if (isHeading || PARAGRAPH_TAGS.has(name)) return PARAGRAPH_BREAK;
  if (LINE_TAGS.has(name)) return LINE_BREAK;
  if (CELL_TAGS.has(name)) return CELL_BREAK;
  return null;
}

/**
 * Turns HTML into readable text plus the block and heading structure the
 * chunker needs. Block elements become paragraph, line or cell breaks,
 * whitespace collapses like a browser renders it (except inside <pre>),
 * script/style/template/svg/iframe content and comments are dropped, and
 * entities are decoded. Every character of the text maps back to the HTML.
 *
 * One instance extracts one document: the fields are the scanner's state
 * (the open block, the pending break, the heading breadcrumb, whether a
 * <pre> or a block-level <code> is open) and the methods are its transitions.
 */
class HtmlExtractor {
  private readonly lower: string;
  private text = '';
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly sections: HtmlSection[] = [];
  private readonly headingStack: { level: number; title: string }[] = [];
  private section: HtmlSection = { headings: [], blocks: [] };
  private block: { start: number; atomic: boolean } | null = null;
  private contentEnd = 0;
  private pendingBreak = 0;
  private breakPosition = 0;
  private preformatted = 0;
  private headingLevel: number | null = null;
  private codeOpenedBlock = false;
  private codeJustClosed = false;

  /** Opening tags with a transition of their own; every other tag is a block boundary or inline. */
  private readonly openers = new Map<string, (tag: Tag) => void>([
    ['br', (tag) => {
      if (this.block) this.push('\n', tag.start, tag.end);
    }],
    ['pre', (tag) => {
      this.breakAt(PARAGRAPH_BREAK, tag.start);
      this.preformatted++;
    }],
    ['code', () => {
      if (this.preformatted === 0 && !this.block) this.codeOpenedBlock = true;
    }],
  ]);

  /** Closing tags with a transition of their own. */
  private readonly closers = new Map<string, (position: number) => void>([
    ['pre', (position) => {
      this.preformatted = Math.max(0, this.preformatted - 1);
      this.breakAt(PARAGRAPH_BREAK, position);
    }],
    ['code', () => {
      if (!this.codeOpenedBlock || !this.block) return;
      // atomic unless text follows within the same block
      this.block.atomic = true;
      this.codeJustClosed = true;
      this.codeOpenedBlock = false;
    }],
  ]);

  constructor(private readonly html: string) {
    this.lower = html.toLowerCase();
  }

  /** Scans the document once: markup goes to handleTag, everything else is text. */
  run(): Extraction {
    const { html } = this;
    let at = 0;
    while (at < html.length) {
      const char = html[at];
      if (char === '<') {
        const markup = readMarkup(html, at);
        if (markup === null) {
          this.content('<', at, at + 1);
          at++;
          continue;
        }
        at = 'skipTo' in markup ? markup.skipTo : this.handleTag(markup);
        continue;
      }
      if (char === '&') {
        const entity = decodeEntity(html, at);
        if (entity) {
          if (WHITESPACE.test(entity.text)) this.whitespace(entity.text, at, at + entity.length);
          else if (entity.text !== '') this.content(entity.text, at, at + entity.length);
          at += entity.length;
          continue;
        }
      }
      if (WHITESPACE.test(char)) this.whitespace(char, at, at + 1);
      else this.content(char, at, at + 1);
      at++;
    }
    this.breakAt(PARAGRAPH_BREAK, html.length);
    if (this.section.blocks.length > 0) this.sections.push(this.section);
    return { text: this.text, starts: this.starts, ends: this.ends, sections: this.sections };
  }

  /** Applies a tag's effect on the state and returns where scanning resumes. */
  private handleTag(tag: Tag): number {
    const heading = HEADING_TAG.exec(tag.name);
    if (tag.closing) {
      this.closeTag(tag.name, heading !== null, tag.start);
      return tag.end;
    }
    if (SKIPPED_TAGS.has(tag.name)) return tag.selfClosing ? tag.end : skipElement(this.lower, tag.end, tag.name);
    this.openTag(tag, heading);
    return tag.end;
  }

  private closeTag(name: string, isHeading: boolean, position: number): void {
    const special = this.closers.get(name);
    if (special) return special(position);
    const rank = breakRankOf(name, isHeading);
    if (rank !== null) this.breakAt(rank, position);
  }

  private openTag(tag: Tag, heading: RegExpExecArray | null): void {
    const special = this.openers.get(tag.name);
    if (special) return special(tag);
    if (heading) return this.openHeading(Number(heading[1]), tag.start);
    const rank = breakRankOf(tag.name, false);
    if (rank !== null) this.breakAt(rank, tag.start);
  }

  private push(piece: string, from: number, to: number): void {
    for (let unit = 0; unit < piece.length; unit++) {
      this.starts.push(from);
      this.ends.push(to);
    }
    this.text += piece;
  }

  private content(piece: string, from: number, to: number): void {
    if (this.codeJustClosed) {
      // text followed the </code>, so it was inline code, not a code block
      if (this.block) this.block.atomic = this.preformatted > 0;
      this.codeJustClosed = false;
    }
    if (!this.block) {
      if (this.pendingBreak > 0 && this.text.length > 0) this.push(BREAK_TEXT[this.pendingBreak], this.breakPosition, this.breakPosition);
      this.pendingBreak = 0;
      this.block = { start: this.text.length, atomic: this.preformatted > 0 };
    }
    this.push(piece, from, to);
    this.contentEnd = this.text.length;
  }

  private whitespace(piece: string, from: number, to: number): void {
    if (!this.block) return; // leading whitespace in a block: the pending break already separates it
    if (this.preformatted > 0) this.push(piece, from, to);
    else if (!WHITESPACE.test(this.text[this.text.length - 1])) this.push(' ', from, to);
  }

  private closeBlock(): void {
    if (this.block) this.section.blocks.push({ start: this.block.start, end: this.contentEnd, atomic: this.block.atomic });
    this.block = null;
    this.codeOpenedBlock = false;
    this.codeJustClosed = false;
  }

  private finishHeading(): void {
    if (this.headingLevel === null) return;
    const title = this.block ? this.text.slice(this.block.start, this.contentEnd).trim() : '';
    while (this.headingStack.length > 0 && this.headingStack[this.headingStack.length - 1].level >= this.headingLevel) this.headingStack.pop();
    if (title) this.headingStack.push({ level: this.headingLevel, title });
    this.section.headings = this.headingStack.map((entry) => entry.title);
    this.headingLevel = null;
  }

  private breakAt(rank: number, position: number): void {
    this.finishHeading();
    this.closeBlock();
    if (rank > this.pendingBreak) {
      this.pendingBreak = rank;
      this.breakPosition = position;
    }
  }

  private openHeading(level: number, position: number): void {
    this.breakAt(PARAGRAPH_BREAK, position);
    if (this.section.blocks.length > 0) this.sections.push(this.section);
    this.section = { headings: this.section.headings, blocks: [] };
    this.headingLevel = level;
  }
}

function extract(html: string): Extraction {
  return new HtmlExtractor(html).run();
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
