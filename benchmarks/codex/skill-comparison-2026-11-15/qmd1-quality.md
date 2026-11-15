# QMD competitor 1 manual quality review

Reviewed `benchmarks/codex/skill-comparison-2026-11-15/qmd/1-competitor.answer.md`, actual completed tool outputs in its events JSONL, and pinned original sources using the same existing `benchmarks/codex/quality-review.md` rubric. Same unblinded reviewer as before/after. No code or evidence changed.

## Findings

All10 main topics covered; no contradictory core mechanism or missing rubric qualification identified. The memo preserves both historically fragile qualifications: explicit restart-policy behavior, not-yet-ready HPA Pods'0% upscale assumption, and the StatefulSet feature prerequisite. The last is phrased “Verify the documented feature prerequisites” with a direct citation to conceptual statefulset391–423, which contains the named gate on API server/controller manager at392–394. This matches the standard applied to before memos that say to check documented feature-gate prerequisites without spelling out the gate name.

Citation quality is generally direct: PDB/rollout passages distinguish failure/drain/rolling cases; topology includes eligibility and failure limitations; probe/lifecycle passages support gating and restart-policy statements; API1006–1008 includes explicit countdown-before-preStop; HPA129–218 covers100%/0%, not-ready0%, highest recommendation/five minutes; multi-tenancy208–220 directly supports the DNS exception. Secrets35–48/305–307 supports default unencrypted etcd, workload creation exposure and reversible base64. StorageClass inheritance/existing-PV changes remains the documented inference described in the shared rubric, not proof every proposed StorageClass edit is API-valid.

The sentence “an overrunning hook receives” the two-second extension is slightly stronger than the source's kubelet-requests-an-extension wording, but no material contradictory mechanism was identified. The memo correctly avoids treating this as a request-completion guarantee. It says “Deleted and failed Pods are excluded” where original HPA lines153–155 specifically mean Pods bearing a deletion timestamp (terminating), a compressed wording rather than a claim that only fully deleted Pods are excluded.

## Mechanical validation

1114 whitespace words, all10 numbered sections,28 named ranges checked against original source lengths; all exist and are ordered validly. The existing checker does not yet recognize this memo's valid prose citation format `` `docs/path.md`, L99–145 `` and repeated `L` before comma-separated ranges. I used an independent small read-only parser for that format and did not alter the checker. Thus a standard-checker failure here would be a format-support issue, not absence of citations. No unsupported file/path citation found.

## Captured retrieval behavior

13 completed command-execution items, including one skill read; all have final shell exit0. There are50 separate QMD CLI invocations across the other12 shell commands, grouped with semicolons. Command count alone substantially understates the retrieval work compared with one Doktimoi batch process.

Initial searches use file-level QMD snippets, followed by many line-numbered `qmd get` reads. Some initial searches produce adjacent-topic distractors: JSONL16/item7 starts with assign-pod-level-resources for CPU requests and later searches retention. But subsequent gets recover the required evidence.

The StatefulSet prerequisite is visibly retrieved, not inferred from the final memo: JSONL16 search output contains `StatefulSetAutoDeletePVC`; JSONL18/item8 explicitly gets conceptual `statefulset.md:390:100`, returning the prerequisite-bearing passage. The API countdown is retrieved at JSONL24/item11 (`pod-v1.md:1000:18`). That same command and additional gets retrieve final supporting probe/topology details. JSONL31/item15 gets Secret300:16, including the direct base64-not-secret caution at306, and topology205:20.

Completed command outputs total134378 characters, with one large31974-character result at JSONL13/item5 containing four gets. No actual missing-source, empty-search or output-cap/truncation notice identified in completed outputs. Some ordinary source content includes the word “error,” so keyword-only error counting would be misleading. Because many shell commands chain multiple processes with semicolons, exit0 proves the final process succeeded, not every preceding process; the inspected output does not reveal an earlier concrete QMD failure.

QMD1 therefore passes this manual rubric with the wording caveats above. This is one unblinded within-task review, not general accuracy or an equal-quality efficiency guarantee. Library-docs' empty-index/nonexistent-rg adapter failure is a setup failure excluded from this review; no library-docs memo was scored.
