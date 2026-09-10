# chunklet

## 0.2.0

### Minor Changes

- ca85fb5: Add `chunkCode`, declaration-aware chunking for source files. Top-level declarations are the unit: a doc comment stays with its function, a declaration that fits is never split, small ones are packed together, and an oversized one starts its own chunks and is cut at blank lines before its least-indented members first, then after closing brackets and at dedents, then at line breaks. Chunks inside one declaration carry its first line as `meta.symbol`; the `language` option only decides which lines are comments and is echoed as `meta.language`.
- 4e66cab: Add `chunkHtml`: readable text is extracted from HTML with a small tolerant tag scanner (block elements become boundaries, whitespace collapses like a browser, `<pre>` and standalone `<code>` blocks stay atomic, `<script>`/`<style>`/comments are dropped, entities are decoded) and chunked with heading breadcrumbs like markdown mode. Returns `{ text, chunks }`: offsets refer to the extracted text and `meta.source` maps each chunk back to its range in the original HTML.

## 0.1.1

### Patch Changes

- 87e5341: Expanded README with mode explanations, overlap semantics, and RAG recipes (ingestion with breadcrumbs, citation highlighting, real token counts). Releases are now automated with Changesets and published from GitHub Actions with provenance.
