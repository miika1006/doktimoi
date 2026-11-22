**Decision memo: approve conditionally.** The design needs explicit scheduling, failure, configuration and admission policies. Its central unresolved choice is whether batch nodes are exclusive: excluding interactive Pods from those nodes prevents preemption there from helping interactive services.

All citations below are local paths relative to the supplied `docs/` directory; ranges identify source lines.

1. **CronJob execution is approximate, not exactly once.** Kubernetes can create two Jobs or none for a scheduled execution; reports must therefore be idempotent. `concurrencyPolicy: Allow` permits overlap; `Forbid` skips a run while its predecessor remains active; `Replace` replaces that predecessor. These policies apply only within one CronJob. Choose `Forbid` if overlapping reports are unacceptable, while accepting missed runs.

   `startingDeadlineSeconds` limits lateness of Job creation, not runtime. Expired occurrences are skipped. More than 100 missed schedules prevents creation; setting the deadline bounds the missed-schedule counting window. `Forbid` skips count as missed; deadlines below ten seconds may prevent scheduling. Set `.spec.timeZone`, preferably an explicit operational choice such as `Etc/UTC`; otherwise the controller manager’s local timezone applies.  
   Sources: `concepts/workloads/controllers/cron-jobs.md:107–145,176–188,211–244`.

2. **Separate retries, runtime and cleanup.** Job Pods support `restartPolicy: Never` or `OnFailure`. With `Never`, failed Pods are replaced; with `OnFailure`, container retries also count toward `backoffLimit`. The default backoff limit is six, with exponential replacement delays capped at six minutes. Either retry calculation reaching the limit fails the Job.

   Set Job-level `activeDeadlineSeconds` for the total runtime across Pods. It terminates running Pods and produces `DeadlineExceeded`; it takes precedence over remaining retry allowance. An earlier exhausted backoff limit can still fail the Job first. Neither mechanism automatically restarts a failed Job. `ttlSecondsAfterFinished` only makes completed or failed Jobs eligible for cascading cleanup; it does not constrain execution time. Retain enough time for diagnosis.  
   Sources: `concepts/workloads/controllers/job.md:358–382,615–665,737–776,1186–1194`.

3. **Use both repulsion and required placement.** Taint batch nodes, for example `dedicated=batch:NoSchedule`, give batch Pods the matching toleration, and require node affinity matching a batch-node label. Toleration merely permits placement; it does not confine Pods to those nodes. Required affinity confines scheduling; preferred affinity does not. Label changes after scheduling do not move Pods.

   `NoSchedule` leaves existing Pods running. `NoExecute` additionally evicts non-tolerating residents; tolerations can allow indefinite residence or specify `tolerationSeconds`. Enforcement needs controls over tolerations and placement fields: manually setting `nodeName` bypasses scheduler handling of `NoSchedule`. These fields alone do not establish tenant-proof isolation.  
   Sources: `concepts/scheduling-eviction/taint-and-toleration.md:29–150,176–191`; `concepts/scheduling-eviction/assign-pod-node.md:100–150`.

4. **Give interactive workloads higher priority, with a feasible destination.** Create cluster-scoped PriorityClasses and select them through Pod `priorityClassName`; larger values mean higher priority. Choose low batch priority and higher interactive priority. Batch can use `preemptionPolicy: Never`: it cannot evict others but remains preemptible. Interactive classes need `PreemptLowerPriority` to preempt lower-priority Pods.

   Victims receive their graceful termination period, delaying resource availability. PDB compliance is best effort: preemption can violate a budget. Crucially, a node is considered only if removing lower-priority Pods makes the incoming Pod schedulable. Exclusive batch nodes therefore cannot provide interactive overflow. Resolve that requirement explicitly—allow selected interactive Pods onto batch nodes, or retain exclusivity and provide separate interactive capacity.  
   Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:51–85,103–147,214–262`.

5. **Quota is admission control, not capacity reservation.** CPU/memory quotas require corresponding resource declarations for new Pods; configure explicit requests and limits in every container, or deliberate admission defaults. Distinguish quota keys: `cpu`/`memory` alias requests, while `limits.cpu`/`limits.memory` constrain summed limits across non-terminal Pods.

   A creation or update exceeding quota receives HTTP `403 FORBIDDEN`; Kubernetes does not admit an oversized Pod and wait for quota availability. Adding or changing quota does not affect already-created resources, including running Pods. Quotas whose totals exceed cluster capacity can still contend for resources.  
   Sources: `concepts/policy/resource-quotas.md:21–77,89–105`.

6. **Choose configuration consistency deliberately.** ConfigMap-backed volumes eventually receive projected updates. Delay can reach the kubelet sync period plus cache propagation delay; the cache strategy is configurable, with watch propagation the default. This establishes file projection, not that the report process reloads those files.

   `subPath` mounts receive no ConfigMap updates. Environment-variable consumers require Pod restart. An immutable ConfigMap cannot have immutability reversed or its data changed; operators must delete and recreate it, and the docs recommend recreating existing consuming Pods. For reproducible nightly reports, prefer a deliberately selected immutable configuration version; live-editable configuration requires application reload validation.  
   Source: `concepts/configuration/configmap.md:191–209,299–328`.

7. **Memory-pressure eviction is not simply “lowest priority first.”** After node-resource reclamation fails, kubelet ranks Pods by whether usage exceeds requests, then priority, then usage relative to requests. BestEffort/Burstable Pods exceeding requests are evicted first; Guaranteed and below-request Burstable Pods are last, ordered by priority. QoS is an estimate, not the ranking input. Even the latter group can be evicted when system consumption threatens stability.

   Node-pressure eviction ignores PDBs and Pod `terminationGracePeriodSeconds`. Hard thresholds cause immediate termination; soft thresholds use kubelet eviction-grace configuration. Low priority therefore helps batch yield but does not guarantee it is always the first memory-pressure victim.  
   Sources: `concepts/scheduling-eviction/node-pressure-eviction.md:20–36,185–206,318–352`.

8. **Restricted requires admission enforcement and compatible Pods.** Configure functioning Pod Security Admission and namespace labels `pod-security.kubernetes.io/enforce=restricted` and `enforce-version=v1.32`. Enforce rejects violating Pod creation. Audit records violations without rejection; warn returns immediate warnings without rejection.

   Restricted includes every Baseline control, including restrictions on privileged containers and host namespaces. It permits only listed volume types and requires non-root execution, prohibits explicit UID zero, and—for Linux—requires `allowPrivilegeEscalation: false`, explicit `RuntimeDefault` or `Localhost` seccomp, and dropping `ALL` capabilities, adding back only `NET_BIND_SERVICE`. Requirements cover applicable regular, init and ephemeral containers. Namespace policy is not proof of application compatibility or comprehensive security. Protect namespace-label permissions against policy bypass.  
   Sources: `reference/labels-annotations-taints/_index.md:2369–2399`; `tasks/configure-pod-container/migrate-from-psp.md:79–89,247–272`; `concepts/security/pod-security-standards.md:40–110,300–465`; `concepts/security/security-checklist.md:119–136`.

9. **Disable unnecessary credential automounting explicitly.** Omitting `serviceAccountName` assigns the namespace’s default ServiceAccount; it does not avoid credentials. Applications normally receive automatically mounted ServiceAccount credentials.

   Set `automountServiceAccountToken: false` in the CronJob’s Pod template. Also consider that setting on the team’s batch ServiceAccount as a default. The Pod setting takes precedence over the ServiceAccount setting. For workloads genuinely requiring API access, select an appropriate ServiceAccount and validate its authorization separately. Disabling automount addresses automatic credentials, not credentials explicitly supplied elsewhere.  
   Source: `tasks/configure-pod-container/configure-service-account.md:32–100`.

10. **Roll out in this priority order.**

   - **Resolve placement first:** choose exclusivity versus interactive overflow, then test taints, required affinity, toleration controls and actual preemption feasibility. Sources: `concepts/scheduling-eviction/taint-and-toleration.md:176–191`; `concepts/scheduling-eviction/pod-priority-preemption.md:240–262`.
   - **Prepare admission:** set requests/limits, quotas and credential opt-outs; run Restricted audit/warn and server-side policy dry-runs, fix violations, then enforce across namespaces. Sources: `concepts/policy/resource-quotas.md:35–60`; `tasks/configure-pod-container/configure-service-account.md:67–100`; `tasks/configure-pod-container/migrate-from-psp.md:247–272`.
   - **Exercise failure paths before broad rollout:** test duplicate execution, retries, deadlines, configuration changes, preemption and memory pressure; inspect results before enabling cleanup. Sources: `concepts/workloads/controllers/cron-jobs.md:211–244`; `concepts/workloads/controllers/job.md:615–665,737–776`; `concepts/configuration/configmap.md:191–209`; `concepts/scheduling-eviction/node-pressure-eviction.md:20–36`.

   At least four limits require validation beyond these documents: report idempotency, checkpoint recovery after abrupt termination, application configuration reload behavior, and interactive scheduling latency under actual capacity constraints. The documented mechanisms do not guarantee any of those outcomes.