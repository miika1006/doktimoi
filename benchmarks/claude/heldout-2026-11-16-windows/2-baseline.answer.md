# Decision memo: shared batch platform on Kubernetes v1.32

**Scope.** This memo uses only the supplied docs. Paths are relative to `docs/`, followed by line numbers. Each point is tagged: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** something the docs do not establish.

**Verdict.** The design can work, but four of its assumptions are wrong as stated:
- A CronJob does not guarantee exactly one Job per run.
- PodDisruptionBudgets (PDBs) are only best effort during preemption and are ignored during kubelet eviction.
- Editing the ConfigMap does not change Jobs that are already running in a predictable way.
- `restricted` requires changes to every Pod spec.

The nightly report must be idempotent and safe to restart.

---

### 1. CronJob: exactly one Job per schedule?

**No.**
- **[G]** A CronJob creates a Job "approximately once" per scheduled time. Sometimes two Jobs, or none, may be created, so Jobs "should be _idempotent_" (`concepts/workloads/controllers/cron-jobs.md:213-217`). Even a single Job may start the same program twice (`concepts/workloads/controllers/job.md:340-342`).
- **concurrencyPolicy [C]:** `Allow` is the default. `Forbid` skips the new run while the previous one is still running. `Replace` replaces the running Job with a new one. The policy only applies within one CronJob (`cron-jobs.md:130-143`). For hours-long runs, use `Forbid`. A run skipped this way counts as missed (`:240`).
- **startingDeadlineSeconds [C]:** a run that is later than this many seconds is skipped and treated as failed. If the field is unset, there is no deadline (`:109-126`). With `Forbid`, a delayed start can still happen after the previous Job finishes (`:135-138`). Do not set it below 10 s, because the controller checks every 10 s (`:227-228`).
- **Missed schedules [G]:** if more than 100 schedules were missed, the Job is not started. Setting `startingDeadlineSeconds` limits how far back the controller counts (`:232-248`). After a suspension is lifted, missed runs fire immediately if no deadline is set (`:156-160`).
- **Time zone [C]:** if no time zone is set, the schedule follows kube-controller-manager's local zone. Set `.spec.timeZone` (`:180-188`). `CRON_TZ` and `TZ` inside the schedule fail validation since v1.29 (`:194-199`).
- **[G]** Edits to a CronJob affect only new Jobs (`:205-209`). The `cronjob-scheduled-timestamp` annotation, added in v1.32 (`:219-221`), helps with deduplication.

### 2. Job failure and time limits

- **restartPolicy [P]:** a Job's Pods may only use `Never` or `OnFailure` (`job.md:221`).
  - With `OnFailure`, the container restarts in the same Pod.
  - With `Never`, the Job creates a new Pod (`:318-330`).
- **backoffLimit [G]:** defaults to 6. Retries are delayed 10 s, 20 s, 40 s and so on, up to 6 min (`:362-365`). Failed Pods and, under `OnFailure`, container restarts both count toward the limit (`:367-374`). With `OnFailure`, the Pod is terminated when the limit is reached, which makes debugging harder, so prefer `Never` (`:376-381`).
- **activeDeadlineSeconds [G]:** covers the whole Job, however many Pods it creates. When it is reached, the Pods are terminated and the Job fails with `DeadlineExceeded` (`:628-632`).
- **Which limit wins [G]:** "`activeDeadlineSeconds` takes precedence over its `backoffLimit`" (`:634-636`). In practice, whichever limit is reached first ends the Job.
  - Set the field on the Job spec, not on the Pod template (`:657-658`).
  - Neither limit restarts the Job; a failed Job needs manual action (`:660-663`).
  - The terminal condition appears only after all Pods have terminated, and that can be delayed by `terminationGracePeriodSeconds` (`:689-712`).
- **ttlSecondsAfterFinished [C]:** deletes a finished Job and its Pods once the time has passed. If unset, the Job is not cleaned up by TTL (`:741-775`). CronJobs also use history limits, which default to 3 successful and 1 failed Job (`cron-jobs.md:164-171`). Set the TTL long enough to collect logs first.

### 3. Keeping batch Pods on batch nodes

- **[G]** Taints repel Pods, and node affinity attracts them. A toleration *allows* scheduling on a tainted node but does not guarantee it (`concepts/scheduling-eviction/taint-and-toleration.md:13-21`).
- A taint alone does not keep batch Pods *on* the batch nodes: tolerating Pods may still run anywhere. Dedicated nodes need **both** a taint and a matching label plus required node affinity (`:181-191`; `assign-pod-node.md:109-118`).
- `IgnoredDuringExecution` means that changing labels does not move Pods that are already running (`assign-pod-node.md:116-118`).
- **NoSchedule vs NoExecute [G]:**
  - `NoSchedule` blocks new Pods that do not tolerate the taint, but does not evict running ones.
  - `NoExecute` also evicts running Pods that do not tolerate it. `tolerationSeconds` limits how long a tolerating Pod may stay (`taint-and-toleration.md:97-115, 157-174`).
  - Use `NoSchedule` for steady state. Use `NoExecute` only to drain the batch nodes, knowing that it kills hours-long Jobs.
- **[N]** Setting `nodeName` directly bypasses the scheduler and taints (`:65-71`). Preventing that requires an admission control mechanism that these docs do not specify.

### 4. Priority and preemption

- **[C]** Create a low-value PriorityClass for batch and a higher one for interactive services. Pods without a class get priority 0 unless a `globalDefault` exists. Adding a default does not change Pods that already exist (`pod-priority-preemption.md:68-89`). Pods that name a class that does not exist are rejected (`:151-154`).
- **preemptionPolicy:** defaults to `PreemptLowerPriority`. With `Never`, Pods wait in the queue and do not preempt, but other Pods can still preempt them (`:103-127`). Give batch `Never` so it never evicts anything.
- **Graceful termination [G]:** victims get their grace period, so there is a delay before the pending Pod runs. A short grace period for batch reduces that delay (`:216-228`). The `nominatedNodeName` is not binding (`:203-212`).
- **PDBs [G]:** "supported, but not guaranteed", that is, best effort. Preemption still happens if no victim set respects the PDBs (`:230-238`).
- **[N]** The docs do not say how quickly interactive Pods get capacity. That has to be measured.

### 5. ResourceQuota

- **[P]** With CPU or memory quota in a namespace, every new Pod must specify requests or limits, or it may be rejected. Use a LimitRange to set defaults (`concepts/policy/resource-quotas.md:39-60`). A quota on `requests.*` or `limits.*` requires explicit values of that kind (`:467-469`).
- **[G]** A request that would exceed the quota fails with `403 FORBIDDEN` (`:36-37`).
- For a Job, the failure applies when the Pod is created. Whether the Job retries, and how that shows up, is **[N]** in these docs.
- **[G]** Changes to a quota do not affect resources that already exist (`:77`). If quotas add up to more than the cluster capacity, resources are handed out first come, first served (`:74-75`).

### 6. ConfigMap edits

- **Mounted volume [G]:** updated *eventually*. The delay can be the kubelet sync period plus the cache propagation delay (`concepts/configuration/configmap.md:191-203`).
- **Environment variables [G]:** not updated; the Pod must be restarted (`:205`).
- **subPath [G]:** never receives updates (`:207-209`).
- **Immutable [G]:** the content cannot be changed and immutability cannot be reverted. The ConfigMap must be deleted and recreated, and the Pods should be recreated too (`:299-328`).
- **Recommendation [C]:** a run that lasts for hours should read a consistent snapshot of the settings. Use versioned, immutable ConfigMaps and point the CronJob template at the new name; template changes affect only new Jobs (`cron-jobs.md:205-209`). Daytime edits to a mutable ConfigMap can reach a running Job partway through.

### 7. Node memory pressure

- **Eviction order [G]:**
  1. Pods whose usage exceeds their requests, ordered by priority and then by how far they exceed.
  2. Then Guaranteed Pods, and Burstable Pods below their requests, ordered by priority (`concepts/scheduling-eviction/node-pressure-eviction.md:323-336`).
- Guaranteed Pods, whose requests equal their limits, are not evicted because of another Pod's usage (`:345-353`).
- **PDB and grace period [G]:** the kubelet respects neither the PDB nor `terminationGracePeriodSeconds`. Soft thresholds use `eviction-max-pod-grace-period`; hard thresholds use 0 s (`:32-36`).
- Batch Pods should set requests close to actual usage so they do not end up first in the eviction order.

### 8. Restricted Pod Security Standard

- **[P]** Every Pod must:
  - inherit all Baseline controls;
  - use only these volume types: configMap, csi, downwardAPI, emptyDir, ephemeral, persistentVolumeClaim, projected, secret;
  - set `allowPrivilegeEscalation: false`;
  - set `runAsNonRoot: true`, and not use `runAsUser: 0`;
  - set seccomp to `RuntimeDefault` or `Localhost`;
  - drop `ALL` capabilities and add back only `NET_BIND_SERVICE`.

  One container that fails a check fails the whole Pod (`concepts/security/pod-security-standards.md:299-455`).
- **Modes [G]:**
  - `enforce` *prohibits* creating a Pod that does not comply.
  - `audit` does not block it and records the violation.
  - `warn` does not block it and returns a warning. Warnings are also shown for objects with Pod templates, such as Jobs (`reference/labels-annotations-taints/_index.md:2369-2451`; `tasks/configure-pod-container/migrate-from-psp.md:257-268`).
- **Important consequence:** a CronJob or Job is accepted, but its Pods are rejected at creation time. So check `warn` and `audit` first, and pin `*-version`.
- **[N]** The concept page `pod-security-admission` is linked but not in the corpus, so exemptions and admission configuration are not established here.

### 9. API credentials

- **[G]** By default, the Pod receives credentials for its ServiceAccount, including `default`, as a short-lived, rotating projected token (`concepts/security/service-accounts.md:141-156`).
- **[C]** To turn this off, set `automountServiceAccountToken: false` on the ServiceAccount, on the Pod, or on both. If both are set, the Pod's value wins (`tasks/configure-pod-container/configure-service-account.md:67-100`).
- Pods that need the API should get a dedicated ServiceAccount with minimal RBAC (`service-accounts.md:116-125`). Tokens are revoked 60 s after the Pod's deletion timestamp (`configure-service-account.md:61-65`).

### 10. Prioritized rollout and validation checklist

1. **Namespaces:** label `warn` and `audit=restricted` first. Run a server-side dry run of `enforce` (`migrate-from-psp.md:257-268`), fix the Pod templates, and only then set `enforce` with a pinned version.
2. **Quota:** create a LimitRange and a ResourceQuota per namespace (`resource-quotas.md:39-60`). Verify that Job Pods get past admission.
3. **Priority:** create the PriorityClasses: batch low with `Never`, interactive high. Decide whether to use `globalDefault` before the first workloads, since it does not apply retroactively (`pod-priority-preemption.md:83-85`).
4. **Batch nodes:** add the `NoSchedule` taint, a label, and required node affinity plus a toleration in the batch templates. Avoid `NoExecute` except when draining.
5. **CronJob:** set `timeZone`, `concurrencyPolicy: Forbid`, `startingDeadlineSeconds` ≥ 10 s and sized to the reporting window, history limits, and a Job-level `activeDeadlineSeconds`. Also set `backoffLimit`, `restartPolicy: Never` and `ttlSecondsAfterFinished`.
6. **Settings:** use immutable, versioned ConfigMaps mounted as volumes without `subPath`.
7. **ServiceAccounts:** set `automountServiceAccountToken: false` on the default ServiceAccount and on the Pods. Create a dedicated ServiceAccount where API access is needed.
8. **Make the job idempotent:** handle duplicate runs and runs that resume after a restart.

**Limits that still need validation, because the docs do not guarantee them:**
- **Exactly one report per night:** the docs say it is approximate (`cron-jobs.md:213-217`). The application needs deduplication, for example using the scheduled-timestamp annotation.
- **Preemption delay and PDB protection for batch Pods:** both are best effort (`pod-priority-preemption.md:216-238`). Measure how quickly interactive Pods get capacity under load.
- **Survival of long runs:** hard eviction kills with no grace period and ignores PDBs (`node-pressure-eviction.md:32-36`). Batch work needs checkpointing, and the cluster's eviction thresholds need to be checked.
- **ConfigMap propagation delay:** this depends on the kubelet configuration (`configmap.md:196-203`).
- **Total quota versus cluster capacity:** it is resolved first come, first served (`resource-quotas.md:74-75`).
- **Ensuring every batch Pod has its toleration and affinity:** the docs suggest a custom admission controller (`taint-and-toleration.md:184-185`) and do not document one.