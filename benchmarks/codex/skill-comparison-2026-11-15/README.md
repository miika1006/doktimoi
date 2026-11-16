# Local retrieval skills: Codex comparison, macOS

Codex `gpt-6.1-sol`, medium effort, Codex CLI 0.166.0, Node 26.13.0, macOS Apple M1, on the
unchanged [production-design task](../../task.md) and the 409 pinned Kubernetes v1.32 files.
Only the latest Codex runs are kept; earlier workflow iterations and failed competitor
attempts are in git history. [HANDOFF.md](HANDOFF.md) lists what remains to run.

| Arm | Runs | Total tokens | Agent time | Quality |
| --- | ---: | ---: | ---: | --- |
| `rg`/`sed` control ([pilot](phase2/quality-pilot/)) | 1 | 308,486 | 123.0 s | Omitted the feature-gate prerequisite |
| Doktimoi ([pilot](phase2/quality-pilot/)) | 1 | 258,332 | 104.8 s | Kept the prerequisite; one imprecise citation |
| [QMD 2.8.3 native skill](qmd/) | 3 | 368,229 | 114.5 s | Kept the required qualifiers in all three |

The Doktimoi pilot is a single pair with a different SKILL.md than today's
([frozen inputs](phase2/snapshot.json), [review](phase2/quality-pilot-review.md)); it is
not an equal-quality result. Three-pair Codex runs of 0.14.x are still needed. The QMD
arm used its own skill and BM25 CLI without embeddings ([adapter](configs/qmd.json),
[runtime](runtime.json)). The other macOS adapters in [configs/](configs/) are ready
for reruns; their first Codex runs failed setup or audit and were removed.

A [process-reuse probe](lexical-server-probe/results.json) measured lexical CLI medians of
365 ms in-process versus 53 ms through an already-running server, with byte-identical
output; this led to 0.14.1's lexical background server. [Caveman research](caveman-research.md)
explains why no terse writing style is applied. Latest macOS checks:
[tests with OCR and LibreOffice](tests-0140.log) and [20/20 retrieval](retrieval-0140.json)
for 0.14.0.

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
