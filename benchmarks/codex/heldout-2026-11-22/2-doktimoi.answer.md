Decision memo: adopt the design with explicit failure policies and a resolved capacity model. Kubernetes provides scheduling, admission and cleanup mechanisms; these documents do not establish exactly-once reporting or bounded service recovery.

All citations below are local paths relative to `/var/folders/3t/t35161bs2slggt46tnrk0b4c0000gn/T/doktimoi-bench-2-doktimoi-UDtfSF/docs`.

1. **CronJob execution is approximate.** A schedule can produce two Jobs or none; reports therefore need application-level idempotency. `concurrencyPolicy: Allow` permits overlap; `Forbid` skips a run while the previous run remains unfinished; `Replace` replaces the unfinished run. These policies cover only Jobs from the same CronJob.

   Choose `Forbid` if overlapping reports are undesirable, and set an explicit lateness allowance with `startingDeadlineSeconds`. After that deadline, the occurrence is skipped; unset means no deadline. More than 100 missed schedules prevents starting a Job. With a starting deadline, missed schedules are counted within that window; otherwise, since the last scheduled time. `Forbid` skips count as missed. Values below ten seconds risk never scheduling because the controller checks every ten seconds. Set `.spec.timeZone`, preferably an agreed zone such as `Etc/UTC`; otherwise the controller-manager’s local zone applies.

   Sources: `concepts/workloads/controllers/cron-jobs.md:107–143,176–188,211–244`.

2. **Bound retries and runtime separately.** Jobs support `restartPolicy: Never` or `OnFailure`. `Never` lets failed Pods be replaced; `OnFailure` permits container restarts within Pods. `backoffLimit` defaults to six; retries use exponential delays capped at six minutes. Failure counting includes failed Pods and, with `OnFailure`, container retries in Pending or Running Pods; either calculation reaching the limit fails the Job.

   Set Job-level `activeDeadlineSeconds` to cap the overall active duration across Pods. It takes precedence over remaining retries: reaching it terminates running Pods and produces `DeadlineExceeded`. Backoff exhaustion can fail the Job earlier. Neither mechanism automatically restarts a failed Job. `ttlSecondsAfterFinished` controls later cleanup, not execution: after success or failure, expiry makes the Job eligible for cascading deletion, honoring finalizers.

   Sources: `concepts/workloads/controllers/job.md:358–382,615–700,737–779,1186–1194`.

3. **Use both exclusion and placement constraints.** Taint batch nodes, for example `dedicated=batch:NoSchedule`, and give batch Pods a matching toleration. That excludes untolerating Pods but does not confine batch Pods. Also label those nodes and require matching node affinity. Use `requiredDuringSchedulingIgnoredDuringExecution`; preferred affinity permits fallback elsewhere. Label changes after scheduling do not move existing Pods.

   `NoSchedule` blocks new untolerating placements but leaves existing Pods running. `NoExecute` also evicts existing untolerating Pods; matching tolerations can allow indefinite residence or a specified `tolerationSeconds`. Controlling who can submit tolerations and alter labels remains a platform prerequisite.

   Sources: `concepts/scheduling-eviction/taint-and-toleration.md:101–150,176–191`; `concepts/scheduling-eviction/assign-pod-node.md:103–125`.

4. **Priority requires eligible shared capacity.** Create cluster-scoped PriorityClasses, assign batch a lower integer value and interactive services a higher one, and reference them through `priorityClassName`. Give interactive workloads `PreemptLowerPriority`; consider `Never` for batch to prevent it preempting other workloads. `Never` still permits higher-priority Pods to preempt batch.

   Preemption removes lower-priority Pods only where doing so enables the pending Pod to schedule. Consequently, strict batch-node exclusivity conflicts with interactive use of that capacity: interactive Pods need explicit permission to use those nodes, or separate reserved capacity. Priority cannot overcome placement constraints.

   Victims receive their graceful termination period, delaying replacement scheduling. PDB compliance is best effort: preemption can violate a PDB when suitable alternative victims are unavailable.

   Sources: `concepts/scheduling-eviction/pod-priority-preemption.md:32–74,103–134,178–238`.

5. **Quotas constrain admission, not existing workloads.** Verify ResourceQuota admission is enabled and create a quota in each namespace. CPU and memory quotas require corresponding resource declarations; missing declarations may cause rejection. Configure explicit requests and limits for every container, with LimitRange defaults where appropriate. Distinguish quota keys: `cpu` and `memory` alias requests, while `limits.cpu` and `limits.memory` constrain aggregate limits across nonterminal Pods.

   A creation or update exceeding quota fails with HTTP `403 Forbidden`; the over-quota Pod is not admitted. Introducing or changing quota does not affect already-created resources. Quotas also do not guarantee physical capacity: aggregate namespace allowances can exceed the cluster.

   Sources: `concepts/policy/resource-quotas.md:20–105`.

6. **ConfigMap delivery depends on consumption.** Ordinary mounted ConfigMap volumes eventually receive projected updates. Delay can reach the kubelet sync period plus cache propagation delay; watch is the default detection strategy, with TTL caching and direct API access alternatives. That guarantees eventual projection, not application reload or a consistent configuration throughout a report.

   `subPath` mounts receive no ConfigMap updates. Environment variables do not update automatically and require Pod restart. Immutable ConfigMaps cannot have immutability reversed or their `data`/`binaryData` changed. Use a new versioned ConfigMap and recreate consumers; deleting and recreating the original does not refresh existing mount points reliably enough to avoid the documented recommendation to recreate Pods.

   Sources: `concepts/configuration/configmap.md:191–209,299–328`.

7. **Memory-pressure eviction is not simply lowest priority first.** After node-level reclamation fails, kubelet ranks Pods first by whether usage exceeds requests, then priority, then usage relative to requests. BestEffort and Burstable Pods exceeding requests are evicted before Guaranteed and Burstable Pods below requests. QoS is an approximation of this ordering, not the actual sorting input. Low batch priority alone therefore cannot ensure batch always leaves first.

   Node-pressure eviction ignores PDBs and the Pod’s configured `terminationGracePeriodSeconds`. Soft thresholds use the configured `eviction-max-pod-grace-period`; hard thresholds use zero seconds. Reports must tolerate abrupt termination.

   Sources: `concepts/scheduling-eviction/node-pressure-eviction.md:21–36,318–352`.

8. **Restricted enforcement requires compliant Pod specifications.** Verify PodSecurity admission and label every intended namespace `pod-security.kubernetes.io/enforce=restricted`; pin `enforce-version=v1.32` for predictable policy interpretation.

   Restricted includes all Baseline controls and limits volume types, while permitting ConfigMap volumes. Require nonroot execution and prohibit explicit UID zero. For Linux, disable privilege escalation, explicitly select `RuntimeDefault` or `Localhost` seccomp, drop `ALL` capabilities, and add back at most `NET_BIND_SERVICE`. Requirements cover applicable regular, init and ephemeral containers; one failing container invalidates the Pod. Windows has documented exceptions for privilege escalation, seccomp and capabilities.

   Enforce rejects noncompliant Pod creation. Audit records violations without blocking; warn returns warnings without blocking, including for workload templates. These are validation mechanisms, not automatic repairs or proof that an application works under the restrictions.

   Sources: `reference/access-authn-authz/admission-controllers.md:714–728`; `reference/labels-annotations-taints/_index.md:2369–2451`; `concepts/security/pod-security-standards.md:299–456,500–504`; `tasks/configure-pod-container/migrate-from-psp.md:247–272`.

9. **Disable unnecessary credential automounting explicitly.** Pods receive the namespace’s default ServiceAccount when none is specified, and applications can use automatically mounted credentials. Set `automountServiceAccountToken: false` in the CronJob’s Pod template. Also set it on team ServiceAccounts as a default; the Pod setting takes precedence when both specify a value.

   This disables automatic credential mounting. It does not establish that a Pod lacks every possible manually supplied credential. Restricted policy alone is insufficient: projected and Secret volumes are permitted.

   Sources: `tasks/configure-pod-container/configure-service-account.md:32–100`; `concepts/security/pod-security-standards.md:323–345`.

10. **Roll out in this priority order.**

   - Resolve exclusivity versus interactive access first; validate placement and preemption with representative competing Pods.
   - Establish resource declarations, namespace quotas and credential defaults; verify missing-resource and over-quota rejections and inspect resulting Pod mounts.
   - Run Restricted audit/warn through a nightly cycle, dry-run enforcement, repair violations, then enforce across intended namespaces.
   - Configure time zone, overlap policy, retry/runtime limits and retention. Inject failures, delayed schedules and termination before production.
   - Test ConfigMap updates through each actual consumption path and exercise memory-pressure recovery.

   These checks follow the documented admission, scheduling and lifecycle boundaries above, including the security rollout procedure in `tasks/configure-pod-container/migrate-from-psp.md:247–272`.

   At least four limits still require validation: report idempotency and output correctness; application configuration reload behavior; acceptable preemption/recovery latency; and realistic memory requests, capacity and pressure thresholds. The documents describe mechanisms, but guarantee none of those application or cluster outcomes.