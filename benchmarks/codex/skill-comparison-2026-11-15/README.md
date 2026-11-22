# Local retrieval skills: Codex comparison, macOS

Codex `gpt-6.1-sol`, medium effort, Codex CLI 0.166.0, Node 26.13.0, macOS Apple M1, on the
unchanged [production-design task](../../task.md) and the 409 pinned Kubernetes v1.32 files.
The [22 November M1 study](../mac-2026-11-22/README.md) supersedes the one-pair Doktimoi pilot. It compares ordinary and explicitly batched file tools with Doktimoi across both Kubernetes tasks and a Finnish Office/image task. [HANDOFF.md](HANDOFF.md) lists the remaining Windows work.

The [QMD 2.8.3 native skill](qmd/) used its BM25 CLI and averaged 368,229 total tokens and 114.5 s across three production-design reviews. All three kept the required qualifiers in the review. See its [adapter](configs/qmd.json) and [runtime](runtime.json). The model and pinned documents match the later study, but the competitor prompt and study date differ.

A [process-reuse probe](lexical-server-probe/results.json) measured lexical CLI medians of
365 ms in-process versus 53 ms through an already-running server, with byte-identical
output; this led to 0.14.1's lexical background server. [Caveman research](caveman-research.md)
explains why no terse writing style is applied. The current [test log](../mac-2026-11-22/tests.log) includes OCR and LibreOffice; the [lexical lookup results](../mac-2026-11-22/retrieval-current.json) include the original-source roundtrip checks.

## Pinned competitors

| Skill | Pinned source |
| --- | --- |
| QMD | [tobi/qmd at facd35e](https://github.com/tobi/qmd/tree/facd35e01359e59d938bc9418e93fb9318addee3) |
| QMD Search | [glebis/claude-skills at 4d37d3b](https://github.com/glebis/claude-skills/tree/4d37d3b0af1f98cb4ac820d9abbce95e38e909fb/qmd-search) |
| library-docs | [um1b/library-docs at 4fade60](https://github.com/um1b/library-docs/tree/4fade60d18fcfd8dd166cdd4936a6b6005256292) |
| doc-search | [r04943083/doc-search-skill at 92c601a](https://github.com/r04943083/doc-search-skill/tree/92c601ac408923b0a3a47720df616ded9ac0946f) |
| fidx | [williamliu-ai/fidx at 1299e30](https://github.com/williamliu-ai/fidx/tree/1299e30dab7d925c905606cd7db329c29a431ab4) (MIT AND AI Idea Attribution Addendum v1.0) |
| GBrain | [garrytan/gbrain at aab958d](https://github.com/garrytan/gbrain/tree/aab958d1a0f8cd0e2cb0cdd98e90308f4c6d18fc) |
| Meme | [qntx/meme at 1098381](https://github.com/qntx/meme/tree/10983816e0f24781d4ed562331ff48e136d03a4c) |

No competitor source code was copied into Doktimoi. These runs must not be pooled with
Claude Code results or other models.
