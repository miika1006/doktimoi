# Does batching explain the saving on Codex?

Apple M1, Darwin arm64, Node 26.13.0, npm 12.2.2, Codex CLI 0.166.0, `gpt-6.1-sol`, medium effort. The agent tasks used public Kubernetes v1.32 documents or an original synthetic Finnish archive. No user documents were used.

## Study design

Each three-run block rotates the order of ordinary local tools, the same tools with a batching instruction, and Doktimoi with that same instruction. Every agent gets a fresh workspace and context. Baselines have the same file, shell and visual inspection capabilities. Only the Doktimoi arm gets the installed skill and a Doktimoi index. The instruction asks to group independent searches and subsequent reads and to resolve evidence gaps. It contains no queries, answers, source hints or word-budget changes. Hybrid follow-ups use the same batching instruction, model, task and source hashes. They run after index preparation.

Provider total tokens equal input plus output. Cached input is included once. A model round is one completed response with reconciled per-response usage, including the final answer. The runner drops the CLI's two-token prewarm only if that makes all input, cached input and output sums match the turn event. It records the numeric per-response counts in each `*.rounds.json`. A shell command can contain several searches, and a single round can launch multiple commands. The lexical GBrain and Meme runs predate the per-response logging and have command counts only. See the [Codex event documentation](https://developers.openai.com/codex/config-advanced/#observability-and-telemetry).

The tasks were run concurrently with local indexing and other study processes. Elapsed times describe this session. They include writing the answer and exclude one-time setup. Three repetitions describe these tasks on this machine. Shared cloud caching and model variation affect the estimates.

## File batching and lexical search

Each cell is the three-run mean of total provider tokens / model rounds / agent seconds. Agent time excludes per-run index construction (production 27.3 s, held-out 29.3 s, Finnish shipment 10.5 s, receipt comparison 7.2 s). All rows include three valid runs per arm. See the [per-arm means](means.json) and [source review](quality.md).

| Task | Ordinary file tools | Batched file tools | Batched Doktimoi |
| --- | ---: | ---: | ---: |
| Production review | 353,923 / 11.7 / 105.6 | 274,694 / 8.0 / 98.6 | 238,710 / 7.7 / 120.2 |
| Held-out platform | 313,040 / 11.0 / 112.3 | 247,890 / 7.7 / 91.3 | 234,650 / 7.7 / 115.0 |
| Finnish decision | 126,907 / 5.0 / 34.7 | 111,329 / 4.7 / 31.0 | 139,467 / 7.7 / 60.5 |

Batching file tools cut total tokens by 22.4%, 20.8% and 12.3% respectively. Compared with those batched controls, lexical Doktimoi used 13.1% fewer tokens on production, 5.3% fewer on the held-out task and 25.3% more on the Finnish task. On the two Kubernetes tasks the batched control captured 69% and 83% of the ordinary-to-Doktimoi token reduction, calculated from the arm means. The comparisons measure the effect of the workflow instruction, which can also affect tool output and subsequent reasoning. The held-out arms used the same number of rounds (23 each across three runs). Smaller per-round context contributed there. On the Finnish task the indexed arm averaged 18,191 tokens per model response versus 23,856 for batched files, but took nine additional rounds across three runs. The file controls were faster than Doktimoi on all three tasks. The [answer review](quality.md) covers accuracy and source checks. The [final test run](tests.log) had 153 passes, four platform skips and zero failures with OCR and LibreOffice enabled (`node --test --test-concurrency=1`).

These totals include repeated cached context. If counting only uncached input plus output, the batched/lexical Doktimoi means were 55,686/55,670 for production, 41,127/46,874 for held-out and 31,030/16,587 for Finnish. The last comparison reverses on that metric. The CLI did not report dollar costs. Answers varied between repetitions, with overlapping per-run token ranges.

The [English receipt comparison](../../finnish-dispatch/receipts.en.md) uses the same Finnish sources and starts without a name, identifier, date or branch. The requested maximum spans three images. Ordinary files averaged 88,252 tokens / 4.3 rounds / 32.4 s but produced only 1/3 exact answers. Batched files used 105,266 / 4.7 / 34.3 with 3/3 exact. Batched Doktimoi lexical used 151,115 / 7.0 / 51.8 with 3/3 exact. Hybrid used 156,281 / 7.7 / 56.9 with 3/3 exact. Two ordinary agents chose seven packages and EUR 78. The correct receipt records nine packages and a capped EUR 120 fee. Every field then referred to the wrong transfer. All four arms cited all three images for their comparison. See the [lexical/control scores](receipts-lexical-scores.jsonl) and [hybrid scores](receipts-hybrid-scores.jsonl).

The latest full blocks provide 48 completed, audited Doktimoi/control runs and nine completed competitor runs. The Kubernetes and original Finnish lexical agent trials used 0.14.4, as did the Kubernetes hybrid trials. The final Finnish hybrid and receipt-first blocks used 0.14.6 and 0.14.7 respectively. The later changes addressed explicit embedding duration, oversized exact-search limits and skill instructions. No ranking parameters changed between those versions. The [setup logs](backends/), implementation snapshots, raw events and per-answer round counts accompany each study. The shared prepared database costs are additional to the per-run setup times in the means.

## Kubernetes hybrid and competitor results

The same batched Doktimoi workflow with CPU hybrid search used 341,453 tokens, 11.0 model rounds and 174.2 s on production, and 307,652 tokens, 10.3 rounds and 158.2 s on the held-out task. That was 24.3% and 24.1% more tokens than batched file tools. All six runs passed the hybrid audit. Each performed 5–8 successful hybrid commands. Building the shared Kubernetes embeddings took 27.2 minutes under load and produced 7,860 vectors. The 409-file lexical build took 11.8 s in that separate preparation.

The [lexical passage check](retrieval-current.json) returned 20/20 expected passages; [hybrid](retrieval-current-hybrid.json) returned 18/20 and the validator exited nonzero. Hybrid missed the additive NetworkPolicy rule and the right to access a Secret by creating a Pod. Lexical ranked those exact passages sixth and seventh in a repeat of the same queries. The separate literal search still found the expected original lines in both modes. This distinguishes a ranking miss from a missing source. On direct queries containing precise Kubernetes terminology, lexical retrieval was the more reliable default in this set.

The three lexical GBrain runs averaged 563,374 tokens and 150.2 s. Three native lexical Meme runs averaged 499,236 tokens and 120.5 s. GBrain took 45.1 s and Meme 1.3 s per workspace to set up. The earlier [native QMD arm](../skill-comparison-2026-11-15/README.md) averaged 368,229 tokens and 114.5 s. These competitor arms used their native skill instructions and their own retrieval CLIs; they do not isolate the effect of the batching instruction.

Native Meme hybrid averaged 564,064 tokens, 13.3 rounds and 129.2 s. The full [embedding build](backends/meme-full-embed.log) took 30 min 49 s for 4,222 chunks in 409 documents. The three runs each passed a native vector query audit. On fidx the resumed native build embedded 5,215 more chunks in 3,519.6 s, on top of 1,024 retained chunks. The prepared snapshot contains 6,239 chunks and all 409 documents. Its [preflight](fidx-hybrid/1-competitor.preflight.json) confirmed hybrid retrieval. The provider stopped the first agent before its answer or final usage event. fidx has no task-level time, tokens or accuracy result in the comparison. See the [remaining work](TODO.md).

## Source checks

The [Finnish task and key](../../finnish-dispatch/README.md) require nine exact decisions and supporting files. The archive has 441 documents, including Word, Excel and image-only evidence. A distinctive shipment name and known branch/date help ordinary file tools find the right ledger. An agent can read all six small Office documents in one shell call. This is an intentionally capable control.

For the open-ended Kubernetes memos we check output length, coverage, cited line ranges and decision-relevant qualifications against the [production rubric](../quality-review.md). A valid path and range can still point to the wrong claim. Neither a passing structural check nor the 20-query retrieval check establishes a fully correct memo.

### Bilingual passage retrieval

With four frozen questions asked in each language, [lexical](finnish-lookups-lexical.json) found the correct source and passage in 4/8 top-four lists. It found the ledger and the receipt in both languages. [Hybrid](finnish-lookups-hybrid.json) scored 2/8. It placed the Finnish receipt-ID lookup and the English paraphrase of the permission rule first. Neither mode retrieved the applicable fee passage in either language. Half the prompts contain a known identifier. This is passage retrieval before an agent can translate, inspect receipts, join on a seal or refine its searches.

The initial embedding session stopped at 30 minutes with 4,279 complete vectors left in the database. The resumed [explicit build](finnish-embed.log) processed the remaining 269 documents in 29.9 minutes, adding 6,533 vectors with zero errors. The finished database contained 10,812 vectors for 444 indexed passages in 441 files. In these plain-text ledgers, the Markdown parser preserves an uninterrupted ledger as one long paragraph; the embedding backend splits it internally. Returning a short answer-bearing excerpt is part of the score.

In the original Finnish shipment task all three hybrid answers also matched the nine exact values and required sources. Hybrid averaged 131,374 tokens, 7.0 rounds and 63.4 s versus 111,329 tokens, 4.7 rounds and 31.0 s for batched file tools. The hybrid mean was 18.0% higher than the batched control, and 5.8% lower than lexical Doktimoi.

## Issues found in traces

- In two of the three original Finnish Doktimoi runs, the agent had the correct workbooks and passed their bare filenames to a multi-read. Each request yielded three errors and another search for the effective-date sheet. Version 0.14.4 returns the first cited passage and identifies the next one. The trace also exposed a 152-line reference for a short extract around one ledger entry. A uniquely located source-text excerpt now cites the lines actually shown. Converted sheet/page references remain readable by their original locations.
- One production agent followed a Kubernetes link to a lifecycle page absent from the pinned subset, then recovered with the Pod API reference. Baselines also guessed paths absent from the subset. A missing path or a search miss cannot establish the absence of the underlying behavior.
- GBrain initially rejected the symlinked macOS temporary path. Its successful runs used the real path. The runner now resolves the temporary parent before creating a workspace. GBrain imported 406 files. Three contributor guides had frontmatter slugs that conflicted with their paths; the native importer skipped them. The logs also report a per-page code-fence cap.
- The answer checker missed valid reference-style Markdown citations and could concatenate a link label with its destination. It now resolves named links and continues checking the other memos after a failed check.
- Doktimoi and Meme both created a tiny embedding index outside the Codex sandbox, but the packaged Metal path failed at query time inside it. Doktimoi's CPU-only native build passed the same sandbox preflight. Setup, inference backend and agent scores are reported separately. See the [backend evidence](backends/).

A later trace audit mistakenly treated `rg --files … | head -70` as a document content read. The trace showed output paths only. The corrected audit accepts a bounded filename listing and rejects file arguments to `head`, content search and chained commands. The stopped attempt is in `8bcc8a0`.

The original receipt-first trial is in `81e1922`. All three indexed searches initially rejected positive limits above 20 in exact mode, losing a full batch. Exact scans already cap the displayed matching lines by tokens and bytes. Version 0.14.6 applies the 20-hit limit to ranked results and describes it in the skill. The same large exact request now returns the same bounded lines as the default.

The pre-fix three-arm evidence is retained in Git commit `dbc3869`. The frozen 0.14.4 lexical runner and skill are in `9a2f1ad`. The later corpus copy also verifies the bytes for every individual workspace. Skill, runner, task and corpus hashes are recorded in the run summaries.

## Reproduce

Use the repository root and a new output directory per command. Install the pinned dependencies with `npm ci --prefix skills/doktimoi`. The frozen [Finnish corpus instructions](../../finnish-dispatch/README.md) include extraction and scoring commands. Substitute the extracted root containing `docs/` and `sources.json` for `$DISPATCH`.

```sh
node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm batch-study --pairs 3 --output benchmarks/codex/NEW_PRODUCTION
node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm batch-study --pairs 3 --task benchmarks/heldout-task.md --output benchmarks/codex/NEW_HELDOUT
node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm batch-study --pairs 3 --task benchmarks/finnish-dispatch/task.fi.md --corpus "$DISPATCH" --output benchmarks/codex/NEW_FINNISH
node benchmarks/check-answers.mjs benchmarks/codex/NEW_PRODUCTION benchmarks/codex/NEW_HELDOUT
node benchmarks/finnish-dispatch/check.mjs benchmarks/codex/NEW_FINNISH
```

With consent to use the pinned embedding model, copy the Kubernetes sources to a temporary folder and prepare that copy. Create a lexical index first, then add local embeddings. The following commands use the CPU build described in [the backend notes](backends/README.md). Point `QMD_EMBED_MODEL` at the verified local GGUF file.

```sh
export QMD_FORCE_CPU=1
node skills/doktimoi/scripts/doktimoi.mjs build "$KUBE_COPY"
node skills/doktimoi/scripts/doktimoi.mjs build "$DISPATCH/docs"
node skills/doktimoi/scripts/doktimoi.mjs embed "$KUBE_COPY"
node skills/doktimoi/scripts/doktimoi.mjs embed "$DISPATCH/docs"
node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm batch-doktimoi --pairs 3 --retrieval hybrid --prepared "$KUBE_COPY" --output benchmarks/codex/NEW_PRODUCTION_HYBRID
node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm batch-doktimoi --pairs 3 --retrieval hybrid --prepared "$KUBE_COPY" --task benchmarks/heldout-task.md --output benchmarks/codex/NEW_HELDOUT_HYBRID
node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm batch-doktimoi --pairs 3 --retrieval hybrid --prepared "$DISPATCH/docs" --corpus "$DISPATCH" --task benchmarks/finnish-dispatch/task.fi.md --output benchmarks/codex/NEW_FINNISH_HYBRID
node benchmarks/validate-retrieval.mjs --mode hybrid --prepared "$KUBE_COPY"
node benchmarks/finnish-dispatch/lookup.mjs "$DISPATCH/docs" hybrid
```

Competitor [adapters](configs/) pin the upstream tree and model hashes. Set their executable, checkout, model and SQLite paths for the local machine. Run `node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm competitor --competitor CONFIG --pairs 3 --output NEW_DIR`, adding `--retrieval hybrid` for an embedded index. To reproduce the receipt-first comparison, substitute `benchmarks/finnish-dispatch/receipts.en.md` for the Finnish task and add `--receipts` to the score command.

For prepared competitors, use the ordinary hybrid adapter's setup commands on the pinned sources once, finish native embedding, and take a SQLite backup. Hash the backup and include it among the prepared adapter's artifacts. The runner copies it into each workspace. Meme registers the local collection before copying the database. fidx registers the workspace collection after copying it. The runner checks file hashes, executes native query preflights and audits real agent retrieval. Keep index creation, per-workspace copies, query time and answer generation distinct.
