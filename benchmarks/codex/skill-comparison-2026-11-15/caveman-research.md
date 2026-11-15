# Caveman research for Doktimoi (2026-11-15)

Inspected local clone `/tmp/doktimoi-competitors-20261115/caveman`, commit `b4ee71d557d96e3cbc14f88fa6e953a1362865f5`, root package version 4.1.0. No code executed, installed, or benchmarked. License Apache-2.0 for current repository; legacy MIT notices and third-party notices remain. See [LICENSING](https://github.com/JuliusBrussee/caveman/blob/b4ee71d557d96e3cbc14f88fa6e953a1362865f5/LICENSING.md).

## Actual current prompt

[skills/caveman/SKILL.md](https://github.com/JuliusBrussee/caveman/blob/b4ee71d557d96e3cbc14f88fa6e953a1362865f5/skills/caveman/SKILL.md) is clarity-first: answer first; omit ceremony; short normal words, no invented abbreviations; preserve negation, exceptions, exact numbers/units, commands, paths and errors. It explicitly says voice is not broken grammar, clarity beats compression, plain prose for persisted documents, and harness status requirements win. Full session persistence and a ~1,160-token instruction overhead (README estimate) make importing the whole skill an unattractive minimal Doktimoi change. No reason to adopt caricature grammar, 20-word hard sentence limits, or language switching.

## Evaluation evidence and limits

[evals/README.md](https://github.com/JuliusBrussee/caveman/blob/b4ee71d557d96e3cbc14f88fa6e953a1362865f5/evals/README.md) describes baseline, `Answer concisely.`, and concise+skill arms. Honest comparison is skill versus concise control. Committed [results.json](https://github.com/JuliusBrussee/caveman/blob/b4ee71d557d96e3cbc14f88fa6e953a1362865f5/evals/snapshots/results.json) contains ten developer prompts, one response per arm, claude-opus-5-5/CLI 2.1.288; it predates provider usage capture. Current rules differ from measured 3.1.0 rules. Reported caveman median output reduction versus concise is 3%, ultracave 35%, megacave 9%; counts use approximate o200k tokenizer. Single run per prompt, no powered significance test, no committed reviewed fidelity snapshot. This does NOT establish current total-token savings or citation preservation for Doktimoi.

[HONEST-NUMBERS.md](https://github.com/JuliusBrussee/caveman/blob/b4ee71d557d96e3cbc14f88fa6e953a1362865f5/docs/HONEST-NUMBERS.md) explicitly separates output-style skill (zero input compression) from runtime/proxy input compression. It warns prompt overhead and cache/context rereads can outweigh shorter replies. External numbers it cites were not independently validated here and should not be promoted as our verified evidence.

[WRAP-BENCHMARK.md](https://github.com/JuliusBrussee/caveman/blob/b4ee71d557d96e3cbc14f88fa6e953a1362865f5/docs/WRAP-BENCHMARK.md) reports 33.2% fewer provider input tokens, 18/18 exact-answer passes, six deterministic 60–95KB needle-in-noise fixtures, three repetitions. HTML regressed 9.9%. Crucially it says raw harness/run artifacts are NOT in this repository and cannot be independently reproduced from the checkout. Older engine, not current. These are published report claims, not reproducible local evidence. They concern raw noisy tool outputs, unlike already-selective Doktimoi passages.

## Fit to current Doktimoi

User constraint: requested artifacts such as `suunnitelma.md` must retain their
full requested detail, completeness and precision. Doktimoi must not impose
Caveman's voice or shorten those artifacts. The skill now explicitly separates
retrieval-output budgets from the requested document's length and detail.
Only redundant retrieval, duplicate headings and tool framing are candidates
for small reductions; source qualifications and artifact content remain intact.

Our `skills/doktimoi/SKILL.md` already batches independent questions, reads only missing evidence, avoids rereads, copies exact source paths, preserves prerequisites/defaults/negation/units/versions, and stops when every requested point has evidence. These target dominant repeated input cost more directly than terse final prose. Retain them.

`benchmarks/task.md` explicitly requires 900–1400 words, ten numbered questions, line citations for every answer, and distinctions among guarantees/configuration/prerequisites/unknowns. Terse output cannot be treated as improvement if it drops any of those. The runner's `totalTokens` is provider input + output, with cache reads/writes included through adapter accounting; `toolOutputTokensEstimate` is a different diagnostic, not billed usage or total cost.

Small compatible ideas: remove duplicated instruction prose only after checking all behavioral requirements; prefer one normal-language instruction over loading a full output persona; keep source evidence verbatim and shorten only CLI framing, exact duplicates and unnecessary reminders if measured. Never compress source passages into broken grammar or drop adjacent conditions merely to win a token table. A source-summary transform would need fidelity tests and recovery reads, which are beyond a small prompt change.

No final-answer brevity experiment will be added: it would target the wrong
part of this user's workflow. Any retrieval-only experiment must keep the task,
900–1400 words, corpus, model/effort, permissions and validation unchanged.
Report provider input, cache input, output, total tokens, calls, failures and
time separately; gate savings on supporting citations and all qualifications.

No Doktimoi files changed. No agent/model runs, OCR, installation, or heavy tests performed. Savings for Doktimoi remain unknown until a controlled quality-gated A/B.
