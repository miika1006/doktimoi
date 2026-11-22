The design needs revisions before rollout. Kubernetes provides scheduling, admission and cleanup mechanisms, but these do not guarantee exactly-once reports, immediate interactive capacity, or safe application recovery. In particular, exclusive batch nodes conflict with yielding their capacity to interactive services unless those services are also eligible to use them.

All source paths below are relative to the supplied workspace; line ranges refer to the local Kubernetes v1.32 documentation.

1. **CronJob execution is approximate.** A schedule can produce two Jobs or none; reports therefore need application-level idempotency. `concurrencyPolicy: Allow` permits overlap, `Forbid` skips a run while the previous run remains unfinished, and `Replace` replaces the running Job. These policies apply only within one CronJob, not across teams or CronJobs. Choose `Forbid` if overlapping reports are unacceptable, while accepting skipped schedules.

   `startingDeadlineSeconds` bounds lateness of **creation**, not execution duration; an expired occurrence is skipped. More than 100 missed schedules prevents Job creation; when a starting deadline exists, the controller counts misses within that window. `Forbid` skips count as misses. Values below ten seconds may prevent scheduling. Set `.spec.timeZone` explicitly, for example `Etc/UTC`; otherwise the controller manager’s local zone applies.

   Sources: `docs/concepts/workloads/controllers/cron-jobs.md:107–144, 176–188, 211–244`.

2. **Bound retries, execution and retention separately.** Job Pods must use `restartPolicy: Never` or `OnFailure`. With `Never`, failed Pods are replaced; with `OnFailure`, container retries also count toward `backoffLimit`. The ordinary default is six retries, with exponential replacement backoff capped at six minutes.

   Set Job-level `activeDeadlineSeconds` for the maximum execution duration across all its Pods. It takes precedence over remaining retries: reaching it terminates running Pods and fails the Job with `DeadlineExceeded`. Reaching the backoff limit first also fails the Job. Neither mechanism automatically restarts a failed Job.

   `ttlSecondsAfterFinished` instead makes a completed or failed Job eligible for cleanup; cascading deletion removes dependent Pods and honors finalizers. It cannot stop a running Job. Preserve diagnostics before cleanup. Terminal conditions normally wait for Pod termination in v1.32, so deadline expiry is not an exact shutdown-completion bound.

   Sources: `docs/concepts/workloads/controllers/job.md:209–221, 358–382, 615–663, 665–735, 737–770`; `docs/reference/kubernetes-api/workload-resources/job-v1.md:101–107`.

3. **Combine repulsion with mandatory placement.** Taint batch nodes, give batch Pods matching tolerations, and require node affinity matching a batch-node label. Tolerations merely permit placement; without affinity, batch Pods can also use other nodes. Use required affinity, because preferred affinity permits fallback. Required affinity’s `IgnoredDuringExecution` also means later label changes do not remove existing Pods.

   `NoSchedule` blocks new untolerating Pods but leaves existing ones running. `NoExecute` additionally evicts existing untolerating Pods; tolerating Pods can remain indefinitely or for `tolerationSeconds`. Enforce who may add tolerations and direct node assignments: `.spec.nodeName` bypasses scheduler `NoSchedule` checks. These fields alone are not a tenant authorization boundary.

   Sources: `docs/concepts/scheduling-eviction/taint-and-toleration.md:29–150, 176–191`; `docs/concepts/scheduling-eviction/assign-pod-node.md:100–151`.

4. **Give interactive workloads higher priority, with feasible placement.** Create cluster-scoped PriorityClasses and reference them through `priorityClassName`; higher integer values mean higher priority. Configure batch with lower priority and, optionally, `preemptionPolicy: Never`. That prevents batch from preempting others but does not protect batch from higher-priority preemptors. Interactive workloads need `PreemptLowerPriority`, the default, if they should reclaim occupied capacity.

   Preemption works only where removing lower-priority Pods makes the incoming Pod schedulable. Thus, if “other Pods off batch nodes” includes interactive services, evicting batch there cannot help them. Resolve this policy conflict explicitly.

   Victims receive graceful termination time, delaying capacity release. PDB protection is best effort: the scheduler may violate a PDB when necessary.

   Sources: `docs/concepts/scheduling-eviction/pod-priority-preemption.md:51–76, 103–147, 150–193, 214–238`.

5. **Make quota accounting explicit in every container.** Configure `requests.cpu`, `requests.memory`, `limits.cpu` and `limits.memory` according to the intended policy. Request quotas require explicit corresponding requests; limit quotas require corresponding limits. Setting both avoids depending on unspecified defaults. A LimitRange can supply defaults.

   Admission rejects creations or updates exceeding quota with HTTP `403 FORBIDDEN`; an over-quota Pod is not admitted to wait for capacity. Compute quotas aggregate non-terminal Pods. New or changed quotas do not affect already-created resources, including running Pods. Quotas also do not reserve physical capacity: namespace quotas can collectively exceed the cluster.

   Sources: `docs/concepts/policy/resource-quotas.md:21–87, 89–105, 462–469`.

6. **Choose live configuration or a reproducible snapshot.** Ordinary ConfigMap volume projections eventually update. Delay can reach the kubelet sync period plus cache propagation delay; the cache strategy is configurable. This establishes file projection behavior, not whether the report rereads or safely applies changed settings.

   `subPath` mounts receive no updates. Environment-variable consumers require a Pod restart. Immutable ConfigMaps reject data changes and cannot become mutable again; deletion and recreation do not refresh existing mount points reliably enough to avoid recreating Pods. For reproducible nightly reports, prefer a new, versioned immutable ConfigMap name per configuration release and reference it from newly created Pods.

   Sources: `docs/concepts/configuration/configmap.md:191–209, 299–328`; `docs/tutorials/configuration/updating-configuration-via-a-configmap.md:548–565`.

7. **Memory-pressure eviction is not simply lowest-priority-first.** After reclamation attempts fail, the kubelet ranks Pods first by whether usage exceeds requests, then by priority, then by usage relative to requests. BestEffort and Burstable Pods exceeding requests are generally evicted before Pods staying within requests. QoS class itself is not the ranking input; priority alone therefore cannot establish the desired eviction order.

   Node-pressure eviction does not honor PDBs or guarantee the Pod’s configured `terminationGracePeriodSeconds`. Hard thresholds use zero grace. Soft thresholds use kubelet eviction grace configuration, including `eviction-max-pod-grace-period`; configure and test those settings.

   Sources: `docs/concepts/scheduling-eviction/node-pressure-eviction.md:24–36, 185–206, 318–362`.

8. **Enforce Restricted through admission, after checking compatibility.** Label namespaces `pod-security.kubernetes.io/enforce=restricted`; pin `enforce-version=v1.32` for a deliberate policy version. Enforcement prohibits creation of nonconforming Pods. Audit records violations without blocking; warn returns immediate client warnings without blocking.

   Restricted includes Baseline requirements, permitted volume types, non-root execution and no explicit UID zero. For Linux, require `allowPrivilegeEscalation: false`, an explicit `RuntimeDefault` or `Localhost` seccomp profile, and dropping `ALL` capabilities, with only `NET_BIND_SERVICE` eligible for addition. Applicable checks include init and ephemeral containers.

   “Everywhere” requires validating infrastructure too: the supplied tutorial demonstrates system workloads violating Restricted. Namespace labels do not establish universal workload compatibility.

   Sources: `docs/reference/labels-annotations-taints/_index.md:2369–2399`; `docs/tasks/configure-pod-container/migrate-from-psp.md:247–281`; `docs/concepts/security/pod-security-standards.md:313–456, 495–504`; `docs/tutorials/security/cluster-level-pss.md:97–153`.

9. **Disable unnecessary credential automounting explicitly.** The ServiceAccount admission controller normally assigns the namespace’s `default` ServiceAccount when none is specified and injects an API-token volume and container mounts. Set `automountServiceAccountToken: false` in the Job’s Pod template, or on its ServiceAccount. A Pod-level setting takes precedence, so a ServiceAccount default alone cannot prevent overrides. Verify rendered Pods contain no unintended credential mounts; disabling automount is not evidence that application-provided credentials are absent.

   Sources: `docs/reference/access-authn-authz/service-accounts-admin.md:396–421`; `docs/tasks/configure-pod-container/configure-service-account.md:67–100`.

10. **Roll out in this priority order.**

   - First resolve exclusive-node versus interactive-capacity requirements; verify admission prerequisites and control placement-policy overrides.
   - Dry-run Restricted namespace labels, collect audit/warn findings, repair workloads, then enforce. Confirm token automount is disabled.
   - Apply explicit resources, quotas, required affinity, tolerations and PriorityClasses; test quota rejection and feasible preemption.
   - Exercise duplicate schedules, prolonged runs, retry exhaustion, deadline expiry, configuration changes and cleanup before production.

   These checks follow the documented dry-run workflow and the scheduling, quota and lifecycle constraints above. At least four limits remain application or cluster validation obligations: report idempotency, checkpoint/recovery after forced termination, interactive scheduling latency under actual placement constraints, and configuration reload correctness. None is guaranteed by merely setting the reviewed fields.

   Sources: `docs/tasks/configure-pod-container/migrate-from-psp.md:247–281`; `docs/concepts/workloads/controllers/cron-jobs.md:211–244`; `docs/concepts/scheduling-eviction/pod-priority-preemption.md:150–193, 214–238`; `docs/concepts/configuration/configmap.md:191–209`.