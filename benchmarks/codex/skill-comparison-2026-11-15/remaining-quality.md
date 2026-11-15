# Remaining after/QMD quality review

Reviewed remaining `after/{2-baseline,2-doktimoi,3-baseline,3-doktimoi}.answer.md` and `qmd/{2-competitor,3-competitor}.answer.md` under `benchmarks/codex/skill-comparison-2026-11-15`. Applied the same original-source criteria in `benchmarks/codex/quality-review.md` and standards documented in `before-quality.md`, `/tmp/doktimoi-after1-quality.md` and `/tmp/qmd1-quality.md`. This is the same unblinded reviewer; baseline answers are not answer keys. No recorded runs/code changed and no model benchmarks launched.

## Material findings

1. **After Doktimoi2 and3 both omit the StatefulSet feature-gate prerequisite**, repeating after Doktimoi1. Their section9 describes optional PVC deletion using generated API `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130–146`, which lacks the condition. Original conceptual `concepts/workloads/controllers/statefulset.md:391–394` explicitly requires `StatefulSetAutoDeletePVC` on API server and controller manager. Under the existing rubric this is a qualification failure, even though retention/deletion mechanisms are otherwise correct and no opposite assertion appears.

   Captured-source audit supports a retrieval explanation: after2 JSONL10 and after3 JSONL11 return generated API evidence; no completed command output in either trace contains `StatefulSetAutoDeletePVC` or the conceptual `controllers/statefulset.md` source. All three after treatments therefore omit the same prerequisite, rather than just one stochastic writing omission.

2. **After Baseline3 omits the default unencrypted etcd-storage qualification.** Section8 recommends encryption, migration verification and RBAC but never explicitly states the default. It cites `secret.md:35–48`, which contains the fact. This matches the strict omission standard applied to before Doktimoi2. No implication that encryption is enabled by default was found; it is a missing required qualification. After Baseline2 and both QMD memos explicitly state the default.

3. **QMD2 and3 preserve both historically fragile qualifications.** QMD2 asks to verify documented feature-gate prerequisites, directly citing conceptual387–423; QMD3 explicitly names the required feature gate on API server/controller manager. The source actually appears in their captured outputs: QMD2 JSONL26 and40 contain `StatefulSetAutoDeletePVC`; QMD3 JSONL30 and54 contain it. Both preserve the HPA not-ready-Pod zero-percent upscale assumption.

No contradictory core mechanism identified in these six memos. Main-topic coverage is10/10 in all six, which must not be confused with complete qualification coverage or equal quality.

## All-ten-topic review

| Topic | Result across these six |
| --- | --- |
|1 PDB/rollout|All distinguish involuntary failure, eviction-aware drain, direct deletion and rollout bypass; calculate four from six-minus-two; propose compatible availability/surge choices with capacity/failure caveats.|
|2 Zone spread|All explain selector, label domains, skew/global minimum, hard versus soft constraints, eligibility/minDomains and outage tradeoff; no guaranteed five survivors or automatic rebalancing.|
|3 Probes|All preserve startup gating, readiness traffic withdrawal without restart, and liveness/startup restart behavior. After Doktimoi3 and QMD3 compress restart wording without explicitly repeating restart-policy dependence, but cite the probe guide/lifecycle as before; not counted as a new contradiction in this Deployment context.|
|4 Termination|All preserve preStop consuming grace, hook before TERM, KILL/extension, concurrent endpointready=false and no long-request completion guarantee. After2 baseline uses lifecycle sequence rather than the explicit API countdown sentence; this is indirect but consistent with prior reviews.|
|5 Requests/limits|All distinguish requests from ceilings, CPU throttling/reactive OOM, and missing CPU requests preventing action for that utilization metric.|
|6 HPA|All preserve missing100% downscale/0% upscale, not-ready0%, conservative reversal/tolerance handling and highest-recommendation five-minute stabilization. QMD3's “target utilization” means100% of target, not100% CPU usage.|
|7 NetworkPolicy|All preserve directional isolation, additive union, both-end permission, DNS allowance and enforcing network-plugin prerequisite.|
|8 Secrets|All reject base64 confidentiality and explain RBAC/workload creation exposure and encryption recommendation. After Baseline3 omits default unencrypted etcd storage; other five state it.|
|9 Storage|All distinguish provisioning-time class inheritance/existing-PV editing, Retain/supportedDelete, and StatefulSet PVC retention versus PV reclamation. After Doktimoi2/3 omit feature-gate prerequisite; other four preserve it.|
|10 Plan/limits|All provide priorities and at least three explicit application/cluster limitations; no field-existence success guarantee.|

StorageClass retroactivity remains the documented inference explained in the original rubric, not proof every class edit is API-valid. QMD3 additionally cautions against assuming a stateful database is necessarily a StatefulSet; this is consistent with the prompt.

## Citation precision

All captured named citation ranges exist and are ordered validly. No repeat of before Doktimoi1's off-by-one API countdown citation: after Doktimoi2 cites992–1008; after Doktimoi3 cites1000–1008; both include the explicit sentence1008. QMD2 cites1006–1008 and QMD3 directly cites1008.

After Baseline2/3 and QMD3 cite general Service-DNS material alongside NetworkPolicy mechanics rather than direct default-deny/DNS guidance. These are defensible synthesis but weaker direct exception evidence than multi-tenancy218–219. After Doktimoi2/3 and QMD2 cite the direct multi-tenancy paragraph.

QMD2 section8 cites base64 conversion (`distribute-credentials-secure.md:17–28`) and Secret representation453–457 for the claim base64 is representation rather than confidentiality. These sources demonstrate the representation but are less direct than Secret306 (“obscured but not secret”), which other memos use. The recommendation is correct; distinguish support directness from contradiction.

## Mechanical checks

Ran `node benchmarks/check-answers.mjs` on the after and QMD result directories; all pass ten-section, word-target and named-range checks. The current checker now supports QMD1's prose `L` syntax as well. It verifies existence, not claim support.

| Memo | Words | Valid named ranges |
| --- | ---: | ---: |
|After Baseline2|1222|30|
|After Doktimoi2|1148|27|
|After Baseline3|1165|24|
|After Doktimoi3|1160|30|
|QMD2|1236|29|
|QMD3|1172|27|

## Combined interpretation with prior reviews

- Before treatments: one citation-precision defect (Doktimoi1 countdown), one omitted default-storage qualifier (Doktimoi2), no identified new defect Doktimoi3; all retain StatefulSet prerequisite.
- After treatments: all three omit StatefulSet prerequisite and all three retrieve API-only retention evidence without the conceptual condition. Their favorable efficiency must be reported alongside this systematic qualification loss.
- After controls: Baseline1/2 retain core rubric qualifications; Baseline3 omits default unencrypted etcd storage.
- QMD1–3 retain required core qualifiers under this review, with documented wording/citation-directness caveats. This is not certification of general accuracy, independent evaluation, or equal-quality efficiency on other tasks.
