# Batch platform on Kubernetes v1.32: design review

**Verdict:** The design can work, but several safety properties depend on how it is configured, and some are not guaranteed at all. The Kubernetes fields involved behave as documented. Three things are not covered by any guarantee: run-once semantics for the CronJob, a Pod Disruption Budget (PDB) protecting Pods during preemption or node-pressure eviction, and Jobs seeing ConfigMap edits consistently. Each needs a design decision or validation.

Labels used below: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[U]** not established by these documents.

## 1. CronJob scheduling

- **[G] Exactly one Job per schedule is not guaranteed.** A CronJob creates a Job "approximately once" per scheduled time. Sometimes it creates two Jobs or none, so Jobs "should be _idempotent_" (`concepts/workloads/controllers/cron-jobs.md:211-218`). In v1.32 each Job gets the annotation `batch.kubernetes.io/cronjob-scheduled-timestamp` (`:220-222`), which the application can use to detect duplicate runs.
- **[C] concurrencyPolicy** has three values:
  - `Allow` (the default) lets runs overlap.
  - `Forbid` skips a new run while the previous one is still going. When the previous run finishes, `startingDeadlineSeconds` is still checked and may still start a run.
  - `Replace` stops the running Job and starts a new one.
  
  The policy only covers Jobs from the same CronJob (`cron-jobs.md:128-143`). Because nightly Jobs can run for hours, use `Forbid`. `Replace` would discard work in progress.
- **[C] startingDeadlineSeconds** sets how late a run may still start. A run that misses it is skipped and counted as a failed Job. If the field is unset, there is no deadline (`cron-jobs.md:107-126`). Values under 10 seconds may stop the CronJob from ever being scheduled, because the controller checks every 10 seconds (`:228-230`).
- **[G] Missed schedules:** if more than 100 runs were missed, the controller starts no Job and logs an error. With `startingDeadlineSeconds` set, it only counts misses within that window. A run skipped under `Forbid` counts as missed (`:233-244`).
- **[C]/[P] Time zone:** if `.spec.timeZone` is unset, the schedule uses the kube-controller-manager's local time zone (`cron-jobs.md:176-188`). If a time zone name later becomes invalid, the controller stops creating Jobs and emits an `UnknownTimeZone` event (`reference/kubernetes-api/workload-resources/cron-job-v1.md:57-90`). Set `timeZone` explicitly.

## 2. Job failure and time limits

- **[C] restartPolicy:** a Job's Pods may only use `Never` or `OnFailure` (`concepts/workloads/controllers/job.md:209-221`).
- **[G] backoffLimit** defaults to 6. Failed Pods are recreated with exponential back-off (10s, 20s, 40s and so on), capped at six minutes. Retries are counted two ways: as failed Pods, and with `OnFailure`, also as container restarts inside Pods that are still running. The Job fails when either count reaches the limit (`job.md:358-376`). With `OnFailure`, the Pod is terminated when the limit is reached, which makes debugging harder (`:378-382`).
- **[G] activeDeadlineSeconds wins over backoffLimit.** It limits the whole Job, however many Pods it creates. When it is reached, running Pods are terminated and the Job fails with `reason: DeadlineExceeded`. No further retries are made even if retries remain (`job.md:615-658`). The Pod template has its own field with the same name, so set it at the Job level (`:656-658`).
- **[G]/[C] ttlSecondsAfterFinished** only applies after a Job has finished, whether it completed or failed. Deleting the Job also deletes its Pods. If the field is unset, the TTL controller never removes the Job (`job.md:737-793`; `reference/kubernetes-api/workload-resources/job-v1.md:101-103`). It does not limit run time.
- Suspending a Job resets its start time and therefore its `activeDeadlineSeconds` timer (`job-v1.md:105-107`).

## 3. Keeping batch Pods on batch nodes

- **[G] Taints and tolerations alone are not enough.** A toleration only *allows* Pods onto the tainted nodes; those Pods can still run on any other node. To keep batch Pods *only* on batch nodes, also label the nodes and require node affinity, ideally added by an admission controller (`concepts/scheduling-eviction/taint-and-toleration.md:176-191`; `concepts/security/multi-tenancy.md:298-324`).
- **Node affinity:** the `required...` form is a hard rule; the `preferred...` form is not. `IgnoredDuringExecution` means label changes made after scheduling do not move running Pods (`concepts/scheduling-eviction/assign-pod-node.md:103-157`).
- **Taint effects** (`taint-and-toleration.md:29-150`):
  - `NoSchedule` keeps new Pods without a matching toleration off the node, but does not evict Pods already running there.
  - `NoExecute` also evicts running Pods that don't tolerate it. Pods that tolerate it with `tolerationSeconds` stay only that long (`:157-174`).
  - `PreferNoSchedule` is only a preference.
  - Setting `nodeName` directly bypasses the scheduler and ignores `NoSchedule`.
- **Recommendation:** use `dedicated=batch:NoSchedule` together with required node affinity. Use `NoExecute` only for planned eviction of existing Pods.

## 4. Priority and preemption

- **[C] PriorityClass:** a cluster-wide object whose `value` can be at most 1 billion; a higher value means higher priority. Only one class may be `globalDefault`. Without a default, Pods have priority 0 (`concepts/scheduling-eviction/pod-priority-preemption.md:51-76`). Give interactive services a higher class and batch a lower one.
- **[C] preemptionPolicy:** with `Never`, Pods are queued ahead of lower-priority Pods but cannot preempt. They can still be preempted themselves. The default is `PreemptLowerPriority` (`:103-147`). Set `Never` on the batch class.
- **[G] Victims get their graceful termination period**, which delays the higher-priority Pod. The docs suggest a short grace period for low-priority Pods (`:214-228`). This conflicts with Jobs that run for hours, so plan for preempted batch Pods losing their work.
- **[G] PDBs are best effort only during preemption.** If no victim can be found without violating a PDB, preemption happens anyway (`:230-238`). Preemption does not consider QoS class (`:343-353`).

## 5. ResourceQuota

- **[P]** With a CPU or memory quota on the namespace, every *new* Pod must specify requests or limits for that resource, or it may be rejected. A LimitRange can supply defaults (`concepts/policy/resource-quotas.md:38-62`).
- **[G]** A request that would exceed the quota fails with `403 FORBIDDEN` (`resource-quotas.md:35-36`). A rejected Job Pod is not created; how that interacts with the Job's retries **[U]** is not covered by these documents.
- **[U] Effect on already-running Pods:** I found no statement in the corpus. The note's wording "every (new) pod" (`:48-53`) only suggests that admission happens at creation time. Confirm with a test.
- **[C]** Quota scopes such as `Terminating` (Pods with `activeDeadlineSeconds`) and `PriorityClass` can give batch Pods a separate budget (`resource-quotas.md:212-279`).

## 6. ConfigMap updates

- **[G] Mounted volumes are updated eventually.** The delay is up to the kubelet sync period plus cache propagation, and the cache strategy is configurable (`concepts/configuration/configmap.md:191-205`; one minute + one minute with a TTL cache: `tasks/configure-pod-container/configure-pod-configmap.md:743-756`).
- **[G] subPath mounts never receive updates** (`configmap.md:207-209`).
- **[G] Environment variables never update** without a Pod restart (`configmap.md:205`).
- **[G] Immutable ConfigMaps** cannot be changed or switched back to mutable. They can only be deleted and recreated, and existing Pods should then be recreated (`configmap.md:299-328`).
- **Risk:** a Job running for hours may read settings partway through an edit, or Pods within one run may see different versions. Recommendation: use a versioned, immutable ConfigMap per release, and have the CronJob template reference it by name.

## 7. Node-pressure eviction

- **[G] Eviction order** (`concepts/scheduling-eviction/node-pressure-eviction.md:318-362`):
  1. BestEffort and Burstable Pods whose usage exceeds their requests, ordered by priority and then by how far they exceed.
  2. Guaranteed Pods and Pods under their requests, last, by priority.
  
  The kubelet does not use QoS class itself, and Pods under their requests are not evicted (`pod-priority-preemption.md:355-369`).
- **[G] PDBs and `terminationGracePeriodSeconds` are not honored.** Soft thresholds use `eviction-max-pod-grace-period`; hard thresholds use a 0-second grace period (`node-pressure-eviction.md:31-36`). Evicted Pods end up in the `Failed` phase (`:24-25`), which likely counts toward `backoffLimit` **[U, inferred from `job.md:368-370`]**.

## 8. Restricted Pod Security Standard

- **[P] What Pods must set** (`concepts/security/pod-security-standards.md:313-456`):
  - only the permitted volume types (line 326)
  - `allowPrivilegeEscalation=false`
  - `runAsNonRoot=true`
  - seccomp profile `RuntimeDefault` or `Localhost` (line 413)
  - capabilities dropping `ALL`, with only `NET_BIND_SERVICE` allowed to be added back (lines 429-451)
  
  The warning example in `tutorials/security/cluster-level-pss.md:283-307` lists the same fields.
- **Modes:**
  - **audit** records violations in the audit log without blocking them.
  - **warn** returns a warning to the user immediately (`tasks/configure-pod-container/migrate-from-psp.md:247-272`); the Pod is still created (`cluster-level-pss.md:303-306`).
  - **enforce** makes the policy take effect. A server-side dry run lists existing Pods that would violate it (`migrate-from-psp.md:253-260`). The page defining enforce's rejection behavior was not in the corpus **[U]**.
- **Gaps:** the security checklist says Pod security contexts still need investigating beyond the standard (`concepts/security/security-checklist.md:100-136`). Exempting namespaces such as `kube-system` requires strict RBAC (`cluster-level-pss.md:177-182`).

## 9. ServiceAccount tokens

- **[G]** Unless either the ServiceAccount or the Pod sets `automountServiceAccountToken: false`, admission adds a token volume at `/var/run/secrets/kubernetes.io/serviceaccount`. A ServiceAccount must exist; Pods without one are assigned `default` (`reference/access-authn-authz/service-accounts-admin.md:396-421`).
- **[C]** You can set `false` on the ServiceAccount or on the Pod. The Pod spec wins when both are set (`tasks/configure-pod-container/configure-service-account.md:67-100`).
- **Recommendation:** give each team a dedicated batch ServiceAccount with automount off, and also set it off in the Pod template.

## 10. Rollout and validation checklist

1. Label namespaces with `restricted` in **audit and warn** modes, run the server-side dry run, fix violations, then switch to **enforce** (Q8).
2. Disable token automount on ServiceAccounts and Pods (Q9).
3. Create PriorityClasses: interactive high; batch low with `preemptionPolicy: Never`; avoid a surprising `globalDefault` (Q4).
4. Add taints and labels to batch nodes; inject tolerations and required affinity through admission (Q3).
5. Add a ResourceQuota with a LimitRange per namespace, and consider scoped quotas for batch (Q5).
6. Configure the CronJob: `Forbid`, explicit `timeZone`, `startingDeadlineSeconds` of at least 10 seconds, idempotent Jobs keyed on the scheduled-timestamp annotation (Q1).
7. Configure the Job: `activeDeadlineSeconds`, `backoffLimit`, `restartPolicy: Never`, `ttlSecondsAfterFinished` (Q2).
8. Use a versioned, immutable ConfigMap and avoid subPath mounts and environment variables for settings that change (Q6).
9. Set requests equal to limits for critical services so they are evicted last (Q7).

**Limits that still need validation, because these documents do not guarantee them:**

- **Duplicate or missing CronJob runs:** the application must tolerate them; test idempotency (`cron-jobs.md:213-218`).
- **Checkpoint/resume:** neither preemption nor node-pressure eviction reliably honors PDBs or grace periods, so long Jobs need checkpointing or must accept losing their work (`pod-priority-preemption.md:230-238`; `node-pressure-eviction.md:31-36`).
- **Timing values:** `backoffLimit` and deadlines must be sized against real failure rates and run times, including whether evictions count as failures.
- **Quota behavior:** whether a new quota affects running Pods, and how quota rejections interact with Job retries.
- **ConfigMap propagation:** the actual delay on this cluster's kubelet cache strategy.
- **Time-zone database:** the controller hosts' time-zone database must be valid.