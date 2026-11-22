Approve the design conditionally. Kubernetes provides scheduling, admission and cleanup controls, but the platform must resolve the conflict between exclusive batch nodes and interactive workloads reclaiming their capacity. Application correctness under duplicate execution and abrupt termination also needs validation.

All paths below are relative to the supplied local `docs/` directory; citations identify source line ranges.

1. **CronJob execution is approximate, not exactly once.** A schedule can produce two Jobs or none, so reports must be idempotent. `Allow`, the default concurrency policy, permits overlap; `Forbid` skips a run while its predecessor remains unfinished; `Replace` replaces the unfinished run. These policies apply only within one CronJob. Choose `Forbid` if overlapping reports are undesirable, while accepting skipped occurrences.  
   Sources: `concepts/workloads/controllers/cron-jobs.md:107–143, 211–244`.

   `startingDeadlineSeconds` bounds lateness of **starting**, not execution duration. Expired occurrences are skipped; unset means no starting deadline. More than 100 missed schedules prevents startup; a configured deadline limits the missed-schedule counting window. `Forbid` skips count as misses, and deadlines below ten seconds can prevent scheduling because controller checks occur every ten seconds. Set `.spec.timeZone` explicitly, for example `Etc/UTC`; otherwise the controller manager’s local zone applies.  
   Sources: `concepts/workloads/controllers/cron-jobs.md:107–143, 176–188, 211–244`.

2. **Bound retries and total runtime separately.** Jobs support `restartPolicy: Never` or `OnFailure`: the former allows replacement of failed Pods; the latter permits container restarts within Pods. `backoffLimit`, normally six, counts failed Pods and, with `OnFailure`, container retries in Pending or Running Pods. Either calculation reaching the limit fails the Job; replacement uses exponential backoff.  
   Sources: `concepts/workloads/controllers/job.md:358–382, 615–663, 1186–1194`.

   Configure **Job-level** `activeDeadlineSeconds` for the hours-long runtime budget. It covers the Job across Pods, terminates running Pods at expiry and takes precedence over remaining retries. Reaching either limit permanently fails that Job; Pod restart policy does not restart a failed Job. `ttlSecondsAfterFinished` starts cleanup eligibility after success or failure, deleting dependent Pods through cascading deletion; it is neither a runtime limit nor an exact deletion deadline. Choose retention sufficient for diagnostics.  
   Sources: `concepts/workloads/controllers/job.md:615–663, 737–793`.

3. **Combine exclusion with mandatory placement.** Taint batch nodes, for example `dedicated=batch:NoSchedule`, and give batch Pods the matching toleration. Toleration permits placement but does not confine it: additionally require node affinity matching a batch-node label. Use `requiredDuringSchedulingIgnoredDuringExecution`, not preferred affinity. Label changes after scheduling do not move existing Pods. Keeping other workloads off also requires controlling which workloads receive tolerations.  
   Sources: `concepts/scheduling-eviction/taint-and-toleration.md:176–191`; `concepts/scheduling-eviction/assign-pod-node.md:99–130`.

   `NoSchedule` blocks new intolerant Pods without evicting existing ones. `NoExecute` also evicts existing intolerant Pods; matching tolerations can permit indefinite residence or specify `tolerationSeconds`. Use `NoExecute` only when that eviction behavior is intended.  
   Source: `concepts/scheduling-eviction/taint-and-toleration.md:101–150`.

4. **Give interactive Pods higher priority, but resolve node eligibility first.** Create cluster-scoped PriorityClasses and reference them through Pod-template `priorityClassName`. Higher numeric values mean higher priority. Lower batch priority permits higher-priority pending Pods to preempt batch victims only where removing those victims makes placement feasible. If interactive services cannot tolerate batch-node taints, reclaiming batch capacity cannot help them. Choose explicit interactive exceptions or preserve strict exclusivity without promising shared capacity.  
   Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:35–89, 177–214`.

   Set batch `preemptionPolicy: Never` if batch must not preempt others; this still allows batch to be preempted. Interactive classes need `PreemptLowerPriority`, the default, to initiate preemption. Victims receive graceful termination, delaying availability; PDB compliance is best effort and can be violated. Priority therefore provides neither immediate service nor a disruption guarantee.  
   Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:103–134, 214–238`.

5. **Quota governs admission, not reserved cluster capacity.** CPU and memory quotas require resource declarations; missing requests or limits can cause rejection. Set explicit per-container requests and limits, or deliberate LimitRange defaults. Distinguish request quotas (`cpu`/`memory` alias `requests.cpu`/`requests.memory`) from `limits.*` quotas. Creating or updating a resource beyond quota fails with HTTP 403; a Job object’s existence does not ensure its Pods can be admitted.  
   Sources: `concepts/policy/resource-quotas.md:20–60, 89–106`.

   ResourceQuota admission must be enabled and a quota installed in each namespace. Quota changes do not affect already-created resources, including running Pods. Aggregate quotas exceeding cluster capacity can still produce contention.  
   Source: `concepts/policy/resource-quotas.md:67–87`.

6. **ConfigMap delivery depends on consumption.** Ordinary mounted ConfigMap volumes eventually receive changed projected keys. Delay can reach the kubelet sync period plus cache propagation delay; watch is the documented default, with TTL-cache and direct-request alternatives. This establishes file projection, not application reload behavior. Validate that report processes reread files appropriately.  
   Source: `concepts/configuration/configmap.md:191–209`.

   `subPath` mounts receive no ConfigMap updates. Environment variables require a Pod restart. Immutable ConfigMaps reject changes to `data` and `binaryData`, and immutability cannot be reversed; replacement requires deletion/recreation, with Pod recreation recommended because existing Pods retain mount points. Choose mutable reload semantics or versioned configuration deliberately.  
   Sources: `concepts/configuration/configmap.md:191–209, 299–328`.

7. **Memory-pressure eviction is not simply “lowest priority first.”** After node-level reclamation fails, kubelet ranks Pods first by whether usage exceeds requests, then priority, then usage relative to requests. BestEffort and over-request Burstable Pods generally precede Guaranteed and below-request Burstable Pods. QoS itself is not the sorting input; even protected-looking Pods can be evicted when system consumption threatens node stability. Size requests using measured memory demand.  
   Source: `concepts/scheduling-eviction/node-pressure-eviction.md:318–362`.

   Node-pressure eviction does not honor PDBs or the Pod’s configured `terminationGracePeriodSeconds`. Soft thresholds use `eviction-max-pod-grace-period`; hard thresholds terminate with zero grace. Checkpointing cannot depend on receiving the usual shutdown window.  
   Source: `concepts/scheduling-eviction/node-pressure-eviction.md:24–36`.

8. **Restricted enforcement requires compliant workload templates.** Restricted incorporates Baseline, limits volume types, requires non-root execution and prohibits explicit UID zero. For Linux, disable privilege escalation, specify `RuntimeDefault` or `Localhost` seccomp, drop `ALL` capabilities and add back only `NET_BIND_SERVICE` if needed. Requirements cover applicable regular, init and ephemeral containers; one violating container fails validation. ConfigMap volumes are allowed.  
   Source: `concepts/security/pod-security-standards.md:300–460`.

   Configure PodSecurity admission and label each namespace `pod-security.kubernetes.io/enforce=restricted`, preferably pinning `enforce-version=v1.32` for a deliberate policy version. Enforce rejects violating Pod creation; audit records violations without blocking; warn returns warnings without blocking. “Everywhere” requires checking admission exemptions, including system namespaces, rather than assuming labels alone establish coverage.  
   Sources: `reference/labels-annotations-taints/_index.md:2369–2451`; `tasks/configure-pod-container/migrate-from-psp.md:247–272`; `tutorials/security/cluster-level-pss.md:175–215`.

9. **Disable unnecessary credential automounting.** Pods receive their namespace’s default ServiceAccount when none is specified, and normally receive automatically mounted API credentials. Set `automountServiceAccountToken: false` in the Job’s Pod template, on its ServiceAccount, or both. Pod settings override ServiceAccount settings. ConfigMap volume consumption should not be mistaken for an application requirement to call the API; inspect workloads for explicit token projections or other supplied credentials before declaring them credential-free.  
   Sources: `tasks/configure-pod-container/configure-service-account.md:32–100, 424–429`.

10. **Roll out in dependency order.** First resolve interactive access to batch capacity and test mandatory affinity, taints and priority together. Next establish quota declarations and token-free templates. Dry-run Restricted namespace enforcement, run audit/warn through representative nightly workloads, fix violations, then enforce. Finally inject failures, prolonged execution, configuration edits and memory pressure; verify retry/deadline outcomes and retain diagnostics before TTL cleanup.  
    Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:177–238`; `concepts/policy/resource-quotas.md:20–60`; `tasks/configure-pod-container/migrate-from-psp.md:247–280`; `concepts/workloads/controllers/job.md:615–663, 737–793`.

    Release gates still needing application or cluster validation are duplicate-safe report effects, feasible interactive placement and acceptable preemption latency, memory sizing and checkpoint recovery under immediate eviction, configuration reload correctness, and image compatibility with Restricted. The documented mechanisms above do not establish those outcomes for this platform.