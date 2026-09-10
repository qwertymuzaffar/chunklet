---
'chunklet': minor
---

Add `chunkHtml`: readable text is extracted from HTML with a small tolerant tag scanner (block elements become boundaries, whitespace collapses like a browser, `<pre>` and standalone `<code>` blocks stay atomic, `<script>`/`<style>`/comments are dropped, entities are decoded) and chunked with heading breadcrumbs like markdown mode. Returns `{ text, chunks }`: offsets refer to the extracted text and `meta.source` maps each chunk back to its range in the original HTML.
