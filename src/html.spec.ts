import { chunkHtml, estimateTokens, type Chunk, type ChunkOptions } from './index';

/** Every chunk must be an exact slice of the extracted text; indexes sequential; budget respected. */
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

const byText = (chunks: Chunk[], needle: string): Chunk => {
  const found = chunks.find((chunk) => chunk.text.includes(needle));
  if (!found) throw new Error(`no chunk contains ${JSON.stringify(needle)}`);
  return found;
};

describe('chunkHtml', () => {
  const page = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <title>Chunklet guide</title>',
    '  <style>body { color: red; }</style>',
    '  <script>console.log("secret token");</script>',
    '</head>',
    '<body>',
    '  <!-- navigation goes here -->',
    '  <h1>Guide</h1>',
    '  <p>Opening words   for the <em>guide</em>.</p>',
    '  <h2>Install</h2>',
    '  <p>Run the installer as shown below.</p>',
    '  <pre><code>npm i chunklet',
    'npm test</code></pre>',
    '  <h2>Usage</h2>',
    '  <p>Import the function &amp; call it.</p>',
    '  <h3>Advanced</h3>',
    '  <ul>',
    '    <li>Overlap</li>',
    '    <li>Custom tokenizers</li>',
    '  </ul>',
    '  <h1>Appendix</h1>',
    '  <p>Closing notes &copy; 2026.</p>',
    '</body>',
    '</html>',
  ].join('\n');

  it('extracts readable text with block structure and drops noise', () => {
    const { text } = chunkHtml(page);
    expect(text).toBe(
      [
        'Chunklet guide',
        'Guide',
        'Opening words for the guide.',
        'Install',
        'Run the installer as shown below.',
        'npm i chunklet\nnpm test',
        'Usage',
        'Import the function & call it.',
        'Advanced',
        'Overlap\nCustom tokenizers',
        'Appendix',
        'Closing notes © 2026.',
      ].join('\n\n'),
    );
    expect(text).not.toContain('secret');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('navigation');
  });

  it('attaches heading breadcrumbs, outermost first', () => {
    const options = { maxTokens: 20 };
    const { text, chunks } = chunkHtml(page, options);
    assertInvariants(text, chunks, options);
    expect(byText(chunks, 'Chunklet guide').meta?.headings).toEqual([]);
    expect(byText(chunks, 'Opening words').meta?.headings).toEqual(['Guide']);
    expect(byText(chunks, 'npm i chunklet').meta?.headings).toEqual(['Guide', 'Install']);
    expect(byText(chunks, 'Overlap').meta?.headings).toEqual(['Guide', 'Usage', 'Advanced']);
    expect(byText(chunks, 'Closing notes').meta?.headings).toEqual(['Appendix']);
  });

  it('maps every chunk back to its range in the original HTML', () => {
    const { text, chunks } = chunkHtml(page, { maxTokens: 20 });
    for (const chunk of chunks) {
      const source = chunk.meta!.source!;
      const original = page.slice(source.start, source.end);
      const firstWord = chunk.text.split(/\s/)[0];
      expect(original.startsWith(firstWord)).toBe(true);
      expect(original.length).toBeGreaterThanOrEqual(chunk.text.length - 1);
    }
    const small = chunkHtml(page, { maxTokens: 8 });
    const opening = byText(small.chunks, 'Opening words');
    expect(page.slice(opening.meta!.source!.start, opening.meta!.source!.end)).toBe(
      'Opening words   for the <em>guide</em>.',
    );
    const entity = byText(small.chunks, 'Import the function');
    expect(page.slice(entity.meta!.source!.start, entity.meta!.source!.end)).toBe('Import the function &amp; call it.');
    expect(small.text.slice(opening.start, opening.end)).toBe(opening.text);
    expect(text).toBe(small.text);
  });

  it('keeps a fitting pre block whole with its whitespace', () => {
    const { chunks } = chunkHtml(page, { maxTokens: 30 });
    const preChunk = byText(chunks, 'npm i chunklet');
    expect(preChunk.text).toContain('npm i chunklet\nnpm test');
  });

  it('splits an oversized pre block by lines only and keeps its breadcrumb', () => {
    const lines = Array.from({ length: 200 }, (_, position) => `const value${position} = ${position};`).join('\n');
    const html = `<h1>Code</h1><pre><code>${lines}</code></pre>`;
    const options = { maxTokens: 50 };
    const { text, chunks } = chunkHtml(html, options);
    assertInvariants(text, chunks, options);
    const codeChunks = chunks.filter((chunk) => chunk.text.includes('const '));
    expect(codeChunks.length).toBeGreaterThan(1);
    for (const chunk of codeChunks) {
      expect(chunk.meta?.headings).toEqual(['Code']);
      expect(chunk.text.endsWith(';')).toBe(true);
    }
  });

  it('treats a standalone code element as a block but inline code as text', () => {
    const standalone = chunkHtml('<div><code>one\ntwo</code></div>');
    expect(standalone.text).toBe('one two');
    const inline = chunkHtml('<p>Call <code>chunkText</code> first.</p>');
    expect(inline.text).toBe('Call chunkText first.');
  });

  it('decodes common named and numeric entities', () => {
    const { text } = chunkHtml('<p>Fish &amp; chips &lt;3 &#169; &#x1F600; &unknown; &nbsp;done &eacute;</p>');
    expect(text).toBe('Fish & chips <3 © \u{1F600} &unknown; done é');
  });

  it('tolerates stray angle brackets and unclosed tags', () => {
    expect(chunkHtml('<p>1 < 2 and 3 > 2</p>').text).toBe('1 < 2 and 3 > 2');
    expect(chunkHtml('<p>Unclosed <b>bold').text).toBe('Unclosed bold');
    expect(chunkHtml('<p title="a > b">quoted</p>').text).toBe('quoted');
    expect(chunkHtml("<p title='oops>broken</p><p>next</p>").text).toBe('broken\n\nnext');
  });

  it('separates lines, cells and line breaks', () => {
    expect(chunkHtml('<ul><li>one</li><li>two</li></ul>').text).toBe('one\ntwo');
    expect(chunkHtml('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>').text).toBe('a\tb\nc');
    expect(chunkHtml('<p>first<br>second<br/>third</p>').text).toBe('first\nsecond\nthird');
  });

  it('resets sibling headings and keeps content before the first heading', () => {
    const html = '<p>intro</p><h1>A</h1><p>a</p><h2>B</h2><p>b</p><h2>C</h2><p>c</p><h1>D</h1><p>d</p>';
    const { chunks } = chunkHtml(html, { maxTokens: 2 });
    const breadcrumbs = ['intro', 'a', 'b', 'c', 'd'].map((needle) => byText(chunks, needle).meta?.headings);
    expect(breadcrumbs).toEqual([[], ['A'], ['A', 'B'], ['A', 'C'], ['D']]);
    chunks.forEach((chunk, position) => expect(chunk.index).toBe(position));
  });

  it('returns no chunks for empty or noise-only input and validates options', () => {
    expect(chunkHtml('')).toEqual({ text: '', chunks: [] });
    expect(chunkHtml('<div><script>x()</script><!-- c --></div>').chunks).toEqual([]);
    expect(() => chunkHtml('<p>x</p>', { maxTokens: 0 })).toThrow(RangeError);
  });
});
