# Intermediate optimization: retained diagnostic run

This pair tested larger passages, splitting large Markdown lists only between
complete list items, per-question inline batches, and shorter skill instructions.
It is not included in the final comparison.

The baseline consumed 256,356 model tokens; Doktimoi consumed 336,758. Doktimoi
made ten retrieval commands and one skill-file read, with no retrieval errors.
The baseline made nine commands. Thus removing retries alone did not solve
the token overhead.

The baseline's recorded 5,677.469 seconds includes host sleep. macOS `pmset`
confirmed sleep during the run and wake at 09:19:23 EET; the CLI logged a
connection retry. This time is unsuitable for a speed comparison. The runner
now keeps macOS awake with `caffeinate -i` for its own lifetime. Explicit sleep
or closing the lid can still invalidate a run.

The first tool-use checker mistakenly classified reading the skill's own
`SKILL.md` as a content-tool violation and stopped after this pair. The original
summary is preserved; [corrected-tool-audit.json](corrected-tool-audit.json)
shows the corrected classification. No source document was read with a bypass
tool.

The trace also exposed a real retrieval bug: a filename repeated in every
chunk's weighted title could promote a chunk containing only `---`. The final
implementation removes that synthetic filename signal. A regression test now
requires actual source evidence to outrank filename-only matches. The final
benchmark also loads SKILL.md once from disk instead of injecting it and then
potentially reading it again. [implementation.patch](implementation.patch)
records this intermediate retrieval implementation relative to repository
commit `e9a805514aaabeba269486d6cd5df4a308091ffd`.
