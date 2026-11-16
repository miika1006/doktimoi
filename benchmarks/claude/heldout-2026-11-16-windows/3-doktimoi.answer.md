# Decision memo: shared-cluster batch platform (Kubernetes v1.32)

**Sources.** Everything below comes from the local corpus under `docs/`. Each point is marked as one of four kinds: **[G]** a documented guarantee, **[C]** a configuration choice, **[P]** a prerequisite, or **[U]** something these documents do not establish. I could not find a Pod Security Admission concept page in the corpus, so the Pod Security mode semantics come from the task and tutorial pages cited in Q8.

**Bottom line.** The design can be built, but none of its goals is guaranteed just because an API field exists. In particular, CronJob scheduling is approximate, PodDisruptionBudgets are only best effort during preemption, and node-pressure eviction ignores both PDBs and the configured termination grace period.

---

### 1. CronJob: is there exactly one Job per schedule?
No. **[G]** A CronJob creates a Job "approximately once per execution time"; sometimes it creates two Jobs or none, so Jobs "should be _idempotent_" (`concepts/workloads/controllers/cron-jobs.md:211-218`). With `startingDeadlineSeconds` unset or large and `concurrencyPolicy: Allow`, a Job runs "at least once" (`:224-226`). In v1.32 each Job carries the `batch.kubernetes.io/cronjob-scheduled-timestamp` annotation (`:219-221`), which can serve as a deduplication key.

- **concurrencyPolicy [C]:** `Allow` is the default. `Forbid` skips a new run while the previous one is still running, but `startingDeadlineSeconds` can still trigger a run after the previous one finishes. `Replace` replaces the running Job. The policy applies only to Jobs from the same CronJob (`cron-jobs.md:128-143`). Because these runs can last for hours, `Forbid` is the safer choice. `Replace` would kill hours of work.
- **startingDeadlineSeconds [C]:** If a run misses this deadline, it is skipped and counted as failed. If the field is unset, there is no deadline (`:107-126`). A value under 10 s may never schedule, because the controller checks every 10 s (`:228-230`).
- **Missed schedules [G]:** If more than 100 schedules were missed, the controller does not start the Job. With a deadline set, it counts misses only within that deadline window. A run skipped under `Forbid` counts as missed (`:233-244`).
- **Time zone [C/P]:** Without `.spec.timeZone`, the schedule uses the kube-controller-manager's local time zone (`cron-jobs.md:176-188`). If the zone name becomes invalid, the controller stops creating Jobs and emits `UnknownTimeZone` (`reference/kubernetes-api/workload-resources/cron-job-v1.md:57-90`). Set the zone explicitly, for example `Etc/UTC`.

### 2. Job failure and time limits
- **backoffLimit [G]:** Defaults to 6. Failed Pods are recreated with exponential back-off (10 s, 20 s, 40 s…, capped at 6 min). Retries count Failed Pods and, with `restartPolicy: OnFailure`, container restarts too. With `OnFailure`, the Pod is terminated when the limit is reached, which makes debugging harder, so the docs suggest `Never` (`concepts/workloads/controllers/job.md:358-382`).
- **activeDeadlineSeconds [G]:** This applies to the whole Job, however many Pods it creates. When it is reached, running Pods are terminated and the Job fails with `DeadlineExceeded`. **It takes precedence over backoffLimit** (`job.md:615-658`). Set it on the Job spec, not the Pod template; both specs have the field (`:657-658`).
- **ttlSecondsAfterFinished [C]:** This only affects *finished* Jobs (Complete or Failed). It cascade-deletes the Job and its Pods. If it is unset, the Job is never deleted automatically (`job.md:737-793`; `reference/kubernetes-api/workload-resources/job-v1.md:101-107`). Pick a value long enough for log collection.

**Which limit wins:** whichever terminal condition comes first. The deadline overrides any remaining retry budget, and the TTL only starts once the Job has finished.

### 3. Keeping batch Pods on batch nodes
- **[G]** A taint plus a toleration lets tolerating Pods *use* the tainted nodes "as well as any other nodes". To restrict batch Pods to those nodes, also label the nodes and require node affinity on the Pods (`concepts/scheduling-eviction/taint-and-toleration.md:176-191`). Taints keep other Pods off; required affinity keeps batch Pods on. Use both.
- **Node affinity [G]:** With `requiredDuringSchedulingIgnoredDuringExecution`, a Pod cannot schedule unless the rule matches. "IgnoredDuringExecution" means that if labels change later, running Pods keep running (`concepts/scheduling-eviction/assign-pod-node.md:103-157`).
- **NoSchedule vs NoExecute [G]:** `NoSchedule` blocks new Pods that lack a toleration but does not evict running ones. `NoExecute` evicts non-tolerating Pods immediately, or after `tolerationSeconds` (`taint-and-toleration.md:29-150`, `:152-174`). Setting `.spec.nodeName` bypasses the scheduler and therefore `NoSchedule` (`:64-70`).
- **[C]** Injecting tolerations and affinity through an admission controller is suggested (`:176-191`), but the docs leave the choice of controller to you.

### 4. Priority and preemption
- **PriorityClass [G/C]:** A cluster-scoped object. Higher values mean higher priority, up to 1 billion. The prefix `system-` is not allowed. Only one class can be `globalDefault`; without a global default, Pods have priority 0 (`concepts/scheduling-eviction/pod-priority-preemption.md:51-76`, `:91-101`). Give interactive services a higher class than batch.
- **preemptionPolicy [C]:** Defaults to `PreemptLowerPriority`. A class with `Never` queues ahead of lower-priority Pods but never preempts, and its Pods can still be preempted themselves (`:103-147`).
- **Graceful termination [G]:** Victims get their graceful termination period, which delays scheduling of the preemptor. The docs suggest a short grace period for low-priority Pods (`:196-228`). There is a trade-off: a short grace period gives batch work less time to checkpoint.
- **PDBs [G]:** PDBs are honored only on a **best-effort** basis. If no victims are found without violating a PDB, preemption happens anyway (`:230-238`). Preemption ignores QoS class (`:343-353`).

### 5. ResourceQuota
**[G]** If a quota covers `cpu` or `memory`, every new Pod must specify requests or limits for that resource, otherwise admission may be rejected. A LimitRange can supply defaults (`concepts/policy/resource-quotas.md:1-46`, `:48-61`). A request that would violate the quota fails with `403 FORBIDDEN` (`:36-37`). "Neither contention nor changes to quota will affect already created resources" (`:77`), so a new quota does not evict running Pods. When the sum of quotas exceeds cluster capacity, contention is first-come-first-served (`:74-75`).

**[U]** For Jobs, what a quota rejection looks like (retries, events, interaction with backoff) is not covered by these passages.

### 6. ConfigMap edits
- **Mounted volume [G]:** The new content arrives *eventually*. The delay is up to the kubelet sync period plus the cache propagation delay, which depends on `configMapAndSecretChangeDetectionStrategy` (`concepts/configuration/configmap.md:191-209`). The task page puts this at roughly 1 min + 1 min with the defaults it names (`tasks/configure-pod-container/configure-pod-configmap.md:743-761`).
- **subPath [G]:** Never receives updates (same ranges).
- **Environment variables [G]:** Not updated; the Pod must restart (`configmap.md:205`).
- **Immutable [G]:** The data cannot be changed and the flag cannot be reverted. The only option is to delete and recreate the ConfigMap, and existing Pods should be recreated (`configmap.md:299-328`).

**Implication [C]:** A long-running Pod may see config changes partway through a run, or never see them. The docs don't say whether the application rereads files [U]. For reproducible nightly runs, prefer immutable, versioned ConfigMaps that are read once at startup.

### 7. Node memory pressure
**[G]** The kubelet ranks Pods by (1) whether usage exceeds requests, (2) priority, then (3) usage relative to requests. BestEffort and Burstable Pods that exceed their requests go first; Guaranteed Pods, and Burstable Pods using less than their requests, go last (`concepts/scheduling-eviction/node-pressure-eviction.md:318-362`). A lower-priority Pod that stays within its requests may outlive a higher-priority Pod that exceeds them (`pod-priority-preemption.md:355-369`).

The kubelet **does not respect PDBs or `terminationGracePeriodSeconds`**. Soft thresholds use `eviction-max-pod-grace-period`; hard thresholds use a 0 s grace period (`node-pressure-eviction.md:2-36`). Batch Pods should therefore set memory requests that match their real usage.

### 8. Restricted Pod Security Standard
**Pod requirements [G]:** Everything from Baseline, plus:
- only these volume types: configMap, csi, downwardAPI, emptyDir, ephemeral, persistentVolumeClaim, projected, secret
- `allowPrivilegeEscalation: false`
- `runAsNonRoot: true`, and `runAsUser` must not be 0
- `seccompProfile.type` set to `RuntimeDefault` or `Localhost`; leaving it unset is prohibited
- capabilities `drop: ["ALL"]`, with only `NET_BIND_SERVICE` allowed to be added back

(`concepts/security/pod-security-standards.md:313-456`). The Baseline controls themselves were not re-read for this memo.

**Modes [G]:** In `audit` mode, violating Pods are recorded in the audit log but not forbidden. `warn` returns the warning to the user immediately. A server-side dry-run of the `enforce` label warns about existing Pods without applying the policy (`tasks/configure-pod-container/migrate-from-psp.md:247-272`). An `enforce`/`audit`/`warn` defaults configuration with exemptions is shown in `tutorials/security/cluster-level-pss.md:159-215`. Rejection by `enforce` is implied there rather than defined in the passages read **[U]**.

Note that the rejection happens when the Job controller creates Pods, so a CronJob can "succeed" at creating Jobs whose Pods are never admitted [U: not documented here].

### 9. API credentials
**[G]** The ServiceAccount admission controller defaults a Pod to the `default` ServiceAccount. It mounts a token volume unless `automountServiceAccountToken: false` is set on the ServiceAccount or on the Pod (`reference/access-authn-authz/service-accounts-admin.md:396-421`). Both opt-outs are shown in `tasks/configure-pod-container/configure-service-account.md:67-100`; when both are set, the Pod spec wins. **[C]** Give each team a dedicated batch ServiceAccount with automount set to false. Set the field on the Pod template too, so that a Pod-level `true` cannot silently re-enable it.

### 10. Prioritized rollout and validation checklist
1. **PSA:** label namespaces `audit`/`warn: restricted`, run the server-side dry-run of `enforce`, fix the Pod templates, then enforce (Q8).
2. **Credentials:** ServiceAccounts with automount set to false; verify that no token is mounted inside a running Pod (Q9).
3. **Quotas:** add a LimitRange with defaults before the ResourceQuota, and test a Job that would exceed the quota (Q5).
4. **Placement:** taint the batch nodes with `NoSchedule` (add `NoExecute` only after draining non-batch Pods), label them, and require node affinity on batch Pods. Inject both through admission (Q3).
5. **Priority:** create a PriorityClass for interactive services and a lower one for batch, and decide `preemptionPolicy` and the batch grace period (Q4).
6. **CronJob:** set an explicit `timeZone`, `concurrencyPolicy: Forbid`, a `startingDeadlineSeconds` of 10 s or more, idempotent jobs keyed on the scheduled-timestamp annotation, `restartPolicy: Never`, `backoffLimit`, `activeDeadlineSeconds` on the Job spec, and `ttlSecondsAfterFinished` (Q1–2).
7. **Config:** use immutable, versioned ConfigMaps, with no subPath or environment-variable reliance on live edits (Q6).
8. **Memory:** set memory requests equal to observed peak usage, and checkpoint the work (Q7).

**Limits that need application or cluster validation (not guaranteed by the docs):**
- Idempotency of the report, given that a run may happen twice or not at all (Q1).
- Whether checkpointing finishes within the grace period, and survival under preemption that overrides PDBs and hard-eviction kills with 0 s grace (Q4, Q7).
- Real ConfigMap propagation delay with the cluster's kubelet cache strategy, and whether the application rereads files (Q6).
- Whether the cluster quotas actually fit node capacity, given first-come-first-served contention (Q5).
- The kube-controller-manager time zone database and clock skew (Q1).
- Behavior of the Job controller when Pod creation is denied by quota or PSA [U].