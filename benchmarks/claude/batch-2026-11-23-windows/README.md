# Production task: does batching explain the saving on Claude Code? (Windows)

23 November 2026. Claude Code 2.1.326, `claude-opus-5-5`, medium effort, Windows 11,
Node 26.13.0. **Real-time antivirus scanning was off** (it was on for the 16 November
runs, so times do not compare across the two dates). The unchanged
[production-design task](../../task.md) on the 409 pinned Kubernetes v1.32 files.

Three arms rotate their order over three rounds (`--arm batch-study`), each run in a
fresh process, context and corpus copy:

- **Ordinary file tools**: Read, Grep and Glob with no workflow instruction.
- **Batched file tools**: the same tools plus one sentence: "Group independent searches
  into the same tool round, then group the necessary source reads. Follow up on gaps
  until you can support every answer."
- **Batched Doktimoi**: the skill and its CLI with that same sentence.

Means of three runs. Total tokens are provider input plus output with cached input
counted once; a model round is one model response, the final answer included.

| Arm | Total tokens | vs ordinary | vs batched files | Cost | Agent time | Model rounds | Tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary file tools | 1,408,986 | — | — | $0.98 | 131.5 s | 23.3 | 27.3 |
| Batched file tools | 953,057 | −32.4% | — | $0.89 | 128.7 s | 14.7 | 42.7 |
| Batched Doktimoi 0.14.7 | 451,845 | −67.9% | −52.6% | $0.76 | 93.6 s | 7.7 | 10.7 |
| [Batched Doktimoi 0.14.8](../batch-doktimoi-0148-2026-11-23-windows/README.md) | 376,985 | −73.2% | −60.4% | $0.61 | 87.5 s | 6.3 | 9.7 |

Building the index took 10.1 s per Doktimoi run and is not in agent time.

## What the numbers say

- **Batching alone saved a third of the tokens** but only 8.5% of the cost and no time.
  Its runs varied most: 523,641 to 1,417,625 tokens.
- **Doktimoi halved the batched control's tokens**, with the narrowest spread
  (401,971–485,171 for 0.14.7).
- **Cost falls much less than tokens.** New context plus output was the same in all
  three arms of this folder (about 72,000 tokens per run); the arms differ in how often
  that context is re-sent, and re-sent context is read from the cache at a low price.
  Doktimoi 0.14.7 cost 22% less than ordinary file tools and 15% less than batched ones.
- The 0.14.8 rows are a later, unpaired rerun of the Doktimoi arm only; see its folder.

## Checks

All nine runs passed the tool-use audit. Every answer has ten numbered sections and
only existing citation ranges ([check-answers.mjs](../../check-answers.mjs)); range
existence is not claim support. **All nine answers exceed the requested 900–1400 words**
(1,515–1,876). The [qualifier screen](../qualifier-check.mjs) found the
`StatefulSetAutoDeletePVC` prerequisite in 3/3 Doktimoi answers, 1/3 batched and 0/3
ordinary answers; no answer in any arm cites the grace-period countdown at
`pod-v1.md:1008`. The other four screened qualifications are in all nine. The memos were
not read claim by claim.

## Trace findings

- **Every Doktimoi 0.14.7 run lost its first search round.** Claude put the long skill
  and corpus paths in shell variables (`S="…"; F="…"; node "$S" batch "$F" …`), Claude
  Code refused ("A variable set in this command can't be checked before it runs") and
  the agent repeated the same searches literally: seven refused calls in three runs,
  about 40,000 tokens each run. The skill here was read from a 135-character path;
  the 16 November runs used a short path and showed none. 0.14.8 names variables in the
  skill's single-command rule.
- The ordinary arm tried Bash three times (`cd docs && …`, `sed -n`), which that arm does
  not allow, and one Grep on a guessed path failed.
- Thirteen of 25 Doktimoi batch calls carried the partial-term label on at least one
  question: Claude writes queries of four to eleven terms where the skill asks for two
  or three. The labelled fallback still returned usable passages.
- Agents guessed three linked pages that the pinned subset lacks; the batch widened
  those questions to all sources with a label and no round was lost.

## Limits

Three runs per arm on one open-ended task; the ranges above overlap between the two file
arms. User-level rules load equally in every arm and make the first request about 38,000
tokens. The machine was also used for other work during the runs.
