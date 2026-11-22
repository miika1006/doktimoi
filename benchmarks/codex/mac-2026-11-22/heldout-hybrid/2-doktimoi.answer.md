Approve the design conditionally: configure admission and scheduling controls before rollout, and require application tests for duplicate execution, interruption, and configuration changes. Namespace separation and API fields alone do not establish safe operation.

All source paths below are relative to the supplied local `docs/` directory; citations identify original source line ranges.

1. **CronJob execution is approximate.** A CronJob does **not** guarantee exactly one Job per schedule: duplicates and omissions are possible, so reports must be idempotent. `concurrencyPolicy: Allow` permits overlap; `Forbid` skips an occurrence while the preceding Job remains unfinished; `Replace` replaces the running Job. These policies apply only within one CronJob, not across teams’ CronJobs.  
   Sources: `concepts/workloads/controllers/cron-jobs.md:128–143,211–251`.

   Choose an explicit `.spec.timeZone`, such as `Etc/UTC`; otherwise the controller manager’s local time zone applies. `startingDeadlineSeconds` bounds lateness in **starting**, not execution duration. Unset means no starting deadline; values below ten seconds risk missing scheduling checks. More than 100 missed schedules prevents a start; a configured deadline bounds the counting window. `Forbid` skips count as missed schedules.  
   Sources: `concepts/workloads/controllers/cron-jobs.md:107–126,176–188,211–251`.

2. **Bound retries and elapsed runtime separately.** Job Pods support `restartPolicy: Never` or `OnFailure`. With `Never`, failed Pods are replaced; with `OnFailure`, container restarts also count toward the retry limit. `backoffLimit` normally defaults to six, with exponential retry delays capped at six minutes. Reaching either documented retry calculation fails the Job.  
   Sources: `concepts/workloads/controllers/job.md:358–382,1186–1194`.

   Set `activeDeadlineSeconds` on the **Job**, since the Pod template has a separate field. The Job deadline spans its Pods and takes precedence over remaining retries: expiry terminates running Pods and produces `DeadlineExceeded`. An earlier exhausted backoff limit can already fail the Job. Failed Jobs do not automatically restart. `ttlSecondsAfterFinished` only makes completed or failed Jobs eligible for cascading cleanup; it neither limits runtime nor promises deletion at an exact instant. Retain logs before cleanup.  
   Sources: `concepts/workloads/controllers/job.md:615–663,738–777`.

3. **Combine exclusion with mandatory placement.** Taint batch nodes, for example `dedicated=batch:NoSchedule`, give batch Pods the matching toleration, and require affinity to the corresponding node label. A toleration permits placement but does not confine Pods; required affinity supplies that confinement. Preferred affinity is insufficient. Required affinity’s `IgnoredDuringExecution` also means later label changes do not remove running Pods.  
   Sources: `concepts/scheduling-eviction/taint-and-toleration.md:176–191`; `concepts/scheduling-eviction/assign-pod-node.md:101–125`.

   `NoSchedule` excludes new intolerant Pods but leaves existing ones running. `NoExecute` additionally evicts intolerant residents; matching tolerations can permit indefinite residence or specify `tolerationSeconds`. Prevent unauthorized tolerations and direct `nodeName` assignments: the latter bypass scheduler enforcement of `NoSchedule`. These fields alone are not a tenant security boundary.  
   Source: `concepts/scheduling-eviction/taint-and-toleration.md:29–174`.

4. **Use lower batch priority, while resolving a placement conflict.** Create cluster-scoped PriorityClasses with higher integer priority for interactive services and select them through `priorityClassName`. Consider `preemptionPolicy: Never` for batch so it cannot displace other workloads; it remains preemptible. Interactive classes need `PreemptLowerPriority` to displace batch.  
   Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:33–75,103–147`.

   However, interactive Pods cannot reclaim batch-node capacity unless they are eligible for those nodes. Strict exclusion of all non-batch Pods conflicts with lending that capacity to interactive services; choose explicitly between exclusive nodes and controlled interactive access. Preemption only helps where removing lower-priority Pods makes placement feasible. Victims receive their termination grace period, delaying replacement; PDB protection is best effort and may be violated. Priority therefore supplies no interactive latency guarantee.  
   Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:185–194,214–238`.

5. **Quota controls admission, not reserved capacity.** Explicitly set CPU and memory requests and limits for every container, or provide appropriate LimitRange defaults. This avoids admission failures and makes quota accounting intentional. Choose quota keys explicitly: `cpu`/`memory` mean request totals, while `limits.cpu`/`limits.memory` bound limit totals across non-terminal Pods.  
   Source: `concepts/policy/resource-quotas.md:20–60,89–105`.

   A creation or update violating quota fails with HTTP `403 Forbidden`; exceeding quota does not simply leave an admitted Pod waiting for capacity. New or changed quotas do not affect already-created resources. Namespace quotas can collectively exceed cluster capacity, so quota allowance is no capacity guarantee.  
   Source: `concepts/policy/resource-quotas.md:20–77`.

6. **Choose configuration consistency deliberately.** Ordinary ConfigMap volume projections update eventually. Delay can reach the kubelet sync period plus cache propagation delay, depending on watch, TTL-cache, or direct-fetch configuration. `subPath` mounts receive no updates. Environment variables do not update automatically and require Pod restart. File propagation does not establish that the report application rereads or safely adopts changed settings.  
   Source: `concepts/configuration/configmap.md:191–209`.

   For reproducible runs, prefer a versioned immutable ConfigMap per configuration release. `immutable: true` cannot be reversed, and `data`/`binaryData` cannot be changed. Deleting and recreating it does not transparently refresh existing mounts; the docs recommend recreating referencing Pods.  
   Source: `concepts/configuration/configmap.md:299–328`.

7. **Memory-pressure eviction is different from scheduler preemption.** After unsuccessful node-resource reclamation, kubelet ranks Pods by whether usage exceeds requests, then priority, then usage relative to requests. Above-request BestEffort/Burstable Pods go first; within-request Burstable and Guaranteed Pods go last. QoS is an explanatory approximation, not the ranking input. Even those last groups can be evicted when system consumption exhausts reservations. Low batch priority alone cannot guarantee eviction first.  
   Source: `concepts/scheduling-eviction/node-pressure-eviction.md:318–362`.

   Node-pressure eviction ignores PDBs and the Pod’s configured `terminationGracePeriodSeconds`. Soft thresholds use `eviction-max-pod-grace-period`; hard thresholds use zero grace.  
   Source: `concepts/scheduling-eviction/node-pressure-eviction.md:25–44`.

8. **Restricted requires compliant workloads and active enforcement.** Configure PodSecurity admission and namespace labels `pod-security.kubernetes.io/enforce=restricted` and `enforce-version=v1.32`. Enforcement rejects violating Pods; it does not repair them. Restricted includes Baseline restrictions, permitted volume types, non-root execution, and no explicit UID zero. For Linux, require `allowPrivilegeEscalation: false`, explicit `RuntimeDefault` or `Localhost` seccomp, and dropping `ALL` capabilities, optionally adding only `NET_BIND_SERVICE`. Cover application, init, and ephemeral containers.  
   Sources: `reference/labels-annotations-taints/_index.md:2369–2399`; `concepts/security/pod-security-standards.md:299–520`; `tasks/configure-pod-container/migrate-from-psp.md:49–73`.

   `audit` records violations without forbidding Pods; `warn` returns warnings without blocking, including for workload templates. Verify admission configuration and exemptions before claiming enforcement everywhere, including system namespaces.  
   Sources: `tasks/configure-pod-container/migrate-from-psp.md:49–73,247–272`; `reference/labels-annotations-taints/_index.md:2434–2466`.

9. **Disable unnecessary credential injection.** Assigned ServiceAccounts, including the default account, normally supply automatically rotating, short-lived projected API tokens. Set `automountServiceAccountToken: false` in each Job’s Pod template, and use the same setting on team ServiceAccounts as the default. If both specify it, the Pod setting wins. This controls automatic mounting; inspect manifests for intentionally supplied credentials too.  
   Sources: `concepts/security/service-accounts.md:141–161`; `tasks/configure-pod-container/configure-service-account.md:67–100`.

10. **Prioritize rollout and validation as follows.**

   - First resolve exclusive-node versus interactive-access policy; restrict tenant control of placement and priority, then test eligible and ineligible scheduling. Preemption requires a feasible destination.  
     Sources: `concepts/scheduling-eviction/taint-and-toleration.md:29–150`; `concepts/scheduling-eviction/pod-priority-preemption.md:185–194`.
   - Dry-run Restricted against existing Pods, soak with audit/warn, repair templates, then enforce across the intended namespaces. Verify rejected Pods and disabled credential mounts.  
     Sources: `tasks/configure-pod-container/migrate-from-psp.md:247–272`; `tasks/configure-pod-container/configure-service-account.md:67–100`.
   - Canary quotas, retries, deadlines, TTL retention, configuration delivery, preemption, and memory pressure before expanding deployment. Validate application idempotency, interruption recovery, configuration reload correctness, actual runtime/resource needs, and interactive recovery latency. The cited scheduling, propagation, and eviction behaviors establish **none** of those application-specific limits.  
     Sources: `concepts/workloads/controllers/cron-jobs.md:211–251`; `concepts/configuration/configmap.md:191–209`; `concepts/scheduling-eviction/pod-priority-preemption.md:214–238`; `concepts/scheduling-eviction/node-pressure-eviction.md:25–44`.