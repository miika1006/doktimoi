I have the sources I need and am writing the memo now.

# Decision memo: shared-cluster batch platform (Kubernetes v1.32 docs)

**Recommendation:** Go ahead, with changes. Several requirements depend on how you configure the cluster, not on anything Kubernetes guarantees. The biggest gap: "yield to interactive services" doesn't work if interactive Pods can't schedule onto batch nodes (Q3/Q4).

Labels used below: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs. All paths are under `docs/`.

---

**1. CronJob: exactly one Job per schedule?** No. **[G]** A CronJob creates a Job "approximately once" per scheduled time. Sometimes two Jobs are created, or none, so Jobs "should be idempotent" (`concepts/workloads/controllers/cron-jobs.md:213-217`). A run is guaranteed "at least once" only when `startingDeadlineSeconds` is large or unset and `concurrencyPolicy: Allow` (`:223-225`).
- **[C] `concurrencyPolicy`:**
  - `Allow` is the default.
  - `Forbid` skips a new run while the previous one is still running.
  - `Replace` replaces the running Job.
  - The policy applies only to Jobs from the same CronJob (`:130-143`).
  - For hours-long reports, use `Forbid` so runs don't overlap. A skipped run counts as missed (`:240`).
- **[C] `startingDeadlineSeconds`:** after this deadline the run is skipped and treated as failed. With no deadline, a late run has no cutoff (`:109-126`). Values under 10 s may never schedule (`:227-228`).
- **Missed schedules:** if more than 100 runs are missed, the controller doesn't start the Job. Setting a deadline narrows the counting window (`:232-248`). Resuming a suspended CronJob with no deadline starts the missed Jobs immediately (`:156-160`).
- **Time zone:** without `.spec.timeZone`, kube-controller-manager uses its own local time zone. Set an IANA name, for example `Etc/UTC`. `TZ`/`CRON_TZ` inside the schedule is rejected since v1.29 (`:180-199`). **[N]** The docs don't describe what happens to a nightly schedule across a DST change.

**2. Job failure limits.** **[G]**
- **`restartPolicy`:**
  - `OnFailure` restarts the container in the same Pod.
  - `Never` makes the Job controller create a new Pod (`concepts/workloads/controllers/job.md:318-330`).
  - Even with parallelism 1 and completions 1, the same program "may sometimes be started twice" (`:340-342`).
- **`backoffLimit`:** default 6. Failures are counted as failed Pods, plus container restarts when using `OnFailure`. Retries use exponential backoff capped at 6 minutes (`:362-374`). With `OnFailure`, the Pod is terminated when the limit is reached, which makes debugging harder (`:376-382`).
- **Which limit wins:** `activeDeadlineSeconds` "takes precedence over" `backoffLimit`. No new Pods start after the deadline, running Pods are terminated, and the Job gets `reason: DeadlineExceeded` (`:629-636`). Set it on the Job spec, not the Pod spec (`:657-658`). Both outcomes are a permanent Job failure, and there is no automatic Job restart (`:660-663`).
- **`ttlSecondsAfterFinished`:** applies only after the Job finishes, then deletes the Job and its Pods cascadingly. If unset, the TTL controller doesn't clean up (`:741-775`). CronJob history limits (defaults 3 successful, 1 failed) also clean up (`cron-jobs.md:164-171`).
- **Termination timing:** terminal conditions are added only after all Pods have terminated. `terminationGracePeriodSeconds` extends this (`job.md:689-712`).
- **[C]** Use `restartPolicy: Never` and an `activeDeadlineSeconds` that ends before the next schedule. **[P]** The application must clean up temporary files, locks and partial output left by a previous attempt (`:328-330`).

**3. Keeping batch Pods on batch nodes.** You need both mechanisms.
- **Taint plus toleration** keeps *other* Pods off the batch nodes. It does not keep batch Pods *on* them. The docs say to also label the nodes and require node affinity (`concepts/scheduling-eviction/taint-and-toleration.md:181-191`).
- **Required node affinity** (`requiredDuringSchedulingIgnoredDuringExecution`) works like `nodeSelector`. "IgnoredDuringExecution" means a label change doesn't evict Pods that are already running (`concepts/scheduling-eviction/assign-pod-node.md:105-117`, `:143-147`).
- **NoSchedule vs NoExecute:**
  - `NoSchedule` blocks new Pods but doesn't evict running ones.
  - `NoExecute` evicts Pods that don't tolerate it immediately. Pods that tolerate it stay forever, or until `tolerationSeconds` runs out.
  - `PreferNoSchedule` is only a preference (`taint-and-toleration.md:97-115`).
- **[C]** Use `NoSchedule` for steady state. `NoExecute` is a draining tool.
- **[N]** The docs show an admission controller adding the toleration and affinity, but don't name a built-in one (`:184-191`). Without one, enforcement depends on manifests or a separate policy.

**4. Priority and preemption.**
- **[C] PriorityClass:** values range up to 1 000 000 000. Pods with no class get priority 0 unless a `globalDefault` exists, and adding a default doesn't change existing Pods (`concepts/scheduling-eviction/pod-priority-preemption.md:62-89`).
- **[C]** Give interactive services a higher class and batch a lower one. `preemptionPolicy` defaults to `PreemptLowerPriority`. `Never` puts a Pod ahead in the queue but it never preempts (`:107-127`). For batch, `Never` is a sensible choice.
- **[G] Graceful termination of victims:** victims get their graceful termination period (default 30 s) and are then killed. Interactive Pods wait during that time (`:216-228`, `:313-316`).
- **[G] PDBs:** respected only on a best-effort basis. Preemption goes ahead even when it violates a PDB (`:230-238`).
- **Design gap [N/P]:** preemption only removes Pods from a node where the pending Pod could then fit (`:187-194`). Interactive Pods don't tolerate the batch taint, so preempting batch Pods on batch nodes never helps them. Batch Pods "yield" only if interactive Pods may also use batch nodes, or if batch Pods also run on shared nodes. Decide which.

**5. ResourceQuota.**
- **[G] Requests/limits:** with a CPU/memory quota, every new Pod must specify requests or limits for those resources, or it may be rejected. Use a LimitRange to set defaults (`concepts/policy/resource-quotas.md:39-60`).
- **[G] Exceeding the quota:** the request fails with 403 Forbidden (`:36-37`). For a Job, this means the Pod isn't created. **[N]** How the Job controller retries in that case isn't covered in the passages read.
- **[G] Existing Pods:** "changes to quota will [not] affect already created resources" (`:77`).
- **[N]** If quotas add up to more than cluster capacity, contention is first-come-first-served (`:74-75`). Quota doesn't reserve capacity.
- **[C]** Per-PriorityClass quota scopes exist (`:229`, `:281`).

**6. ConfigMap edits.** **[G]**
- **Mounted volumes:** updated "eventually". The delay is the kubelet sync period plus cache propagation delay (`concepts/configuration/configmap.md:191-203`).
- **Environment variables:** never updated; the Pod must restart (`:205`).
- **subPath mounts:** never receive updates (`:207-209`).
- **Immutable ConfigMaps:** can't be changed back or edited, only deleted and recreated, and Pods should be recreated afterwards (`:299-328`).
- **Consequence [P]:** a Job running for hours with a volume mount can see settings change *mid-run*. The update isn't atomic in any way the app can rely on. For consistent runs, read the settings once at startup. Or, better, use a versioned immutable ConfigMap per release that the CronJob template references. Template changes apply only to new Jobs (`cron-jobs.md:205-209`).

**7. Node memory-pressure eviction.** **[G]**
- **Eviction order:** first, BestEffort/Burstable Pods using more than their requests, ordered by priority and then by how far over the request they are. Guaranteed Pods and Burstable Pods under their requests go last, by priority (`concepts/scheduling-eviction/node-pressure-eviction.md:323-336`).
- **QoS class:** not used directly for ordering (`:338-342`).
- **PDBs and grace period:** the kubelet does **not** respect PDBs or `terminationGracePeriodSeconds`.
  - Soft thresholds use `eviction-max-pod-grace-period`.
  - Hard thresholds kill immediately with a 0 s grace period (`:32-36`, `:210-212`).
- **[C]** Set batch memory requests equal to the real usage, so batch Pods don't end up first in line for eviction.

**8. Restricted Pod Security Standard.** **[G]** Requirements for Pods:
- everything in Baseline
- only these volume types: configMap, csi, downwardAPI, emptyDir, ephemeral, PVC, projected, secret
- `allowPrivilegeEscalation: false`
- `runAsNonRoot: true`, and `runAsUser` not 0
- seccomp `RuntimeDefault` or `Localhost`, never absent
- capabilities drop `ALL`; only `NET_BIND_SERVICE` may be added back

Sources: `concepts/security/pod-security-standards.md:299-445`. One non-compliant container fails the whole Pod (`:306-311`).

Modes, set with namespace labels:
- **enforce** rejects non-compliant Pods.
- **audit** allows the Pod and records the violation (an annotation, plus the audit log).
- **warn** allows the Pod and returns a warning. Warnings also appear for objects with Pod templates, such as Jobs.

Sources: `reference/labels-annotations-taints/_index.md:2369-2448`, `tasks/configure-pod-container/migrate-from-psp.md:262-266`.

**Watch for [P]:** enforce rejects *Pods*. A CronJob or Job object can therefore be accepted while its Pods are rejected at run time. Use warn on templates to catch this. The linked `concepts/security/pod-security-admission` page **isn't in this corpus [N]**, so cluster-wide defaults and exemptions aren't established here.

**9. API credentials.**
- **[G] Default behavior:**
  - Pods with no ServiceAccount get the namespace's `default` one, which has only discovery permissions under RBAC (`concepts/security/service-accounts.md:62-75`).
  - Credentials are mounted by default as a short-lived, rotating projected token (`:143-152`).
- **[C] Turning it off:**
  - set `automountServiceAccountToken: false` on the ServiceAccount or the Pod; the Pod setting wins (`tasks/configure-pod-container/configure-service-account.md:67-100`)
  - give Jobs that do need the API a dedicated ServiceAccount with least-privilege RBAC (`service-accounts.md:116-125`)
- **[G]** Credentials are revoked 60 s after the Pod's deletionTimestamp (`configure-service-account.md:61-65`).

**10. Prioritized rollout and validation checklist**
1. Label namespaces with `warn` and `audit` set to restricted. Dry-run enforce (`migrate-from-psp.md:253-269`). Fix the Pod templates, then turn on enforce.
2. Set `automountServiceAccountToken: false` on each namespace's `default` ServiceAccount. Use dedicated ServiceAccounts with RBAC only where needed.
3. Add a LimitRange and ResourceQuota per namespace. Size quotas to cover the batch peak.
4. Configure batch nodes with a taint, a matching label and required affinity. Decide how admission will inject or enforce them.
5. Create PriorityClasses (batch low with `Never`, interactive high). Resolve the gap from Q4 about where interactive Pods can land.
6. CronJob settings: `timeZone`, `concurrencyPolicy: Forbid`, a `startingDeadlineSeconds` of 10 s or more, Job-level `activeDeadlineSeconds`, `restartPolicy: Never`, `backoffLimit`, and `ttlSecondsAfterFinished` or history limits.
7. ConfigMaps: switch to versioned immutable ConfigMaps, or read settings once at startup. Avoid subPath mounts.

**Still needs validation (not guaranteed by these docs):**
- **Idempotency:** duplicate or missed CronJob runs, and a program started twice (`cron-jobs.md:213-217`, `job.md:340-342`).
- **Batch work killed partway:** surviving preemption with only about 30 s of grace and PDBs best-effort, and hard eviction with 0 s grace, since a report can run for hours.
- **Config propagation:** the actual delay in this cluster, which depends on the kubelet sync period and cache settings.
- **Quota vs capacity:** quotas don't reserve capacity, and the docs read don't establish how Jobs behave when a Pod is rejected by quota.
- **Controller time zone and DST:** behavior of the controller's time zone and daylight saving time.
- **Admission tooling:** enforcing tolerations and affinity, and Pod Security exemptions, since that page is missing from this corpus.

---

I can also publish this as a shareable page if you want to pass it on.