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

The automated 20-query check (`validate-retrieval.mjs`) verifies that the
retriever returns expected evidence and that its text and line references match
the originals. Its successful result does not establish that an LLM will retain
every qualifier while writing a memo. Count topic coverage, unsupported claims,
omitted qualifications and citation quality separately.

For every saved answer, check its ten numbered sections, 900–1400-word target,
and cited paths/ranges. Resolve paths relative to the corpus root, including
`docs/` prefixes, Markdown `#Lx-Ly` links and abbreviated ranges referring to
the preceding named file. Then read the cited source and check the actual claim;
range existence alone is insufficient.

## Findings from earlier experiments

Earlier diagnostic runs (now only in git history) covered the ten topics, but some
Doktimoi memos omitted the StatefulSet prerequisite or cited a general NetworkPolicy
passage for DNS although the supporting text had been retrieved. Answer-quality review
must keep checking such omissions even when the retrieval checks pass.

Intermediate runs are retained for diagnosis rather than scored as independent
confirmatory trials. No answer or expected source range was fed back into the
fresh benchmark contexts. Workflow and retrieval changes were informed by the
observed traces, which makes the final experiment a within-task validation;
generalization to other tasks needs separate testing.

