I've read all the relevant sources and am now writing the memo.

# Decision memo: shared batch platform on Kubernetes v1.32

**Bottom line:** the design can be built, but several of its goals depend on configuration choices, and some are not guaranteed by the docs at all. Most important: a CronJob does not guarantee exactly one run. Node-pressure eviction ignores PodDisruptionBudgets (PDBs) and the Pod's grace period. Putting batch Pods on separate tainted nodes weakens preemption as the way to make them yield.

Labels used below: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs. Paths are relative to `docs/`.

### 1. Does a CronJob run exactly one Job per schedule?
No.
- **[G]** A CronJob creates a Job "approximately once" per scheduled time. Sometimes it creates two Jobs or none, so Jobs must be idempotent (`concepts/workloads/controllers/cron-jobs.md:213-217`).
- **[G]** With `concurrencyPolicy: Allow` (the default) and no or a large `startingDeadlineSeconds`, each scheduled Job runs "at least once" (`:223-225`).
- **[C]** Because runs can take hours, use `Forbid` or `Replace`:
  - `Forbid` skips a new run while the previous one is still running.
  - `Replace` replaces the running Job with a new one.
  - Either policy applies only to Jobs created by the same CronJob (`:130-143`).
  - A run skipped under `Forbid` counts as missed (`:240`).
- **[C]** `startingDeadlineSeconds`:
  - A run that starts later than this deadline is skipped and treated as failed. With no value, there is no deadline (`:109-126`).
  - Values under 10 s may never start, because the controller checks every 10 s (`:227-229`).
- **[G]** Missed schedules:
  - If more than 100 schedules were missed, the controller does not start the Job (`:232-236`).
  - When the deadline is set, the count only covers that window (`:238`, `:246-248`).
- **[G]** Time zone:
  - Without `.spec.timeZone`, the schedule follows the local time zone of kube-controller-manager (`:180-186`).
  - `TZ`/`CRON_TZ` inside the schedule is not supported and fails validation (`:194-199`).
  - **[C]** Set `timeZone` explicitly.
- **[G]** Changes to the CronJob apply only to new Jobs (`:205-209`).

### 2. Job failure limits
- **[C]** `restartPolicy`:
  - `OnFailure` re-runs the failed container in the same Pod.
  - `Never` makes the controller create a new Pod (`concepts/workloads/controllers/job.md:318-330`).
- **[G]** `backoffLimit`:
  - Default 6. Retries back off at 10 s, 20 s, 40 s and so on, up to 6 minutes (`:362-365`).
  - Failed Pods count toward it. Under `OnFailure`, container restarts count as well (`:367-374`).
  - Under `OnFailure`, the Pod is terminated when the limit is reached, which makes debugging harder (`:377-381`).
- **[G]** `activeDeadlineSeconds`:
  - Limits the run time of the whole Job. When it is reached, Pods are terminated and the Job fails with `DeadlineExceeded` (`:628-632`).
  - **It takes precedence over `backoffLimit`** (`:634-636`).
  - Set it on the Job, not on the Pod template (`:657-658`).
- **[G]** Both limits make the Job fail permanently, with no automatic restart (`:660-663`).
- **[C]** `podFailurePolicy` with `Ignore` on `DisruptionTarget` stops preemptions and evictions from using up retries. It requires `restartPolicy: Never` (`:475-479`, `:504-506`, `:516-517`).
- **[C]** `ttlSecondsAfterFinished` deletes a finished Job together with its Pods. Without it, the TTL controller does not clean up (`:741-750`, `:770-775`). It does not affect retries. Set it longer than the time needed to read logs.

### 3. Placement on batch nodes
- **[G]** Taints repel Pods. Affinity attracts them (`concepts/scheduling-eviction/taint-and-toleration.md:14-16`).
- **[G]** A toleration only *allows* a Pod onto tainted nodes; the Pod can still land anywhere else. To keep batch Pods **only** on batch nodes, add a node label plus required node affinity (`:181-191`).
- **[G]** `requiredDuringScheduling…` is a hard rule. "IgnoredDuringExecution" means that a later label change does not move running Pods (`concepts/scheduling-eviction/assign-pod-node.md:109-119`).
- **[G]** Taint effects:
  - `NoSchedule` blocks new Pods but does not evict running ones.
  - `NoExecute` also evicts running Pods that do not tolerate it, either immediately or after `tolerationSeconds` (`taint-and-toleration.md:99-110`, `:157-174`).
  - **[C]** Use `NoSchedule` on the batch nodes. `NoExecute` also evicts long batch runs if the taint is added while they run, unless their toleration has no `tolerationSeconds`.
- **[G]** Setting `nodeName` directly bypasses the scheduler and ignores `NoSchedule` (`:65-71`).
- **[P]** Teams can edit their own Pod specs. Adding the tolerations "most easily" needs a custom admission controller (`:183-185`). Restricting node labels needs `NodeRestriction` (`assign-pod-node.md:60-68`).

### 4. Priority and preemption
- **[C]** Create a low-value PriorityClass for batch and a higher one for interactive work (`concepts/scheduling-eviction/pod-priority-preemption.md:51-73`). Without a `globalDefault`, Pods get priority 0 (`:72-73`). A missing class makes the Pod be rejected (`:152-154`).
- **[G]** `preemptionPolicy: Never` makes Pods non-preempting, but they can still be preempted (`:107-127`). Batch should use it.
- **[G] Design tension:** preemption looks for a node where removing lower-priority Pods lets the pending Pod run (`:187-194`).
  - If interactive Pods cannot schedule onto the tainted batch nodes, preempting batch Pods frees nothing they can use.
  - In that case "yield" only means queue order (`:178-183`), unless the two kinds of Pods share nodes.
- **[G]** Victims get their grace period, 30 s by default, before they are killed (`:216-228`, `:313-316`).
- **[G]** PDBs are respected only as "best effort". Preemption still happens if no victim avoids breaking a PDB (`:230-238`).
- **[P]** A team could give itself high priority. Limit PriorityClass use with quotas (`:21-30`; `concepts/policy/resource-quotas.md:615-641`).

### 5. ResourceQuota
- **[G]** When a CPU or memory quota is set, every new Pod must give requests or limits for that resource, or it may be rejected. A LimitRange can set defaults (`concepts/policy/resource-quotas.md:39-62`). A quota on `requests.*` or `limits.*` requires that field on every container (`:467-469`).
- **[G]** A request that would exceed the quota fails with `403 FORBIDDEN` (`:36-37`).
- **[G]** "Changes to quota will not affect already created resources" (`:77`).
- **[G]** Usage counts only Pods in a non-terminal state (`:101`).
- **[G]** A quota does not reserve node capacity (`:74-75`, `:612-613`).
- **[N]** How the Job controller retries Pod creation after a quota rejection is not described in these sections.

### 6. ConfigMap changes
- **[G]** Mounted volumes update eventually, after up to the kubelet sync period plus the cache delay (`concepts/configuration/configmap.md:193-203`).
- **[G]** Environment variables are not updated; the Pod has to be restarted (`:205`).
- **[G]** A `subPath` mount never receives updates (`:208`).
- **[G]** An immutable ConfigMap cannot be changed back to mutable or edited, only deleted and recreated (`:299-328`).
- **[N]** The docs do not say whether a long-running Pod sees a consistent snapshot. **[C]** Recommendation: read the settings once at Job start, or use versioned immutable ConfigMaps referenced from the CronJob template. Template changes affect only new Jobs (`cron-jobs.md:205-209`).

### 7. Node-pressure eviction
- **[G]** Eviction order: first, Pods whose usage exceeds their requests, ranked by priority and then by how far usage exceeds the request. Last: Pods using less than their requests, ranked by priority (`concepts/scheduling-eviction/node-pressure-eviction.md:323-336`).
- **[G]** Guaranteed Pods are not evicted because of other Pods' usage (`:345-353`).
- **[G]** The kubelet **does not respect PDBs or `terminationGracePeriodSeconds`** (`:32-36`):
  - Soft thresholds use the smaller of the soft-threshold grace period and `eviction-max-pod-grace-period`. If no maximum is set, Pods are killed immediately (`:192-197`).
  - Hard thresholds kill with a 0 s grace period (`:210-212`).
- **[C]** Give batch Pods requests that match real usage, ideally Guaranteed.

### 8. Restricted Pod Security Standard
- **[G]** Each Pod needs:
  - only allowed volume types;
  - `allowPrivilegeEscalation: false`;
  - `runAsNonRoot: true` and no `runAsUser: 0`;
  - seccomp `RuntimeDefault` or `Localhost`;
  - drop `ALL` capabilities, adding back only `NET_BIND_SERVICE`;
  - everything required by Baseline as well (`concepts/security/pod-security-standards.md:299-456`).
- **[G]** If any container fails a check, the whole Pod fails (`:306-311`).
- **[G]** Modes:
  - `enforce` rejects non-compliant Pods.
  - `audit` allows them and annotates.
  - `warn` allows them and returns a warning, also for Job templates (`reference/labels-annotations-taints/_index.md:2377-2380`, `:2409-2413`, `:2442-2448`).
  - Pin versions with `*-version` labels (`:2393-2396`).
- **[N]** The tutorial shows only a *warning* about existing Pods that violate a newly applied level (`tutorials/security/cluster-level-pss.md:125`, `:144`). The docs do not establish that `enforce` rejects a CronJob whose template does not comply. The risk is that the nightly Pods are rejected only at run time. The full Pod Security Admission page is not in this corpus.

### 9. API credentials
- **[G]** By default, a Pod gets its ServiceAccount's credentials. If no ServiceAccount is set, it gets the `default` ServiceAccount (`concepts/security/service-accounts.md:73-75`, `:150-156`).
- **[C]** Turn off mounting with `automountServiceAccountToken: false` on the ServiceAccount or on the Pod. The Pod value wins (`tasks/configure-pod-container/configure-service-account.md:67-100`).
- **[C]** Pods that do need API access should use a dedicated ServiceAccount with minimal RBAC permissions (`service-accounts.md:116-125`).

### 10. Rollout and validation checklist
1. **PSA on every team namespace:** set `warn`/`audit` to `restricted` first, fix the templates, then turn on `enforce` with a pinned version. Test one real CronJob run.
2. **No API credentials by default:** set `automountServiceAccountToken: false` on each namespace's `default` ServiceAccount. Use dedicated, minimally permitted ServiceAccounts only where a Pod needs API access.
3. **Quotas and LimitRanges together:** add the LimitRange so Pods have default requests, and create the quotas before teams deploy. Set batch requests close to real usage.
4. **Batch nodes:** label and taint them `NoSchedule`. Add the matching toleration plus required node affinity through admission, so teams cannot omit or change them. Enable `NodeRestriction`.
5. **PriorityClasses:** create them, with batch set to low and `preemptionPolicy: Never`, and limit their use with quotas. Decide whether interactive Pods may run on batch nodes. Otherwise preemption will not make batch yield.
6. **Job specs:** `restartPolicy: Never`, a `podFailurePolicy` that ignores disruptions, `backoffLimit`, an `activeDeadlineSeconds` below the schedule interval, `ttlSecondsAfterFinished`, `concurrencyPolicy: Forbid`, an explicit `timeZone`, and a `startingDeadlineSeconds` of at least 10 s.
7. **Configuration:** use versioned immutable ConfigMaps, and do not use `subPath`.

**Limits that need validation, not assumed by these docs:**
- **Idempotence:** whether the report is safe to run twice or not at all, since duplicate and missed Jobs are possible.
- **Checkpoints:** whether the application can resume after a 0 s hard eviction or a 30 s preemption grace period.
- **Kubelet eviction settings:** the thresholds and `eviction-max-pod-grace-period` on each node.
- **ConfigMap propagation:** the kubelet sync period and cache type that set the actual delay.
- **Batch node capacity:** whether the batch nodes have enough room for the whole night's run against each team's quota.
- **Job controller vs. quota:** what the Job controller does after a `403` from the quota.
- **PSA vs. templates:** whether `enforce` rejects a non-compliant CronJob template, or only its Pods at run time.