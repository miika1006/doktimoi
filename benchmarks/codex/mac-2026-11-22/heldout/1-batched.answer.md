Decision memo: adopt the design only after resolving the conflict between exclusive batch nodes and reclaiming their capacity for interactive services. The documented mechanisms provide controls, but do not establish exactly-once reporting, immediate preemption, or application recovery.

All citations below identify local files under `docs/` and inclusive source line ranges.

1. **CronJob scheduling is approximate.** A CronJob can create two Jobs or none for a schedule; reporting must therefore be idempotent. `concurrencyPolicy: Allow` permits overlap, `Forbid` skips an occurrence while the preceding Job remains active, and `Replace` replaces that Job. These policies apply only within one CronJob. Choose `Forbid` if overlapping reports are unacceptable, while accepting missed occurrences.  
   Sources: `docs/concepts/workloads/controllers/cron-jobs.md:130–143,213–217`.

   `startingDeadlineSeconds` limits how late an occurrence may start; it does not limit execution duration. Unset means no starting deadline. More than 100 missed schedules prevents starting; a configured deadline bounds the missed-schedule counting window. `Forbid` skips count as missed. Values below ten seconds may prevent scheduling. Set `.spec.timeZone` explicitly, for example `Etc/UTC`; otherwise the controller manager’s local zone applies.  
   Source: `docs/concepts/workloads/controllers/cron-jobs.md:109–126,180–186,228–240`.

2. **Bound retries and total duration separately.** Jobs allow `restartPolicy: Never` or `OnFailure`. With `OnFailure`, a failed container restarts locally; with `Never`, its failure can fail the Pod, prompting a replacement Pod. `backoffLimit` defaults to six; failed Pods and, for `OnFailure`, container retries contribute through separate calculations. Reaching either calculation’s limit fails the Job.  
   Sources: `docs/concepts/workloads/controllers/job.md:220–221,318–332,360–374`.

   Set Job-level `activeDeadlineSeconds` for the permitted hours of execution. It covers the whole Job across Pods and takes precedence over remaining retries; reaching it terminates running Pods and produces `DeadlineExceeded`. Retry exhaustion can fail the Job earlier. Neither failure automatically restarts that Job. `ttlSecondsAfterFinished` subsequently makes completed or failed Jobs eligible for cascading cleanup; it neither retries nor bounds running work.  
   Source: `docs/concepts/workloads/controllers/job.md:623–636,658–663,741–750,770–775`.

3. **Use both taints and required node affinity.** Taint batch nodes, give batch Pods matching tolerations, label those nodes, and require that label through `requiredDuringSchedulingIgnoredDuringExecution`. A toleration merely permits placement; it does not confine a Pod to those nodes. Required affinity confines initial placement, whereas preferred affinity permits fallback. Label changes after placement do not evict existing Pods.  
   Sources: `docs/concepts/scheduling-eviction/taint-and-toleration.md:13–20,181–191`; `docs/concepts/scheduling-eviction/assign-pod-node.md:105–118`.

   `NoSchedule` blocks new untolerating Pods but leaves existing ones running. `NoExecute` also evicts untolerating residents; matching tolerations can permit indefinite or time-limited residence. Keeping other teams off requires controlling who can supply tolerations and placement settings; these fields alone do not establish authorization.  
   Source: `docs/concepts/scheduling-eviction/taint-and-toleration.md:99–110`.

4. **Give interactive Pods higher priority, but resolve node eligibility first.** PriorityClasses are cluster-scoped mappings to integer priorities; larger values mean higher priority. Reference a lower class from batch templates. Choosing batch `preemptionPolicy: Never` prevents batch from preempting others, while still allowing higher-priority Pods to preempt batch. Interactive classes need `PreemptLowerPriority`, the default, to initiate preemption.  
   Source: `docs/concepts/scheduling-eviction/pod-priority-preemption.md:53–73,107–127`.

   Preemption seeks a node where removing lower-priority Pods makes the incoming Pod schedulable. Therefore, interactive Pods excluded from batch nodes cannot reclaim their capacity. Either permit explicitly authorized interactive workloads there or accept separate capacity pools. Victims receive graceful termination, delaying replacement scheduling. PodDisruptionBudgets are best effort: preemption can violate them.  
   Source: `docs/concepts/scheduling-eviction/pod-priority-preemption.md:187–194,218–238`.

5. **Quota is admission control, not reserved capacity.** Request quotas require every incoming container to specify corresponding requests; limit quotas require corresponding limits. `cpu` and `memory` alias request quotas. Configure both requests and limits explicitly, or supply deliberate defaults. An operation exceeding quota is rejected with HTTP 403; the excess Pod is not merely admitted pending capacity. Quota changes do not affect already-created resources, including running Pods. Aggregate quotas can exceed cluster capacity, creating contention. Verify ResourceQuota admission is enabled.  
   Source: `docs/concepts/policy/resource-quotas.md:36–41,74–87,99–105,464–469`.

6. **Choose configuration consistency deliberately.** Ordinary ConfigMap volume projections update eventually. Delay can reach the kubelet sync period plus cache propagation delay; watch, TTL cache, and direct API access differ. Environment-variable consumers require Pod restart. `subPath` mounts receive no updates. These projection guarantees do not establish that the report process rereads files or safely adopts changes mid-run.  
   Source: `docs/concepts/configuration/configmap.md:191–208`.

   For reproducible reports, prefer a distinct immutable ConfigMap per configuration version and reference that version from subsequent runs. `immutable: true` cannot be reversed, and its data cannot be edited. Deleting and recreating requires care: existing Pods retain their old mount points, so the docs recommend recreating them.  
   Source: `docs/concepts/configuration/configmap.md:303–312,325–328`.

7. **Memory-pressure eviction is not simply “lowest priority first.”** After unsuccessful node-resource reclamation, kubelet ranks Pods by whether usage exceeds requests, then priority, then usage relative to requests. BestEffort and over-request Burstable Pods are evicted before Guaranteed and below-request Burstable Pods. QoS class itself is not the ranking input. Consequently, low batch priority alone does not guarantee batch is always the first victim.  
   Source: `docs/concepts/scheduling-eviction/node-pressure-eviction.md:318–342`.

   Node-pressure eviction does not honor PDBs or the Pod’s configured `terminationGracePeriodSeconds`. Soft eviction uses kubelet eviction grace configuration; hard thresholds cause immediate termination with zero grace. Recovery must tolerate abrupt loss.  
   Source: `docs/concepts/scheduling-eviction/node-pressure-eviction.md:26–36,185–197`.

8. **Restricted enforcement requires compliant workloads, not just labels.** Set namespace `pod-security.kubernetes.io/enforce=restricted`, with `enforce-version=v1.32` for an explicit policy version. PodSecurity admission must operate. Noncompliant Pod creation is prohibited. Restricted incorporates Baseline and restricts volumes; ConfigMap volumes are allowed. All relevant containers, including init and ephemeral containers, must comply.  
   Sources: `docs/reference/access-authn-authz/admission-controllers.md:119–130`; `docs/reference/labels-annotations-taints/_index.md:2369–2396`; `docs/concepts/security/pod-security-standards.md:306–341`.

   Require non-root execution and prohibit UID zero. For Linux, disable privilege escalation, specify `RuntimeDefault` or `Localhost` seccomp, and drop `ALL` capabilities, adding back only `NET_BIND_SERVICE` if needed. `audit` records violations without blocking; `warn` returns warnings without blocking, including for Job templates. “Everywhere” needs infrastructure validation: the supplied tutorial shows system workloads violating Restricted.  
   Sources: `docs/concepts/security/pod-security-standards.md:345–451`; `docs/tasks/configure-pod-container/migrate-from-psp.md:262–265`; `docs/reference/labels-annotations-taints/_index.md:2434–2448`; `docs/tutorials/security/cluster-level-pss.md:133–147`.

9. **Disable unnecessary token automounting explicitly.** Pods receive the namespace’s default ServiceAccount if none is specified. Credential mounting is default behavior. Set `automountServiceAccountToken: false` in the Job’s Pod template, or on its ServiceAccount; the Pod setting wins when both exist. Adopt both a ServiceAccount default and explicit batch-template settings. This disables automatic mounting, not every possible credential source; inspect manifests for explicitly supplied credentials.  
   Source: `docs/tasks/configure-pod-container/configure-service-account.md:34–41,67–100`.

10. **Roll out in this priority order.**

   - First, decide whether interactive workloads may use batch nodes; validate placement and preemption under saturation. Exclusive exclusion and reclaiming that same capacity conflict (sources in answers 3–4).
   - Next, verify admission prerequisites, quota defaults, and token settings. Dry-run Restricted labels, soak in audit/warn, repair templates and infrastructure, then enforce. The docs explicitly recommend dry-run evaluation and observation before enforcement (`docs/tasks/configure-pod-container/migrate-from-psp.md:247–280`).
   - Then set schedule zone, overlap policy, starting deadline, retry limit, execution deadline, configuration versioning, and cleanup retention. Exercise duplicate starts, failures, long runs, quota rejection, configuration edits, preemption, and memory pressure against the documented behavior above.

   At least four limits remain empirical: application idempotency and recovery, safe configuration reload, interactive scheduling latency after victim termination, and sufficient capacity under realistic resource usage. The documents establish mechanisms and caveats; they do not establish these application properties or this cluster’s performance (sources in answers 1–2, 4–7).