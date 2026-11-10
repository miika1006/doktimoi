# Answer review against original sources

The baseline answer is not an answer key. Review each memo against the pinned
original documents, including conditions and exceptions. The reviewer is the
same coding assistant that implemented the changes, not an independent blinded
evaluator. The criteria below come from the shared task; this is a transparent
manual review plus mechanical source checks, not a general accuracy guarantee.

## Criteria

| Question | Required findings | Original evidence under `examples/kubernetes/docs/` |
| --- | --- | --- |
| 1 | PDB cannot prevent involuntary failure; eviction-aware drains respect it; Deployment rollouts bypass it; six minus two is four; compatible rollout choice requires capacity | `concepts/workloads/pods/disruptions.md:99-145`; `concepts/workloads/controllers/deployment.md:1189-1211` |
| 2 | Zone label/selector, skew against global minimum, hard versus soft constraint, eligibility/minDomains and outage tradeoffs | `concepts/scheduling-eviction/topology-spread-constraints.md:76-139,605-623` |
| 3 | Startup gates other probes; readiness withdraws ordinary traffic without restart; liveness/startup failure triggers restart-policy behavior | `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:15-48,311-367`; `concepts/workloads/pods/pod-lifecycle.md:479-497` |
| 4 | Grace includes preStop; hook precedes TERM, expiry leads to KILL; endpoint updates concurrent, terminating ready=false; no request-completion guarantee | `reference/kubernetes-api/workload-resources/pod-v1.md:1006-1008`; `concepts/workloads/pods/pod-lifecycle.md:584-645` |
| 5 | Requests versus limits; CPU throttling versus reactive memory OOM; missing requests invalidate utilization for that HPA metric | `concepts/configuration/manage-resources-containers.md:18-67`; `tasks/run-application/horizontal-pod-autoscale.md:89-102` |
| 6 | Missing metrics assumed 100% on downscale/0% on upscale; not-ready CPU pods dampen upscale; five-minute highest-recommendation stabilization | `tasks/run-application/horizontal-pod-autoscale.md:129-218` |
| 7 | Directional isolation, additive union, both ends allowed, DNS exception and enforcing network implementation | `concepts/services-networking/network-policies.md:45-81,210-259`; `concepts/security/multi-tenancy.md:208-234`; `tasks/administer-cluster/dns-debugging-resolution.md:158-173` |
| 8 | Base64 is not confidentiality; default etcd storage, encryption/RBAC, Pod creation exposes namespace Secrets | `concepts/configuration/secret.md:35-48,305-307` |
| 9 | Provisioning policy inheritance; existing PVs edited separately; Retain versus supported Delete; StatefulSet claim retention is separate, with documented prerequisites | `concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:180-210`; `concepts/workloads/controllers/statefulset.md:387-445` |
| 10 | Prioritized, coherent plan; at least three application/cluster limits remain to validate | Synthesis of the preceding sources; recommendations must not become guarantees |

The statement about changing a StorageClass not retroactively changing existing
PVs is an inference from provisioning-time inheritance and the explicit
instruction to edit/patch an already created PV. The supplied subset does not
establish whether every proposed StorageClass edit is accepted by an API server.
Likewise this corpus does not prove workload capacity, request completion,
storage recovery, enforcement by an installed CNI, or the behavior of a live
cluster. Answers are judged against the archived v1.32 source, not current APIs.

## Retrieval checks versus generated-answer checks

The automated [20-query check](../retrieval-validation.json) verifies that the
retriever returns expected evidence and that its text and line references match
the originals. Its successful result does not establish that an LLM will retain
every qualifier while writing a memo. Count topic coverage, unsupported claims,
omitted qualifications and citation quality separately.

For every saved answer, check its ten numbered sections, 900–1400-word target,
and cited paths/ranges. Resolve paths relative to the corpus root, including
`docs/` prefixes, Markdown `#Lx-Ly` links and abbreviated ranges referring to
the preceding named file. Then read the cited source and check the actual claim;
range existence alone is insufficient.

## Findings from diagnostic experiments

All six answers in `results-2026-11-10/` covered the ten requested topics and
were within the requested length. Their cited ranges resolved to the original
files. The three baseline memos and the first two Doktimoi memos conveyed the
same main mechanisms and limitations. The third Doktimoi memo omitted the
StatefulSet feature prerequisite and recommended DNS egress without citing the
specific DNS-supporting passage. Those are qualification/citation omissions,
not evidence that the retriever returned fabricated text.

The subsequent candidate in `final-2026-11-10/` preserved the main findings as
well. Its first Doktimoi answer again omitted the StatefulSet prerequisite and
used the general NetworkPolicy passage for its DNS recommendation; the second
included both supporting qualifications. The traces show relevant source text
was available, so these omissions must remain visible in answer-quality review
even when the retrieval checks pass.

Intermediate runs are retained for diagnosis rather than scored as independent
confirmatory trials. No answer or expected source range was fed back into the
fresh benchmark contexts. Workflow and retrieval changes were informed by the
observed traces, which makes the final experiment a within-task validation;
generalization to other tasks needs separate testing.

## Completed lexical release comparison

All six memos in `release-2026-11-10` were reviewed against the ten criteria
above. All covered the main mechanisms, relevant exceptions and the StatefulSet
prerequisite; no contradictory core finding was identified. The first Doktimoi
memo cites a general cluster-DNS paragraph for its DNS exception, rather than
the more direct default-deny/DNS passage at `multi-tenancy.md:208–234`. The first
baseline memo likewise cites general DNS background. These are weaker citations,
not proof that a proposed cluster policy works.

The [mechanical checks](release-2026-11-10/answer-structure.json) found ten
sections, 1117–1207 whitespace-delimited words, and valid named citation ranges
in every memo. Reproduce them with:

```sh
node benchmarks/check-answers.mjs benchmarks/release-2026-11-10
```

The trace audit records three Doktimoi operations with four absent-path errors,
two empty searches and one capped read. They are not hidden as successful
retrievals merely because the containing batch exited zero. Independent batch
answers survived those errors. Three baseline commands also exited nonzero.
Neither arm used the other arm's retrieval method.

## Semantic CPU comparison

All three semantic memos also cover the ten topics and preserve the principal
mechanisms. Runs 1 and 3 include the StatefulSet prerequisite. Run 2 omits it,
citing the generated API reference instead of the conceptual page that states
the feature-gate requirement. Run 2 also describes the damping effect of
not-yet-ready Pods without explicitly stating their 0% upscale assumption.
Those two qualifications therefore fail the stricter rubric, even though no
opposite claim is made. Run 3 cites resolver configuration for DNS egress;
the default-deny/DNS paragraph would provide more direct policy evidence.

| Memos | Topics covered | Core contradictions found | Qualification/citation findings |
| --- | --- | --- | --- |
| Baseline 1–3 | 10/10 each | None identified | Baseline 1 DNS citation is general background |
| Lexical 1–3 | 10/10 each | None identified | Lexical 1 DNS citation is general background |
| Hybrid 1 | 10/10 | None identified | Abbreviated repeated citations resolve to the preceding named source |
| Hybrid 2 | 10/10 | None identified | StatefulSet prerequisite and not-ready-Pod 0% assumption omitted |
| Hybrid 3 | 10/10 | None identified | DNS citation gives resolver configuration rather than the direct policy exception |

[answer-structure.json](answer-structure.json) records all nine memos' word
counts, numbered sections and mechanically checked **named** source ranges.
Repeated abbreviated citations in the semantic memos were checked manually
against the preceding named source; the script does not pretend to understand
those prose references. All nine satisfy the requested word range.

The separate semantic keyword-query validator scored 18/20; the two missing
top-ten passages were present in exact-mode scans, and wider result inspection
located them. No returned source-text or line-integrity mismatch was found.
This is a relevance shortfall, not a successful accuracy test. Generated memos
can recover those facts through follow-up queries, at additional token/time
cost. The baseline, lexical and semantic outputs are therefore comparable in
main topic coverage, but are not certified equivalent or error-free.
