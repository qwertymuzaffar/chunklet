import { chunkMarkdown, chunkSentences, chunkText, estimateTokens, type Chunk, type ChunkOptions } from './index';
import { sentencePiecesFallback } from './sentences';
import { parseSections } from './markdown';

/** Every chunk must be an exact slice; indexes sequential; budget respected. */
function assertInvariants(source: string, chunks: Chunk[], options: ChunkOptions = {}): void {
  const maxTokens = options.maxTokens ?? 512;
  const tokenizer = options.tokenizer ?? estimateTokens;
  chunks.forEach((chunk, i) => {
    expect(chunk.text).toBe(source.slice(chunk.start, chunk.end));
    expect(chunk.text.length).toBeGreaterThan(0);
    expect(chunk.index).toBe(i);
    expect(chunk.tokens).toBe(tokenizer(chunk.text));
    expect(chunk.tokens).toBeLessThanOrEqual(maxTokens);
  });
}

/** Every non-whitespace character of the source appears in some chunk. */
function assertCoverage(source: string, chunks: Chunk[]): void {
  const covered = new Array<boolean>(source.length).fill(false);
  for (const c of chunks) for (let i = c.start; i < c.end; i++) covered[i] = true;
  for (let i = 0; i < source.length; i++) {
    if (!/\s/.test(source[i])) expect(covered[i]).toBe(true);
  }
}

const paragraphs = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i} talks about topic ${i} in a couple of sentences. It adds detail number ${i}.`).join('\n\n');

describe('chunkText', () => {
  it('returns [] for empty and whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n \t ')).toEqual([]);
  });

  it('returns one trimmed chunk when everything fits', () => {
    const chunks = chunkText('  hello world  \n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello world');
    assertInvariants('  hello world  \n', chunks);
  });

  it('holds the slice invariant and coverage on a long document', () => {
    const source = paragraphs(40);
    const options = { maxTokens: 64 };
    const chunks = chunkText(source, options);
    expect(chunks.length).toBeGreaterThan(3);
    assertInvariants(source, chunks, options);
    assertCoverage(source, chunks);
  });

  it('prefers paragraph boundaries over mid-sentence cuts', () => {
    const source = paragraphs(6);
    const chunks = chunkText(source, { maxTokens: 60 });
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.endsWith('.')).toBe(true);
    }
  });

  it('overlap repeats trailing context and respects the budget', () => {
    const source = paragraphs(20);
    const options = { maxTokens: 80, overlap: 20 };
    const chunks = chunkText(source, options);
    assertInvariants(source, chunks, options);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeLessThan(chunks[i - 1].end);
    }
  });

  it('supports a custom tokenizer (word count)', () => {
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    const source = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(source, { maxTokens: 10, tokenizer: words });
    assertInvariants(source, chunks, { maxTokens: 10, tokenizer: words });
    for (const chunk of chunks) expect(words(chunk.text)).toBeLessThanOrEqual(10);
  });

  it('hard-splits an unbroken string and reassembles exactly', () => {
    const source = 'x'.repeat(5000);
    const chunks = chunkText(source, { maxTokens: 100 });
    assertInvariants(source, chunks, { maxTokens: 100 });
    expect(chunks.map((c) => c.text).join('')).toBe(source);
  });

  it('validates options', () => {
    expect(() => chunkText('hi', { maxTokens: 0 })).toThrow(RangeError);
    expect(() => chunkText('hi', { overlap: -1 })).toThrow(RangeError);
    expect(() => chunkText('hi', { maxTokens: 10, overlap: 10 })).toThrow(RangeError);
  });
});

describe('chunkSentences', () => {
  const prose =
    'The quick brown fox jumps over the lazy dog. ' +
    'Mr. Smith went to Washington yesterday afternoon. ' +
    'Did the experiment succeed? It did! ' +
    'The final sentence wraps up the paragraph neatly.';

  it('keeps sentences whole within the budget', () => {
    const chunks = chunkSentences(prose, { maxTokens: 30 });
    assertInvariants(prose, chunks, { maxTokens: 30 });
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/[.!?]$/);
    }
  });

  it('degrades gracefully when one sentence exceeds the budget', () => {
    const long = 'word '.repeat(300).trim() + '.';
    const chunks = chunkSentences(long, { maxTokens: 50 });
    assertInvariants(long, chunks, { maxTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('fallback splitter tiles the input exactly', () => {
    const pieces = sentencePiecesFallback(prose);
    expect(pieces[0].start).toBe(0);
    expect(pieces[pieces.length - 1].end).toBe(prose.length);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i].start).toBe(pieces[i - 1].end);
    }
  });

  it('returns [] for empty input', () => {
    expect(chunkSentences('')).toEqual([]);
  });
});

describe('chunkMarkdown', () => {
  const doc = [
    'Intro text before any heading.',
    '',
    '# Guide',
    '',
    'Opening words for the guide.',
    '',
    '## Install',
    '',
    'Run the installer as shown below.',
    '',
    '```bash',
    'npm i chunklet',
    'npm test',
    '```',
    '',
    '## Usage',
    '',
    'Import the function and call it.',
    '',
    '### Advanced',
    '',
    'Overlap and custom tokenizers are supported.',
    '',
    '# Appendix',
    '',
    'Closing notes.',
  ].join('\n');

  it('attaches heading breadcrumbs, outermost first', () => {
    const chunks = chunkMarkdown(doc, { maxTokens: 40 });
    assertInvariants(doc, chunks, { maxTokens: 40 });
    const byText = (needle: string) => chunks.find((c) => c.text.includes(needle))!;
    expect(byText('Intro text').meta?.headings).toEqual([]);
    expect(byText('Opening words').meta?.headings).toEqual(['Guide']);
    expect(byText('npm i chunklet').meta?.headings).toEqual(['Guide', 'Install']);
    expect(byText('Overlap and custom').meta?.headings).toEqual(['Guide', 'Usage', 'Advanced']);
    expect(byText('Closing notes').meta?.headings).toEqual(['Appendix']);
  });

  it('keeps a fitting code fence in one piece', () => {
    const chunks = chunkMarkdown(doc, { maxTokens: 60 });
    const fenceChunk = chunks.find((c) => c.text.includes('npm i chunklet'))!;
    expect(fenceChunk.text).toContain('```bash');
    expect(fenceChunk.text.match(/```/g)!.length).toBe(2);
  });

  it('splits an oversized fence within the fence only', () => {
    const bigFence = '# Code\n\n```js\n' + Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```\n';
    const chunks = chunkMarkdown(bigFence, { maxTokens: 50 });
    assertInvariants(bigFence, chunks, { maxTokens: 50 });
    const codeChunks = chunks.filter((c) => c.text.includes('const '));
    expect(codeChunks.length).toBeGreaterThan(1);
    for (const chunk of codeChunks) expect(chunk.meta?.headings).toEqual(['Code']);
  });

  it('handles an unclosed fence to end of input', () => {
    const src = '# T\n\n```\nunclosed code';
    const chunks = chunkMarkdown(src);
    assertInvariants(src, chunks);
    expect(chunks.some((c) => c.text.includes('unclosed code'))).toBe(true);
  });

  it('parseSections resets sibling headings correctly', () => {
    const sections = parseSections('# A\ntext\n## B\ntext\n## C\ntext\n# D\ntext\n');
    expect(sections.map((s) => s.headings)).toEqual([['A'], ['A', 'B'], ['A', 'C'], ['D']]);
  });

  it('returns [] for empty input and reindexes across sections', () => {
    expect(chunkMarkdown('')).toEqual([]);
    const chunks = chunkMarkdown(doc, { maxTokens: 30 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });
});

describe('estimateTokens', () => {
  it('approximates 4 chars per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
