import { chunkCode, estimateTokens, type Chunk, type ChunkOptions } from './index';

/** Every chunk must be an exact slice; indexes sequential; budget respected. */
function assertInvariants(source: string, chunks: Chunk[], options: ChunkOptions = {}): void {
  const maxTokens = options.maxTokens ?? 512;
  const tokenizer = options.tokenizer ?? estimateTokens;
  chunks.forEach((chunk, position) => {
    expect(chunk.text).toBe(source.slice(chunk.start, chunk.end));
    expect(chunk.text.length).toBeGreaterThan(0);
    expect(chunk.index).toBe(position);
    expect(chunk.tokens).toBe(tokenizer(chunk.text));
    expect(chunk.tokens).toBeLessThanOrEqual(maxTokens);
  });
}

/** Every non-whitespace character of the source appears in some chunk. */
function assertCoverage(source: string, chunks: Chunk[]): void {
  const covered = new Array<boolean>(source.length).fill(false);
  for (const chunk of chunks) for (let offset = chunk.start; offset < chunk.end; offset++) covered[offset] = true;
  for (let offset = 0; offset < source.length; offset++) {
    if (!/\s/.test(source[offset])) expect(covered[offset]).toBe(true);
  }
}

/** A chunk may start after indentation, but never in the middle of a line. */
function assertLineStarts(source: string, chunks: Chunk[]): void {
  for (const chunk of chunks) {
    const lineStart = source.lastIndexOf('\n', chunk.start - 1) + 1;
    expect(source.slice(lineStart, chunk.start).trim()).toBe('');
  }
}

const byText = (chunks: Chunk[], needle: string): Chunk => {
  const found = chunks.find((chunk) => chunk.text.includes(needle));
  if (!found) throw new Error(`no chunk contains ${JSON.stringify(needle)}`);
  return found;
};

describe('chunkCode', () => {
  const typescript = [
    "import { readFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    '',
    '/** Adds two numbers. */',
    'export function add(left: number, right: number): number {',
    '  return left + right;',
    '}',
    '',
    'export const config = {',
    '  retries: 3,',
    '  timeoutMs: 5000,',
    '};',
    '',
    '@injectable()',
    'export class Loader {',
    '  constructor(private readonly base: string) {}',
    '',
    '  async load(name: string): Promise<string> {',
    "    return readFile(join(this.base, name), 'utf8');",
    '  }',
    '',
    '  async loadAll(names: string[]): Promise<string[]> {',
    '    return Promise.all(names.map((name) => this.load(name)));',
    '  }',
    '}',
    '',
  ].join('\n');

  it('keeps declarations whole and starts chunks at declaration boundaries', () => {
    const options = { maxTokens: 40, language: 'ts' };
    const chunks = chunkCode(typescript, options);
    assertInvariants(typescript, chunks, options);
    assertCoverage(typescript, chunks);
    assertLineStarts(typescript, chunks);
    const declarationStarts = ['import', '/**', 'export', '@injectable', 'async '];
    for (const chunk of chunks) {
      expect(declarationStarts.some((prefix) => chunk.text.startsWith(prefix))).toBe(true);
    }
  });

  it('keeps a doc comment with its declaration', () => {
    const chunks = chunkCode(typescript, { maxTokens: 40, language: 'ts' });
    const addChunk = byText(chunks, 'export function add');
    expect(addChunk.text.startsWith('/** Adds two numbers. */')).toBe(true);
    expect(addChunk.text.endsWith('}')).toBe(true);
  });

  it('labels chunks with the enclosing declaration and echoes the language', () => {
    const chunks = chunkCode(typescript, { maxTokens: 40, language: 'ts' });
    expect(byText(chunks, 'async load(name').meta).toEqual({ language: 'ts', symbol: 'export class Loader {' });
    expect(byText(chunks, 'loadAll').meta?.symbol).toBe('export class Loader {');
    expect(byText(chunks, 'retries: 3').meta?.symbol).toBe('export const config = {');
    expect(byText(chunks, 'export function add').meta?.symbol).toBe('export function add(left: number, right: number): number {');
    // decorators are skipped when naming the declaration
    expect(byText(chunks, '@injectable()').meta?.symbol).toBe('export class Loader {');
    // imports have no body, so nothing to name
    expect(byText(chunks, "import { join }").meta).toEqual({ language: 'ts' });
  });

  it('splits an oversized class at its methods and gives it its own chunks', () => {
    const chunks = chunkCode(typescript, { maxTokens: 40, language: 'ts' });
    const classChunk = byText(chunks, 'export class Loader');
    expect(classChunk.text.startsWith('@injectable()')).toBe(true);
    const methodChunks = chunks.filter((chunk) => chunk.meta?.symbol === 'export class Loader {');
    expect(methodChunks.length).toBeGreaterThan(1);
    for (const chunk of methodChunks.slice(1)) expect(chunk.text.startsWith('async ')).toBe(true);
  });

  const python = [
    'import os',
    '',
    'class Repository:',
    '    """Stores things on disk."""',
    '',
    '    def __init__(self, root):',
    '        self.root = root',
    '',
    '    def path(self, name):',
    '        return os.path.join(self.root, name)',
    '',
    '    def read(self, name):',
    '        with open(self.path(name)) as handle:',
    '            return handle.read()',
    '',
    'def helper():',
    '    return 1',
    '',
  ].join('\n');

  it('uses indentation for Python and cuts a class at its methods', () => {
    const options = { maxTokens: 30, language: 'python' };
    const chunks = chunkCode(python, options);
    assertInvariants(python, chunks, options);
    assertCoverage(python, chunks);
    assertLineStarts(python, chunks);
    expect(chunks[0].text).toBe('import os');
    expect(byText(chunks, 'class Repository:').text).toContain('def __init__');
    expect(byText(chunks, 'def path').text.startsWith('def path')).toBe(true);
    expect(byText(chunks, 'def read').meta?.symbol).toBe('class Repository:');
    expect(byText(chunks, 'def helper').meta?.symbol).toBe('def helper():');
    expect(byText(chunks, 'import os').meta).toEqual({ language: 'python' });
  });

  it('falls back to line splitting for a config file without declarations', () => {
    const config = Array.from({ length: 30 }, (_, position) => `key_${position}=value_${position}`).join('\n');
    const options = { maxTokens: 10 };
    const chunks = chunkCode(config, options);
    assertInvariants(config, chunks, options);
    assertCoverage(config, chunks);
    assertLineStarts(config, chunks);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.meta).toBeUndefined();
  });

  it('treats a declaration after a closing bracket as a new declaration', () => {
    const source = 'function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}\n';
    const chunks = chunkCode(source, { maxTokens: 10 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1].text.startsWith('function second')).toBe(true);
    expect(chunks[1].meta?.symbol).toBe('function second() {');
  });

  it('recognizes comment lines by the language hint', () => {
    const source = 'def first():\n    return 1\n\n# Second helper\ndef second():\n    return 2\n';
    const asPython = chunkCode(source, { maxTokens: 12, language: 'py' });
    expect(asPython).toHaveLength(2);
    expect(asPython[1].text.startsWith('# Second helper')).toBe(true);
    expect(asPython[1].meta?.symbol).toBe('def second():');
    // without a hint every common marker counts as a comment
    expect(chunkCode(source, { maxTokens: 12 })[1].meta?.symbol).toBe('def second():');
    // with a C-family hint the # line is code, so it names the declaration
    expect(chunkCode(source, { maxTokens: 12, language: 'ts' })[1].meta?.symbol).toBe('# Second helper');
  });

  it('honors overlap inside an oversized declaration', () => {
    const body = Array.from({ length: 60 }, (_, position) => `  total += ${position};`).join('\n');
    const source = `function sum() {\n  let total = 0;\n${body}\n  return total;\n}\n`;
    const options = { maxTokens: 50, overlap: 10 };
    const chunks = chunkCode(source, options);
    assertInvariants(source, chunks, options);
    expect(chunks.length).toBeGreaterThan(2);
    for (let position = 1; position < chunks.length; position++) {
      expect(chunks[position].start).toBeLessThan(chunks[position - 1].end);
      expect(chunks[position].meta?.symbol).toBe('function sum() {');
    }
  });

  it('cuts inside a line only when a single line exceeds the budget', () => {
    const minified = 'a=1;' + 'b=a+1;'.repeat(400);
    const chunks = chunkCode(minified, { maxTokens: 50 });
    assertInvariants(minified, chunks, { maxTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(minified);
  });

  it('returns [] for empty input and validates options', () => {
    expect(chunkCode('')).toEqual([]);
    expect(chunkCode('\n\n  \n')).toEqual([]);
    expect(() => chunkCode('x', { maxTokens: 0 })).toThrow(RangeError);
  });
});
