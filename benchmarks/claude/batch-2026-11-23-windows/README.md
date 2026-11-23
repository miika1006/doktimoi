# Production task: file-tool controls, Claude Code, Windows

23 November 2026. Claude Code 2.1.326, `claude-opus-5-5`, medium effort, Windows 11,
Node 26.13.0. **Real-time antivirus scanning was off** (it was on for the 16 November
runs, so times do not compare across the two dates). The unchanged
[production-design task](../../task.md) on the 409 pinned Kubernetes v1.32 files.

This folder holds the two file-tool arms of a three-arm study (`--arm batch-study`),
each run in a fresh process, context and corpus copy:

- **Ordinary file tools**: Read, Grep and Glob with no workflow instruction.
- **Batched file tools**: the same tools plus one sentence: "Group independent searches
  into the same tool round, then group the necessary source reads. Follow up on gaps
  until you can support every answer."

The study's Doktimoi 0.14.7 runs were superseded by the
[0.14.8 rerun](../batch-doktimoi-0148-2026-11-23-windows/README.md) and removed; they are
in git history (`fff6967`). The rerun used the same sentence, task, corpus, model and
settings, but ran after these controls instead of rotating with them.

Means of three runs. Total tokens are provider input plus output with cached input
counted once; a model round is one model response, the final answer included.

| Arm | Total tokens | vs ordinary | vs batched files | Cost | Agent time | Model rounds | Tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary file tools | 1,408,986 | — | — | $0.98 | 131.5 s | 23.3 | 27.3 |
| Batched file tools | 953,057 | −32.4% | — | $0.89 | 128.7 s | 14.7 | 42.7 |
| [Batched Doktimoi 0.14.8](../batch-doktimoi-0148-2026-11-23-windows/README.md) | 376,985 | −73.2% | −60.4% | $0.61 | 87.5 s | 6.3 | 9.7 |

## What the numbers say

- **Batching alone saved a third of the tokens** but only 8.5% of the cost and no time.
  Its runs varied most: 523,641 to 1,417,625 tokens (ordinary: 1,148,105 to 1,719,605).
- **Cost falls much less than tokens.** Both file arms brought about 72,000 tokens of new
  context plus output per run; they differ in how often that context is re-sent, and
  re-sent context is read from the cache at a low price.

## Checks

All six runs passed the tool-use audit. Every answer has ten numbered sections and only
existing citation ranges ([check-answers.mjs](../../check-answers.mjs)); range existence
is not claim support. **All six answers exceed the requested 900–1400 words**
(1,515–1,876). The [qualifier screen](../qualifier-check.mjs) found the
`StatefulSetAutoDeletePVC` prerequisite in 1/3 batched and 0/3 ordinary answers; no
answer cites the grace-period countdown at `pod-v1.md:1008`. The other four screened
qualifications are in all six. The memos were not read claim by claim.

The ordinary arm tried Bash three times (`cd docs && …`, `sed -n`), which that arm does
not allow, and one Grep on a guessed path failed.

## Limits

Three runs per arm on one open-ended task; the two arms' ranges overlap. User-level rules
loaded equally in every arm and make the first request about 38,000 tokens. The machine
was also used for other work during the runs.
