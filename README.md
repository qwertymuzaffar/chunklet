# chunklet

[![npm version](https://img.shields.io/npm/v/chunklet)](https://www.npmjs.com/package/chunklet)
[![CI](https://github.com/qwertymuzaffar/chunklet/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertymuzaffar/chunklet/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Token-aware, structure-aware text chunking for RAG pipelines - **zero dependencies**, runs in Node, browsers, and edge runtimes.

The differentiator: **exact source offsets**. Every chunk guarantees

```ts
chunk.text === source.slice(chunk.start, chunk.end)
```

so you can highlight citations, deep-link retrieval hits, or map an answer back to the original document - things you cannot do when your splitter normalizes whitespace behind your back.

## Install

```bash
npm i chunklet
```

## Quick start

```ts
import { chunkText } from 'chunklet';

const chunks = chunkText(document, { maxTokens: 512, overlap: 64 });
// [{ text, start, end, tokens, index }, ...]
```

Splitting is hierarchical: paragraphs first, then lines, sentences, and words - the text is only cut as finely as the budget requires, and pieces are packed back up to `maxTokens` with optional token overlap between consecutive chunks.

## Sentence mode

```ts
import { chunkSentences } from 'chunklet';

const chunks = chunkSentences(article, { maxTokens: 256 });
// chunks never end mid-sentence (unless a single sentence exceeds the budget)
```

Uses `Intl.Segmenter` for real sentence boundaries (handles "Mr. Smith" correctly) with a regex fallback for older runtimes.

## Markdown mode

```ts
import { chunkMarkdown } from 'chunklet';

const chunks = chunkMarkdown(readme, { maxTokens: 512 });
chunks[4].meta?.headings; // ['Guide', 'Install'] - breadcrumb of ATX headings
```

- Sections follow the heading structure; every chunk carries its **heading breadcrumb** - prepend it when embedding for noticeably better retrieval.
- Fenced code blocks stay **atomic** (never merged mid-fence with prose; only split internally when a fence alone exceeds the budget).

## Real token counts

The default tokenizer is a fast chars/4 heuristic. For exact counts, plug in any counter:

```ts
import { encodingForModel } from 'js-tiktoken';

const enc = encodingForModel('gpt-4o');
chunkText(doc, { maxTokens: 512, tokenizer: (t) => enc.encode(t).length });
```

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
| `overlap` | `0` | Tokens of trailing context repeated at the start of the next chunk |
| `tokenizer` | chars/4 | `(text: string) => number` |

### Chunk

| Field | Description |
|---|---|
| `text` | Exactly `source.slice(start, end)` |
| `start` / `end` | Character offsets into the source (half-open) |
| `tokens` | Token count per the active tokenizer |
| `index` | 0-based position |
| `meta.headings` | Markdown heading breadcrumb (markdown mode) |

## Roadmap

- `chunkCode` - blank-line and indentation-aware splitting for source files
- HTML mode

## License

MIT (c) Muzaffar Qosimov
