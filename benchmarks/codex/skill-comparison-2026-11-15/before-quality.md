# Manual quality review: before comparison

Reviewed all six memos in [before/](before/) against the ten criteria and pinned original source ranges in [the existing quality rubric](../quality-review.md). The baseline answers are not answer keys. This is a transparent, unblinded review by the same assistant involved in diagnosis and the citation-checker change; it does not establish strict equivalence, independence, or general accuracy.

All six cover the ten main topics, propose a coherent prioritized plan, and retain multiple application/cluster validation limits. No contradictory core mechanism was identified. All six preserve the StatefulSet feature-gate prerequisite and the not-yet-ready HPA Pods' zero-percent upscale assumption, which were omitted in an earlier semantic experiment.

## Qualifications and citation findings

| Memo | Main topics | Findings |
| --- | --- | --- |
| Baseline 1 | 10/10 | DNS source establishes resolver UDP/TCP 53, combined with policy mechanics; the direct default-deny/DNS paragraph would be stronger. |
| Baseline 2 | 10/10 | Same indirect DNS support. Startup/liveness restart wording does not explicitly repeat the restart-policy qualification, although it matches the cited probe guide's description and the specified Deployment context. |
| Baseline 3 | 10/10 | DNS citation gives general Service-name resolution rather than the direct policy exception. Some Markdown link destinations cover fewer ranges than their visible citation labels; the additional visibly named ranges remain valid source references. |
| Doktimoi 1 | 10/10 | Countdown statement cites API lines 1005–1007; the explicit supporting sentence is at 1008, outside that range. Other cited lifecycle lines support shutdown order and the shared grace budget indirectly. |
| Doktimoi 2 | 10/10 | Recommends encryption at rest but omits the rubric's explicit qualification that Secrets are stored unencrypted in etcd by default. No opposite claim is made. |
| Doktimoi 3 | 10/10 | No additional qualification or citation defect identified under this rubric. |

The Doktimoi 1 citation defect is specifically in section 4: `reference/kubernetes-api/workload-resources/pod-v1.md:1005–1007` contains whitespace and the `lifecycle.preStop` field heading. Line 1008 states that the countdown begins before the hook. Its additional `pod-lifecycle.md:584–645` citation establishes hook/TERM/KILL order, grace expiry and the extension, so the mechanism itself is not contradicted. Baseline 1 cites line 1008, Doktimoi 2 includes it in 1000–1008, and Doktimoi 3 cites it directly.

The Doktimoi 2 section 8 omission is checked against `concepts/configuration/secret.md:35–48`. The other five explicitly state the default unencrypted etcd storage. This is a qualification shortfall under the existing rubric, not evidence that the memo asserts encryption is enabled by default.

For DNS, the direct exception is `concepts/security/multi-tenancy.md:218–219`; the baseline recommendations are defensible synthesis from NetworkPolicy permission mechanics plus resolver evidence, but their references are less direct. All three Doktimoi memos cite this policy paragraph. Baseline 3 also visibly cites topology lines 607–619, probe lines 398–421 and other secondary ranges whose link targets lead only to the first range. These labels preserve source locations, while clicking the link alone does not expose every cited passage.

## Rubric coverage

All six distinguish involuntary node failure, eviction-aware drain and rollout bypass, calculate six minus two as four, and give compatible rollout settings with capacity caveats. All explain zone selectors, skew against a global minimum, hard versus soft constraints, eligibility/minDomains and outage tradeoffs. All distinguish startup gating, readiness traffic withdrawal without restart, and liveness/startup failure behavior; Baseline 2's explicit restart-policy qualification is noted above.

All preserve grace including preStop, hook before TERM, eventual KILL, concurrent endpoint changes and no request-completion guarantee. All distinguish requests from limits, CPU throttling from reactive memory OOM, and undefined utilization when relevant requests are absent. All retain missing-metric 100% downscale/0% upscale assumptions, not-ready-Pod 0% upscale damping, and highest-recommendation five-minute downscale stabilization.

All explain directional/additive networking, both ends of a connection, DNS and enforcement prerequisites. All reject base64 confidentiality and discuss RBAC, workload-creation exposure and encryption; Doktimoi 2's default-storage omission is noted above. All distinguish provisioning-time StorageClass inheritance from existing PV settings, Retain from supported Delete, and StatefulSet PVC retention from PV reclamation. StorageClass retroactivity remains the documented inference described in the existing rubric; these memos do not prove that every proposed class edit is API-valid. All provide more than three explicit limits requiring actual application or cluster validation.

## Mechanical checks

[answer-structure.json](before/answer-structure.json) records the captured checker result. All six satisfy 900–1400 whitespace-delimited words, ten numbered sections, and existing named source ranges.

| Memo | Words | Checked citation ranges |
| --- | ---: | ---: |
| Baseline 1 | 1172 | 30 |
| Baseline 2 | 1166 | 26 |
| Baseline 3 | 1042 | 43 |
| Doktimoi 1 | 1130 | 29 |
| Doktimoi 2 | 1154 | 24 |
| Doktimoi 3 | 1130 | 27 |

Baseline 3 uses both visible colon references and Markdown `#L` destinations, so its count includes duplicate representations of the same evidence. Counts are not evidence of stronger quality. Range existence likewise does not establish claim support, as Doktimoi 1's off-by-one citation illustrates.

## Trace observations

These observations explain recovery work, not answer correctness. JSONL line numbers refer to files in [before/](before/). All partial Doktimoi operations below occur inside commands exiting zero.

- **Baseline 1:** 12 completed commands; line 15/item 6 exits 1 and line 22/item 10 exits 2. **Baseline 2:** 10 commands; line 24/item 11 exits 1. **Baseline 3:** 11 commands, none nonzero. The final memos recovered from the operation errors.
- **Doktimoi 1:** 11 commands including the skill read, seven excerpt notices. Line 14/item 6 reads five ranges after initial searches. Line 16/item 7 requests absent lifecycle-hooks; line 18/item 8 has an empty search; line 22/item 10 requests absent change-pv-reclaim-policy; line 24/item 11 requests absent secrets-good-practices and dynamic-provisioning. Four absent paths occur in three operations.
- **Doktimoi 2:** 11 commands, six excerpt notices. Line 14/item 6 requests absent change-pv-reclaim-policy. Line 18/item 8 overfills an eight-range read, leaving Secret and PV ranges unread; line 20/item 9 retrieves them with four additional ranges. Line 22/item 10 requests absent lifecycle-hooks; line 24/item 11 globally searches countdown as recovery; line 27/item 13 reads the API passage and three more ranges.
- **Doktimoi 3:** 10 commands, six excerpt notices. Line 16/item 7 requests absent secrets-good-practices. Line 18/item 8 reports an empty search and requests absent lifecycle-hooks.

Absent linked pages are not evidence of missing underlying facts; agents found supporting supplied sources elsewhere. Excerpts and broad follow-up reads recur, but some expansions recover necessary conditions rather than merely verifying complete evidence. These completed traces establish recovery cost in the current workflow; they do not by themselves prove that a proposed retrieval change saves time or tokens without quality loss.
