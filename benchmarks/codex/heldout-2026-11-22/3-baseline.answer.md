Adopt the design conditionally. Kubernetes supplies scheduling, admission and cleanup mechanisms, but the documents do not establish exactly-once reporting, immediate yielding, or application correctness after interruption. Resolve the conflict between exclusive batch nodes and interactive preemption before rollout.

1. **CronJob scheduling is approximate.** A schedule can produce two Jobs or none; report execution must therefore be idempotent. `concurrencyPolicy: Allow` permits overlap; `Forbid` skips an occurrence while the previous run remains active; `Replace` replaces that run. These policies apply only within the same CronJob. Choose `Forbid` if overlapping reports are unacceptable, while accepting missed runs.  
   Sources: [docs/concepts/workloads/controllers/cron-jobs.md](docs/concepts/workloads/controllers/cron-jobs.md), lines 130–143, 213–217.

   `startingDeadlineSeconds` bounds lateness in **starting**, not execution duration; expired occurrences are skipped. More than 100 missed schedules prevents Job creation. Setting the deadline changes the counting window; `Forbid` overlaps count as missed. Values below ten seconds may never schedule because the controller checks every ten seconds. Explicitly choose `.spec.timeZone`, such as `Etc/UTC`; otherwise the controller-manager’s local zone applies.  
   Source: same document, lines 109–126, 180–186, 228–240.

2. **Bound retries and elapsed runtime separately.** Jobs permit `restartPolicy: Never` or `OnFailure`. With `Never`, failed Pods lead to replacement Pods; with `OnFailure`, container restarts also count toward `backoffLimit`. The default backoff limit is six, with exponential retry delays capped at six minutes. Reaching the limit fails the Job and terminates remaining Pods.  
   Source: [docs/concepts/workloads/controllers/job.md](docs/concepts/workloads/controllers/job.md), lines 220–221, 360–380, 623–626.

   Set Job-level `activeDeadlineSeconds` for the total runtime across Pods. It takes precedence over remaining retry allowance: deadline expiry terminates running Pods with `DeadlineExceeded`. Either failure mechanism permanently fails that Job; Pod restart policy does not restart it. `ttlSecondsAfterFinished` subsequently makes completed or failed Jobs eligible for cascading cleanup; it is neither a runtime limit nor a retry mechanism. Preserve diagnostics before cleanup.  
   Source: same document, lines 628–663, 737–775.

3. **Combine placement requirements with exclusion.** Label batch nodes, require matching `requiredDuringSchedulingIgnoredDuringExecution` node affinity in batch templates, and apply a batch taint with a matching toleration. Toleration alone permits those nodes but also permits others; affinity alone does not repel other workloads. Required affinity constrains scheduling, but later label changes do not evict existing Pods.  
   Sources: [docs/concepts/scheduling-eviction/taint-and-toleration.md](docs/concepts/scheduling-eviction/taint-and-toleration.md), lines 13–21, 181–191; [docs/concepts/scheduling-eviction/assign-pod-node.md](docs/concepts/scheduling-eviction/assign-pod-node.md), lines 105–118.

   `NoSchedule` excludes new untolerating Pods while leaving existing ones running. `NoExecute` also evicts existing untolerating Pods; matching tolerations can allow indefinite residence or specify `tolerationSeconds`. Enforce which workloads may obtain tolerations: these fields alone do not establish tenant compliance.  
   Source: taint-and-toleration document, lines 99–110, 181–191.

4. **Give interactive workloads higher priority, but resolve node eligibility.** Create cluster-scoped PriorityClasses and reference them through `priorityClassName`: higher integer values mean higher priority. Choose low batch priority, optionally with `preemptionPolicy: Never` so batch cannot preempt others; batch remains preemptible. Interactive classes need `PreemptLowerPriority`, the default, to preempt lower-priority workloads.  
   Source: [docs/concepts/scheduling-eviction/pod-priority-preemption.md](docs/concepts/scheduling-eviction/pod-priority-preemption.md), lines 53–57, 107–127, 151–154.

   Preemption helps only where removing victims makes a node eligible for the pending interactive Pod. If interactive Pods cannot tolerate batch taints, exclusive batch nodes cannot supply their capacity. Either permit designated interactive workloads there or retain strict exclusivity without promising such yielding. Victims receive graceful termination, delaying capacity release. PDB protection is best effort: preemption can violate it.  
   Source: same document, lines 187–194, 218–238.

5. **Quota governs admission, not reserved capacity.** Supply explicit CPU and memory requests and limits in every container template, matching the quota dimensions; defaults through LimitRange are another configuration choice. The quota documentation requires requests or limits for covered CPU/memory resources and warns that omissions can cause rejection. Violating creation or update requests receive HTTP `403 Forbidden`.  
   Source: [docs/concepts/policy/resource-quotas.md](docs/concepts/policy/resource-quotas.md), lines 26–60.

   `cpu` and `memory` mean aggregate requests; `limits.cpu` and `limits.memory` constrain aggregate limits across nonterminal Pods. New quotas or quota changes do not affect already-created resources. Namespace quotas can collectively exceed cluster capacity, so admission does not guarantee scheduling. Verify ResourceQuota admission is enabled.  
   Source: same document, lines 74–87, 99–105.

6. **Choose deliberate configuration semantics.** Ordinary ConfigMap volume projections update eventually. Delay can reach the kubelet sync period plus cache propagation delay; the documentation gives no universal number of seconds. `subPath` mounts receive no updates. Environment-variable consumers require a Pod restart. Updating projected files also does not establish that the application rereads them.  
   Source: [docs/concepts/configuration/configmap.md](docs/concepts/configuration/configmap.md), lines 191–208.

   For reproducible reports, choose versioned immutable ConfigMaps per run. `immutable: true` cannot be reverted, and `data`/`binaryData` cannot change. Deletion and recreation are possible, but existing Pods retain their mount points; recreating those Pods is recommended. This is an operational choice, not automatic per-run configuration snapshotting.  
   Source: same document, lines 299–328.

7. **Memory-pressure eviction differs from scheduler preemption.** After node-level reclamation fails, kubelet ranks Pods first by whether usage exceeds requests, then priority, then usage relative to requests. Consequently, over-request BestEffort/Burstable workloads generally go before Guaranteed/Burstable workloads below requests. QoS class itself is not the ranking input; low batch priority alone does not guarantee batch always goes first.  
   Source: [docs/concepts/scheduling-eviction/node-pressure-eviction.md](docs/concepts/scheduling-eviction/node-pressure-eviction.md), lines 318–342.

   Node-pressure eviction does not honor PDBs or promise the Pod’s configured `terminationGracePeriodSeconds`. Soft eviction uses the configured eviction grace rules; hard eviction uses zero seconds. Even below-request workloads can be evicted when system resource consumption threatens node stability.  
   Source: same document, lines 32–36, 185–206, 345–353.

8. **Restricted enforcement requires compliant workloads and functioning admission.** Configure PodSecurity admission and namespace label `pod-security.kubernetes.io/enforce: restricted`; pin `enforce-version: v1.32` for an explicit policy version. Inspect exemptions before claiming coverage “everywhere.” `enforce` rejects noncompliant Pod creation; `audit` records violations without rejection; `warn` returns warnings without rejection, including for workload templates.  
   Sources: [docs/reference/labels-annotations-taints/_index.md](docs/reference/labels-annotations-taints/_index.md), lines 2369–2448; [docs/tutorials/security/cluster-level-pss.md](docs/tutorials/security/cluster-level-pss.md), lines 190–207.

   Restricted includes Baseline controls and permitted volume types. Require non-root execution and prohibit explicit UID zero. For Linux containers, disable privilege escalation, configure `RuntimeDefault` or `Localhost` seccomp, and drop `ALL` capabilities, adding back only permitted `NET_BIND_SERVICE`. Requirements cover init and ephemeral containers too; one failing container invalidates the Pod. Image compatibility still needs validation.  
   Source: [docs/concepts/security/pod-security-standards.md](docs/concepts/security/pod-security-standards.md), lines 299–451.

9. **Disable unnecessary credential mounting explicitly.** Pods otherwise receive a default ServiceAccount assignment and can use automatically mounted credentials. Set `automountServiceAccountToken: false` on batch ServiceAccounts and in Job Pod templates. The Pod setting overrides the ServiceAccount setting, so the latter alone is not an enforced prohibition.  
   Source: [docs/tasks/configure-pod-container/configure-service-account.md](docs/tasks/configure-pod-container/configure-service-account.md), lines 34–54, 67–100.

   ConfigMap volume/environment consumption uses kubelet-provided data and does not require application API access. Direct API watching is a different design requiring appropriate access. Review explicit credential mounts separately; disabling automount only establishes the documented automount opt-out.  
   Sources: ConfigMap document, lines 97–115; ServiceAccount document, lines 67–100.

10. **Roll out in this priority order:**

   - Resolve exclusivity versus interactive access; test both authorized placement and exclusion, then force interactive preemption and measure release latency (taints, lines 181–191; preemption, lines 187–238).
   - Validate admission prerequisites, quota rejection, Restricted compliance and absent token mounts before enabling enforcement broadly (quota, lines 26–60, 79–87; security labels, lines 2369–2448; ServiceAccount, lines 67–100).
   - Configure schedule zone, overlap policy, lateness, retry/runtime bounds and diagnostic retention; exercise duplicate execution, missed starts and repeated failure (CronJob, lines 109–143, 180–240; Job, lines 360–380, 628–775).
   - Validate application-specific limits: idempotent external effects, checkpoint/restart correctness, ConfigMap reload behavior, and acceptable shutdown latency. Cluster tests must additionally establish capacity and memory-pressure behavior. These documents establish neither report correctness nor completion-time, reload-time or service-recovery guarantees (CronJob, lines 213–217; ConfigMap, lines 191–208; preemption, lines 218–238; node-pressure eviction, lines 32–36).