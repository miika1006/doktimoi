**Decision memo — Kubernetes v1.32 batch platform**

Approve a staged rollout after resolving the conflict between exclusive batch nodes and interactive capacity reclamation. Kubernetes supplies scheduling and admission mechanisms, but these documents do not establish exactly-once reporting, uninterrupted execution, immediate configuration reload, or an interactive-service latency guarantee.

All citations below identify local files relative to the supplied `docs/` directory, followed by inclusive source line ranges.

1. **CronJob execution is approximate.** A schedule can produce two Jobs or none; reports must therefore be idempotent. `concurrencyPolicy: Allow` permits overlap; `Forbid` skips an occurrence while the previous Job remains unfinished, although a delayed run can still qualify under its starting deadline; `Replace` replaces the current run. These policies cover only Jobs belonging to that CronJob. Choose `Forbid` if overlapping reports are undesirable, without treating it as an exactly-once guarantee.  
   Sources: `concepts/workloads/controllers/cron-jobs.md:130–143, 213–217`.

   `startingDeadlineSeconds` limits lateness in **starting**, not execution duration. Unset means no starting deadline. More than 100 missed schedules prevents a start; with a deadline, counting uses that recent window. A `Forbid` skip counts as missed, and deadlines below ten seconds may prevent scheduling. Set `.spec.timeZone` explicitly, such as `Etc/UTC`; otherwise the controller-manager’s local zone applies.  
   Source: `concepts/workloads/controllers/cron-jobs.md:109–126, 180–188, 227–240`.

2. **Bound retries and elapsed runtime separately.** With `restartPolicy: OnFailure`, failed containers restart within their Pod; with `Never`, a container failure can fail the Pod and the Job controller creates a replacement. The application must tolerate either restart pattern, including incomplete output and locks. `backoffLimit` defaults to six, with exponential retry delays; accounting includes failed Pods and, for `OnFailure`, container retries in pending/running Pods.  
   Source: `concepts/workloads/controllers/job.md:318–342, 360–374`.

   Configure Job-level `activeDeadlineSeconds` for the hours-long runtime budget. It spans all Pods and **takes precedence over `backoffLimit`**: expiry terminates running Pods and prevents further retries even if retry allowance remains. Backoff exhaustion can fail the Job earlier. Neither failure automatically restarts that Job. `ttlSecondsAfterFinished` instead makes completed or failed Jobs eligible for cascading cleanup after the TTL; it does not limit execution. Termination grace can delay actual completion.  
   Source: `concepts/workloads/controllers/job.md:623–636, 660–663, 708–711, 737–775`.

3. **Combine repulsion with a placement requirement.** Taint batch nodes, for example `dedicated=batch:NoSchedule`, give batch Pods the matching toleration, and require the matching node label through `requiredDuringSchedulingIgnoredDuringExecution` affinity. Toleration permits placement but neither forces it nor guarantees scheduling. Required affinity confines batch placement; preferred affinity does not. Keep unauthorized tolerations out of other workloads through controlled admission.  
   Sources: `concepts/scheduling-eviction/taint-and-toleration.md:13–25, 181–191`; `concepts/scheduling-eviction/assign-pod-node.md:103–118`.

   `NoSchedule` leaves existing Pods running. `NoExecute` also evicts existing non-tolerating Pods; tolerations can allow indefinite residence or use `tolerationSeconds`. Affinity label changes do not evict already scheduled Pods. Therefore, migrating existing workloads requires an explicit plan.  
   Sources: `concepts/scheduling-eviction/taint-and-toleration.md:99–110`; `concepts/scheduling-eviction/assign-pod-node.md:116–118`.

4. **Use lower batch priority, but reconcile node eligibility first.** Create cluster-scoped PriorityClasses with higher integer priority for interactive services and reference them using `priorityClassName`. Choose batch `preemptionPolicy: Never` if batch must not evict others; this does not protect batch from higher-priority preemption. Interactive classes need `PreemptLowerPriority` to reclaim capacity.  
   Source: `concepts/scheduling-eviction/pod-priority-preemption.md:51–57, 103–127, 151–154`.

   Preemption removes lower-priority Pods only where doing so makes the incoming Pod schedulable. Consequently, strictly excluding interactive Pods from batch nodes prevents them reclaiming that capacity. Choose exclusive capacity or explicitly permitted interactive overflow. Victims receive graceful termination, delaying replacement; PDB compliance is best effort and budgets may be violated. Priority therefore provides no immediate-start guarantee.  
   Source: `concepts/scheduling-eviction/pod-priority-preemption.md:187–194, 218–238`.

5. **Quotas constrain admission, not available capacity.** Specify CPU and memory requests and limits explicitly for every container. Request quotas require corresponding requests; limit quotas require corresponding limits. `cpu` and `memory` quota names mean request totals, while `limits.cpu` and `limits.memory` constrain limit totals across non-terminal Pods. Defaulting through LimitRanger is a configuration option.  
   Source: `concepts/policy/resource-quotas.md:39–53, 99–105, 464–469`.

   Creation or updates violating quota fail with HTTP 403; the excess Pod is not admitted. A new or changed quota does not evict already created resources. Quotas can collectively exceed cluster capacity, so namespace allowance does not establish schedulability.  
   Source: `concepts/policy/resource-quotas.md:31–37, 74–77`.

6. **Choose explicit configuration semantics for each report.** Ordinary ConfigMap volume projections eventually update. Delay can reach the kubelet sync period plus cache propagation delay; watch, TTL cache, or direct retrieval affects that delay. This guarantees projected-file updates, not that report code rereads or consistently applies them. `subPath` mounts receive no updates. Environment variables do not update automatically and require Pod restart.  
   Source: `concepts/configuration/configmap.md:191–208`.

   `immutable: true` prevents data changes and cannot be reversed. Deletion/recreation is possible, but existing Pods retain their mount point and recreation is recommended. For repeatable reports, choose versioned immutable ConfigMaps and explicitly update future Job templates; validate application behavior rather than assuming one configuration snapshot throughout mutable-volume execution.  
   Source: `concepts/configuration/configmap.md:299–328`.

7. **Memory-pressure eviction is not simply “lowest priority first.”** After node-level reclamation fails, kubelet ranks Pods by whether usage exceeds requests, then priority, then usage relative to requests. BestEffort/Burstable Pods exceeding requests generally go first; Pods within requests go last. QoS class itself is not the ranking input. Thus low batch priority alone does not ensure batch always precedes an over-request interactive Pod.  
   Source: `concepts/scheduling-eviction/node-pressure-eviction.md:318–342`.

   Node-pressure eviction ignores PDBs and the Pod’s configured `terminationGracePeriodSeconds`. Soft thresholds use kubelet eviction-grace configuration; hard thresholds terminate immediately with zero grace. Validate recovery from abrupt termination.  
   Source: `concepts/scheduling-eviction/node-pressure-eviction.md:26–36, 185–211`.

8. **Restricted requires compliant workloads and working admission.** Configure namespace `pod-security.kubernetes.io/enforce=restricted`, preferably pinning `enforce-version=v1.32`. PodSecurity validates new Pods; a namespace label is not evidence that existing workloads were repaired. Restricted includes every Baseline control and permits only listed volume types, including ConfigMap volumes. All applicable containers, including init and ephemeral containers, must comply.  
   Sources: `reference/access-authn-authz/admission-controllers.md:714–723`; `reference/labels-annotations-taints/_index.md:2369–2396`; `concepts/security/pod-security-standards.md:299–341`.

   Require non-root execution, prohibit UID zero, and, for Linux, disable privilege escalation, specify `RuntimeDefault` or `Localhost` seccomp, and drop `ALL` capabilities, adding back only `NET_BIND_SERVICE` if needed. Enforce rejects violations; audit records them without blocking; warn returns warnings, including for Job templates.  
   Sources: `concepts/security/pod-security-standards.md:345–450`; `tasks/configure-pod-container/migrate-from-psp.md:262–265`; `reference/labels-annotations-taints/_index.md:2377–2380, 2442–2448`.

9. **Disable unnecessary token automounting.** Pods otherwise receive the namespace’s default ServiceAccount when none is specified and can use automatically mounted credentials. Set `automountServiceAccountToken: false` in Job Pod templates and on their ServiceAccounts as a default. The Pod setting takes precedence, so validate overrides and explicit credential mounts. Automount opt-out controls automatic mounting; it does not establish that an application has no other credentials.  
   Source: `tasks/configure-pod-container/configure-service-account.md:38–58, 67–100`.

10. **Prioritize rollout and validation in this order.**

   - **First, resolve capacity policy:** choose exclusive nodes or interactive overflow; test affinity, taints, tolerations, priorities, and actual preemption eligibility. Sources: `concepts/scheduling-eviction/taint-and-toleration.md:181–191`; `concepts/scheduling-eviction/pod-priority-preemption.md:187–194`.
   - **Next, validate admission:** supply resource declarations, disable token automounting, dry-run Restricted against existing Pods, then soak audit/warn before enforcing. Sources: `concepts/policy/resource-quotas.md:467–469`; `tasks/configure-pod-container/configure-service-account.md:67–100`; `tasks/configure-pod-container/migrate-from-psp.md:247–280`.
   - **Then, exercise failures:** test duplicate execution, retries, deadline expiry, quota exhaustion, configuration edits, preemption, and memory pressure. Preserve diagnostics before TTL cleanup. Sources: `concepts/workloads/controllers/job.md:318–342, 617–636, 741–775`; `concepts/configuration/configmap.md:191–208`; `concepts/scheduling-eviction/node-pressure-eviction.md:26–36`.

   Remaining validation limits include duplicate-safe output publication, acceptable configuration reload behavior, interactive recovery latency, realistic memory requests, and abrupt-termination recovery. The cited mechanisms do not guarantee these application and cluster outcomes.