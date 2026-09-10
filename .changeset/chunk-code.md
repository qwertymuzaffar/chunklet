---
'chunklet': minor
---

Add `chunkCode`, declaration-aware chunking for source files. Top-level declarations are the unit: a doc comment stays with its function, a declaration that fits is never split, small ones are packed together, and an oversized one starts its own chunks and is cut at blank lines before its least-indented members first, then after closing brackets and at dedents, then at line breaks. Chunks inside one declaration carry its first line as `meta.symbol`; the `language` option only decides which lines are comments and is echoed as `meta.language`.
