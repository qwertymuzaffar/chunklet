# chunklet

[![npm version](https://img.shields.io/npm/v/chunklet)](https://www.npmjs.com/package/chunklet)
[![CI](https://github.com/qwertymuzaffar/chunklet/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertymuzaffar/chunklet/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Token-aware, structure-aware text chunking for RAG pipelines - **zero dependencies**, runs in Node, browsers, and edge runtimes.

Two ideas define it. **Exact source offsets**: every chunk guarantees

```ts
chunk.text === source.slice(chunk.start, chunk.end)
```

so you can highlight citations, deep-link retrieval hits, or store embeddings without storing text. And **structure awareness**: chunks respect the document - markdown sections with heading breadcrumbs, whole sentences, atomic code fences, whole declarations in source files - and a word is never cut in half unless a single word exceeds the budget.

## Install

```bash
npm i chunklet
```

## Quick start

```ts
import { chunkText } from 'chunklet';

const source = await fs.readFile('handbook.txt', 'utf8');
const chunks = chunkText(source, { maxTokens: 512, overlap: 64 });

for (const chunk of chunks) {
  console.log(chunk.index, chunk.tokens, `[${chunk.start}-${chunk.end}]`);
  console.log(chunk.text.slice(0, 60) + '...');
}
```

Every chunk is:

```ts
{
  text: string;    // exactly source.slice(start, end)
  start: number;   // character offset, inclusive
  end: number;     // character offset, exclusive
  tokens: number;  // per the active tokenizer
  index: number;   // 0-based position
  meta?: { headings?: string[]; language?: string; symbol?: string }; // markdown / code modes
}
```

### How the splitting works

`chunkText` splits hierarchically: paragraphs (`\n\n`) first, then lines, then sentences, then words - and only descends a level when a piece is still over the token budget. The resulting pieces are packed back together greedily up to `maxTokens`. The effect: chunks end at the most natural boundary available, and a mid-word cut can only happen when a single word alone exceeds the budget.

Chunk edges are whitespace-trimmed *with the offsets adjusted*, so the slice invariant always holds - the text is never normalized, joined with synthetic separators, or otherwise rewritten.

### Overlap

`overlap` repeats trailing context at the start of the next chunk, which softens the "answer was split across two chunks" failure mode of retrieval:

```ts
const chunks = chunkText(source, { maxTokens: 512, overlap: 64 });
// chunk 3 begins with the last ~64 tokens of chunk 2
```

Overlap is honored even when the previous chunk ends in one long piece - chunklet takes a suffix of it rather than silently skipping the overlap.

## Sentence mode

```ts
import { chunkSentences } from 'chunklet';

const chunks = chunkSentences(article, { maxTokens: 256 });
```

Whole sentences are packed into the budget, so a chunk never ends mid-sentence (unless a single sentence is itself over budget - then it degrades to word splitting). Boundaries come from `Intl.Segmenter`, which handles abbreviations like "Mr. Smith" and locale rules correctly; a regex fallback covers runtimes without it.

Use this over `chunkText` when your chunks are small (embedding models with short context, tweet-sized snippets) and a dangling half-sentence would hurt embedding quality.

## Markdown mode

```ts
import { chunkMarkdown } from 'chunklet';

const chunks = chunkMarkdown(readme, { maxTokens: 512 });

chunks[4].text;           // "## Install\n\nRun the installer..."
chunks[4].meta?.headings; // ['Guide', 'Install']
```

What it does differently:

- **Sections follow the headings.** A chunk never crosses an ATX heading (`#` through `######`), so retrieval hits map cleanly to document sections.
- **Every chunk knows where it lives.** `meta.headings` is the breadcrumb of enclosing headings, outermost first. Content before the first heading gets `[]`.
- **Code fences are atomic.** A fenced block is never merged mid-fence with prose, and only split internally (line by line) when the fence alone exceeds the budget.

## Code mode

```ts
import { chunkCode } from 'chunklet';

const chunks = chunkCode(source, { maxTokens: 512, language: 'ts' });

chunks[2].text;           // "/** Loads one file. */\nexport async function load(name: string) {..."
chunks[2].meta?.symbol;   // 'export async function load(name: string): Promise<string> {'
chunks[2].meta?.language; // 'ts'
```

Source files are split at declarations, not at arbitrary lines:

- **Declarations are the unit.** A top-level declaration starts at an unindented line that follows a blank line or a closing bracket (or opens the file). Comment lines directly above it belong to it, so a doc comment stays with its function. A declaration that fits the budget is never split, and small ones are packed together.
- **Oversized declarations split at structure.** A class or function over the budget starts its own chunks and is cut at blank lines before its least-indented members first (methods before the statements inside them), then after closing brackets and at dedents, then at line breaks. A chunk never starts mid-line unless a single line alone exceeds the budget.
- **Every chunk can say where it came from.** `meta.symbol` is the first line of the enclosing top-level declaration (comments and decorators skipped) whenever the chunk sits inside one declaration with an indented body; imports and one-liners get none. `meta.language` echoes the hint.
- **Language agnostic.** Boundaries come from indentation and blank lines, so anything indented consistently works. The `language` hint only decides what counts as a comment line (`//` and `/* */` for the C family, `#` for Python and shells, `--` for SQL and Lua, ...); without it every common marker is recognized.

## Recipes

### RAG ingestion

```ts
import { chunkMarkdown } from 'chunklet';

const chunks = chunkMarkdown(doc, { maxTokens: 400, overlap: 40 });

for (const chunk of chunks) {
  // prepend the breadcrumb - cheap and measurably better retrieval
  const context = chunk.meta?.headings?.length
    ? chunk.meta.headings.join(' > ') + '\n\n' + chunk.text
    : chunk.text;

  await db.insert({
    id: `${docId}#${chunk.index}`,
    embedding: await embed(context),
    start: chunk.start, // store offsets, not text
    end: chunk.end,
  });
}
```

### Citation highlighting

Because offsets are exact, mapping a retrieval hit back onto the original document is a slice, not a fuzzy search:

```ts
const hit = results[0]; // { start, end } straight from the stored chunk

const before = doc.slice(0, hit.start);
const match = doc.slice(hit.start, hit.end);
const after = doc.slice(hit.end);
render(`${before}<mark>${escape(match)}</mark>${after}`);
```

### Real token counts

The default tokenizer is a fast chars/4 heuristic - fine for packing budgets. For exact counts, plug in any counter:

```ts
import { encodingForModel } from 'js-tiktoken';

const enc = encodingForModel('gpt-4o');
const chunks = chunkText(doc, {
  maxTokens: 512,
  tokenizer: (t) => enc.encode(t).length,
});
```

The tokenizer is called on candidate slices during packing, so a heavyweight tokenizer slows chunking - the heuristic + a safety margin (e.g. budget 480 for a 512 limit) is often the better trade.

## API

| Export | Description |
|---|---|
| `chunkText(text, options?)` | Hierarchical separator splitting (paragraphs > lines > sentences > words) |
| `chunkSentences(text, options?)` | Sentence-boundary packing via `Intl.Segmenter` |
| `chunkMarkdown(text, options?)` | Heading-aware sections + breadcrumbs, atomic code fences |
| `chunkCode(source, options?)` | Declaration-aware splitting for source files, `meta.symbol` + `meta.language` |
| `estimateTokens(text)` | The default chars/4 heuristic |

### Options

| Option | Default | Description |
|---|---|---|
| `maxTokens` | `512` | Token budget per chunk |
| `overlap` | `0` | Tokens of trailing context repeated at the start of the next chunk (must be < `maxTokens`) |
| `tokenizer` | chars/4 | `(text: string) => number` |
| `language` | - | `chunkCode` only: comment-syntax hint (`'ts'`, `'python'`, `'sql'`, ...), echoed as `meta.language` |

Invalid options throw `RangeError`. Empty or whitespace-only input returns `[]`.

## Alternatives

- [llm-splitter](https://www.npmjs.com/package/llm-splitter) - offset-tracked chunks with a bring-your-own splitter function. chunklet adds the structural layer: markdown sections with heading breadcrumbs, atomic code fences, `Intl.Segmenter` sentence boundaries, and hierarchical fallback so chunks land on natural boundaries.
- LangChain / LlamaIndex text splitters - similar strategies inside much larger frameworks; reach for chunklet when you want the splitter without the framework.

## Roadmap

- HTML mode

## License

MIT (c) Muzaffar Qosimov
