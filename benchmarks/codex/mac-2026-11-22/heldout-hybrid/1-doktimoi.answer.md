**Decision memo — Kubernetes v1.32 batch platform**

Proceed after resolving the conflict between exclusive batch nodes and yielding capacity to interactive services. The documented controls support this platform, but do not guarantee exactly-once reporting, timely completion, or application recovery. All source paths below are relative to the supplied `docs` directory.

1. **CronJob delivery is approximate.** A schedule can produce two Jobs or none; reports must be idempotent. `concurrencyPolicy: Allow` permits overlap; `Forbid` skips an occurrence while the preceding Job runs; `Replace` replaces that running Job. This policy covers only Jobs from the same CronJob. Choose `Forbid` if overlapping reports are undesirable, while accepting skipped occurrences.

   `startingDeadlineSeconds` bounds how late an occurrence may start, not its runtime. Unset means no start deadline; values below ten seconds may prevent scheduling. More than 100 missed schedules prevents a start. Counting normally begins at the last scheduled time, or within the deadline window when configured; concurrency-blocked occurrences count as missed. Set `.spec.timeZone`, preferably `Etc/UTC`; otherwise the controller manager’s local zone applies.

   Sources: `concepts/workloads/controllers/cron-jobs.md:107-147`, `:176-188`, `:211-251`.

2. **Bound retries and total Job duration separately.** Job Pods permit only `Never` or `OnFailure`. With `OnFailure`, failed containers restart locally; with `Never`, container failure fails the Pod and the Job controller creates replacements. Applications must tolerate either restart path and incomplete prior output.

   `backoffLimit` defaults to six; replacement delays increase exponentially, capped at six minutes. Failed Pods and, with `OnFailure`, container retries contribute through separate calculations; either reaching the limit fails the Job. Job-level `activeDeadlineSeconds` bounds duration across Pods and takes precedence: retries stop at the deadline even with retry budget remaining. Either failure mechanism permanently fails that Job.

   `ttlSecondsAfterFinished` only makes completed or failed Jobs eligible for cascading cleanup. It does not limit runtime. Termination grace can delay actual termination and terminal status beyond the deadline.

   Sources: `concepts/workloads/controllers/job.md:215-224`, `:316-344`, `:358-381`, `:621-636`, `:660-663`, `:703-714`, `:738-775`.

3. **Combine exclusion with required placement.** Taint batch nodes, for example `dedicated=batch:NoSchedule`, and give batch Pods matching tolerations. Also label those nodes and require matching node affinity. A toleration permits placement; it neither attracts the Pod nor restricts it to those nodes. Required affinity supplies that restriction.

   `NoSchedule` blocks new non-tolerating Pods but leaves existing residents. `NoExecute` also evicts non-tolerating residents; matching tolerations can permit indefinite residence or use `tolerationSeconds`. Reserve batch tolerations for authorized workloads. These mechanisms alone are not a complete tenancy boundary: explicitly setting `nodeName` bypasses scheduler handling of `NoSchedule`.

   Sources: `concepts/scheduling-eviction/taint-and-toleration.md:12-24`, `:64-71`, `:94-116`, `:176-191`.

4. **Give interactive Pods higher priority, but resolve placement first.** A cluster-scoped `PriorityClass` maps a name to an integer; higher values mean higher priority. Set `priorityClassName` in workload templates. Choose lower batch priority and optionally `preemptionPolicy: Never`, which stops batch Pods preempting others without protecting batch from higher-priority preemptors. Interactive classes need `PreemptLowerPriority`, the default, to initiate preemption.

   Preemption removes lower-priority Pods only where removal enables the incoming Pod to fit. Therefore, if interactive Pods cannot use batch nodes, evicting batch there cannot help them. Choose either strict exclusivity or explicitly authorized interactive access to that pool.

   Victims receive their termination grace period, delaying capacity release. PDB compliance is best effort; preemption can violate PDBs.

   Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:51-74`, `:103-127`, `:178-195`, `:214-238`; `concepts/scheduling-eviction/taint-and-toleration.md:176-191`.

5. **Quota is admission control, not reserved capacity.** Verify the `ResourceQuota` admission plugin is enabled. Request quotas require every incoming container to specify the corresponding requests; limit quotas require corresponding limits. Supply explicit CPU/memory requests and limits, or suitable admission defaults. CPU and memory sums cover non-terminal Pods.

   A creation or update exceeding quota fails with HTTP `403 Forbidden`; the excess Pod is rejected rather than merely queued for capacity. New or changed quotas do not affect already-created resources. Quotas are independent of physical capacity and impose no node restrictions.

   Sources: `concepts/policy/resource-quotas.md:24-41`, `:48-77`, `:79-105`, `:463-470`, `:595-613`.

6. **Choose configuration consistency deliberately.** Ordinary ConfigMap volume projections update eventually. Delay can reach the kubelet sync period plus cache propagation delay; watch-based propagation is the default. This establishes file projection behavior, not application reload behavior.

   `subPath` mounts receive no ConfigMap updates. Environment variables do not update automatically and require Pod restart. Thus, editing a shared ConfigMap does not establish that every running report uses identical settings.

   Immutable ConfigMaps prohibit subsequent `data` or `binaryData` changes and cannot become mutable again. Replacement requires deletion/recreation or a different ConfigMap; existing mounts persist, so recreate affected Pods. For reproducible reports, choose separately named immutable configuration versions per run.

   Sources: `concepts/configuration/configmap.md:191-209`, `:299-329`; `tutorials/configuration/updating-configuration-via-a-configmap.md:723-734`.

7. **Memory-pressure eviction is not priority alone.** After unsuccessful node-level reclamation, kubelet ranks Pods by whether usage exceeds requests, then priority, then usage relative to requests. BestEffort/Burstable Pods exceeding requests go first; Guaranteed and below-request Burstable Pods go last. QoS labels themselves are not the sorting mechanism. System-daemon overconsumption can ultimately force eviction even of below-request Pods.

   Node-pressure eviction ignores PDBs and Pod `terminationGracePeriodSeconds`. Soft thresholds use configured `eviction-max-pod-grace-period`; hard thresholds use zero seconds. Low batch priority therefore does not guarantee batch always dies before interactive workloads.

   Sources: `concepts/scheduling-eviction/node-pressure-eviction.md:24-36`, `:318-354`.

8. **Enforce Restricted through admission, after compatibility checks.** Configure Pod Security admission and namespace label `pod-security.kubernetes.io/enforce=restricted`; pin `enforce-version=v1.32` for predictable policy selection. Restricted includes Baseline and constrains every applicable container, including init and ephemeral containers.

   Requirements include approved volume types; non-root execution; no explicit UID zero; and, for Linux, `allowPrivilegeEscalation: false`, explicit `RuntimeDefault` or `Localhost` seccomp, and dropping `ALL` capabilities with only `NET_BIND_SERVICE` permitted back. ConfigMap volumes are allowed.

   Enforce rejects violating Pod creation. Audit records violations without blocking; warn returns warnings without blocking. These modes do not repair manifests. Audit admission exemptions and system-workload compatibility before claiming Restricted “everywhere.”

   Sources: `concepts/security/pod-security-standards.md:299-455`, `:500-504`; `reference/labels-annotations-taints/_index.md:2369-2468`; `tasks/configure-pod-container/migrate-from-psp.md:247-272`; `tutorials/security/cluster-level-pss.md:159-214`.

9. **Disable unnecessary credential injection.** Kubernetes normally mounts credentials for the assigned ServiceAccount, including the default account. In this version, these are short-lived, automatically rotating tokens obtained through TokenRequest and mounted as projected volumes.

   Set `automountServiceAccountToken: false` in Job Pod templates, or on the assigned ServiceAccount. Pod configuration takes precedence when both specify a value. This disables automatic credential mounting; it is not evidence that no separately supplied credential exists.

   Sources: `concepts/security/service-accounts.md:141-156`; `tasks/configure-pod-container/configure-service-account.md:67-100`.

10. **Roll out in this priority order.**

   - Resolve interactive access to batch capacity; validate actual affinity, tolerations, and preemption eligibility before promising yielding behavior.
   - Establish quota admission, resource declarations, priority classes, token opt-out, and Restricted-compatible templates.
   - Protect namespace-label permissions. Run server-side policy dry-runs, then audit/warn through a representative workload cycle before enforcing; cover newly created namespaces and review exemptions.
   - Exercise duplicate execution, retry exhaustion, deadline expiry, preemption, hard memory pressure, quota rejection, configuration changes, and TTL cleanup in staging.

   Acceptance requires application or cluster validation of **at least four undocumented outcomes**: duplicate-safe report commits; recovery/checkpoint correctness after interruption; configuration reload and per-run consistency; and completion/interactive latency under measured capacity and eviction settings. The documents establish mechanisms, not these outcomes.

   Sources: `tasks/configure-pod-container/migrate-from-psp.md:79-89`, `:247-282`, `:309-320`; `concepts/workloads/controllers/job.md:316-344`; `concepts/configuration/configmap.md:191-209`; `concepts/scheduling-eviction/node-pressure-eviction.md:466-490`; preemption sources in answer 4.