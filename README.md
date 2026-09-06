# chunklet

[![npm version](https://img.shields.io/npm/v/chunklet)](https://www.npmjs.com/package/chunklet)
[![CI](https://github.com/qwertymuzaffar/chunklet/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertymuzaffar/chunklet/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Token-aware, structure-aware text chunking for RAG pipelines - **zero dependencies**, runs in Node, browsers, and edge runtimes.

Two ideas define it. **Exact source offsets**: every chunk guarantees

```ts
chunk.text === source.slice(chunk.start, chunk.end)
```

so you can highlight citations, deep-link retrieval hits, or store embeddings without storing text. And **structure awareness**: chunks respect the document - markdown sections with heading breadcrumbs, whole sentences, atomic code fences - and a word is never cut in half unless a single word exceeds the budget.

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
  meta?: { headings?: string[] }; // markdown mode
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
| `estimateTokens(text)` | The default chars/4 heuristic |

### Options

| Option | Default | Description |
|---|---|---|
| `maxTokens` | `512` | Token budget per chunk |
| `overlap` | `0` | Tokens of trailing context repeated at the start of the next chunk (must be < `maxTokens`) |
| `tokenizer` | chars/4 | `(text: string) => number` |

Invalid options throw `RangeError`. Empty or whitespace-only input returns `[]`.

## Alternatives

- [llm-splitter](https://www.npmjs.com/package/llm-splitter) - offset-tracked chunks with a bring-your-own splitter function. chunklet adds the structural layer: markdown sections with heading breadcrumbs, atomic code fences, `Intl.Segmenter` sentence boundaries, and hierarchical fallback so chunks land on natural boundaries.
- LangChain / LlamaIndex text splitters - similar strategies inside much larger frameworks; reach for chunklet when you want the splitter without the framework.

## Roadmap

- `chunkCode` - blank-line and indentation-aware splitting for source files
- HTML mode

## License

MIT (c) Muzaffar Qosimov
