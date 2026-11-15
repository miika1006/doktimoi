# Quality pilot manual review

Reviewed both memos in [quality-pilot/](quality-pilot/) against the original ten-topic criteria and pinned source ranges in [the existing rubric](../../quality-review.md). Same unblinded reviewer as the prior before/after/QMD reviews; neither baseline nor treatment is treated as an answer key. No raw run or implementation changed, and no additional benchmark was launched.

Both memos cover all ten main topics and contain no identified contradictory core mechanism. The treatment now preserves the StatefulSet prerequisite that all three preceding after treatments omitted. This supports the narrow proposed workflow repair, but one pilot does not establish general quality equivalence or reliable savings.

## Important findings

- **Treatment prerequisite recovered:** section 9 explicitly says to verify the documented `StatefulSetAutoDeletePVC` feature-gate prerequisite and cites conceptual `statefulset.md:387–422`. Original lines392–394 require this gate on API server and controller manager. The prerequisite was actually retrieved in completed tool output at JSONL10. This meets the same standard used for earlier memos that cite the full prerequisite-bearing paragraph without repeating every component name.
- **Baseline prerequisite omitted:** section9 describes optional StatefulSet PVC-deletion policies and cites conceptual391–423 but does not mention a prerequisite. Its trace retrieved `StatefulSetAutoDeletePVC` at JSONL18. This is a writing omission of available evidence, unlike the preceding after treatments' retrieval gap. Under the same existing strict rubric it is a qualification failure; no opposite assertion is made.
- **Treatment countdown citation is imprecise:** section4 cites API `pod-v1.md:1002–1006`, ending at the preStop heading. The explicit countdown-before-hook statement is line1008, outside this range. Its additional lifecycle584–645 supports shutdown order, grace expiry and the shared-budget interaction indirectly. The claim is correct, but the precise API citation misses the supporting sentence, repeating before Doktimoi1's citation defect. The treatment actually retrieved the explicit countdown in JSONL9, so the final range could have been correct without another lookup. Baseline cites1006–1008 correctly.

The treatment also uses compressed “restart handling” wording without explicitly repeating “subject to restart policy,” but this matches the probe guide's restart description and the specified Deployment context. As in prior reviews, this is noted rather than called a new contradiction. Baseline explicitly preserves restart-policy wording.

## All-ten-topic check

| Topic | Baseline | Treatment |
| --- | --- | --- |
|1 PDB/rollout|Failure/drain/rollout distinction, Eviction API prerequisite, six-minus-two=four, compatible rollout and capacity/failure limits retained.|Same main mechanisms and limits retained.|
|2 Zone spread|Selector/key/skew/global minimum/hard-soft/minDomains/eligibility and removal limitations retained.|Same mechanisms; explicitly distinguishes failed-zone eligibility, default minDomains1 and configured3.|
|3 Probes|Startup gating, readiness withdrawal without restart, restart-policy behavior and measured startup budget retained.|Same main mechanisms; restart-policy wording compressed as noted.|
|4 Shutdown|Clock includes hook; hook before TERM; KILL/extension; concurrent ready=false; no completion guarantee.|Same mechanisms, with off-by-two-ending API citation defect noted above.|
|5 Resources/HPA requests|Requests versus ceilings, throttling versus reactive OOM, missing requests and effective defaults retained.|Same distinctions and defaults retained.|
|6 HPA adjustments|Missing100% downscale/0% upscale; not-ready0%; conservative recomputation; highest/five-minute stabilization retained.|Same; “target utilization” means100% of target rather than100% CPU usage.|
|7 Networking|Directional isolation, additive union, both ends/replies, DNS and enforcing plugin retained.|Same; DNS UDP/TCP53 supported by actual resolver example.|
|8 Secrets|Base64 insufficiency, default unencrypted etcd, encryption/RBAC/container access and workload-creation route retained.|Same core protections/defaults and access route retained.|
|9 Storage|Inheritance/existing-PV changes, Retain/supportedDelete, PVC versus StatefulSet lifecycle retained; prerequisite omitted.|Same core distinctions, and named feature-gate prerequisite recovered.|
|10 Priorities/limits|Coherent plan with more than three application/cluster validation limits.|Coherent plan with more than three application/cluster validation limits.|

StorageClass retroactivity remains the original rubric's documented inference, not proof every proposed class edit is API-valid. Baseline's Secret API45–47 citation establishes serialized base64 representation; Secret306 would be more direct confidentiality evidence. Both networking recommendations synthesize policy mechanics and DNS evidence rather than citing the direct multi-tenancy DNS-exception paragraph; this is consistent with weaker-directness findings in prior reviews, not a new contradiction.

## Mechanical verification

Baseline has1156 whitespace words and treatment1149; both have numbered sections1–10 and meet900–1400 words. A read-only parser checked26 named baseline ranges and27 named treatment ranges; all exist, are ordered, and fit original source lengths. Baseline also uses abbreviated “same document” references, manually resolved to the preceding named topology, lifecycle, NetworkPolicy and HPA source; those ranges exist as well.

The current `check-answers.mjs` fails baseline's valid Markdown citation format `[label](docs/path.md), lines99–136`; it accepts colon/#L/prose-backtick syntax but not this variant. This is a checker-format limitation, not missing source citations. No checker modification was made in this review. Range existence alone would not catch the treatment's API citation defect.

## Trace and efficiency limits

Treatment output includes a one-line resource-read continuation at JSONL21 (`manage-resources-containers.md:67–67`) and one empty-search notice at JSONL24. No partial missing-path error was found in completed treatment outputs in this review. The gate recovery therefore does not mean all retrieval is complete or perfectly direct.

Captured provider results are308486 baseline tokens/122.959s versus258332 treatment tokens/104.848s, approximately16.3% fewer tokens and14.7% less agent time for this single pair. Setup remains separate. The treatment restores the targeted qualification, but has a citation-range defect; the baseline itself omits a required qualification. Report these findings alongside efficiency rather than claiming strict equal quality or a general savings guarantee. Frozen repetitions and broader tasks remain necessary for such claims.

The user requires complete plans and documents to retain all necessary content. This selective evidence-and-memo experiment does not authorize shortening a full plan or dropping material to meet a retrieval budget. Meeting/transcript use is a separate future task and has not been evaluated here.
