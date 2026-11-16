# Batch platform design review: decision memo (Kubernetes v1.32 docs)

All paths are relative to `docs/`. Each point is labelled as a **Guarantee** (documented behaviour), a **Config** (a choice we make), a **Prereq** (something that must already be in place) or a **Gap** (something the docs don't establish). One limit on sources: several pages link to `concepts/security/pod-security-admission.md`, but that file isn't in the corpus.

## 1. Does a CronJob create exactly one Job per schedule?

No. **Guarantee:** a CronJob creates a Job "approximately once" per scheduled time. Sometimes it creates two Jobs or none, so the Jobs must be idempotent (`concepts/workloads/controllers/cron-jobs.md:211-218`). In v1.32 each Job carries the annotation `batch.kubernetes.io/cronjob-scheduled-timestamp` (`:220-222`), which jobs can use to detect duplicate runs.

- **concurrencyPolicy (Config):** the options are `Allow` (the default), `Forbid` and `Replace` (`:128-143`).
  - `Forbid` skips a run while the previous one is still going. Once the previous run finishes, `startingDeadlineSeconds` can still trigger a late run.
  - `Replace` stops a Job that is still running. For reports that take hours, this means lost work.
  - The policy only applies within one CronJob (`:142-143`).
- **startingDeadlineSeconds:** this is how late a run may start before it is skipped and counted as failed. If it's unset, there's no deadline (`:107-126`). A value under 10 s may mean the run never starts, because the controller checks every 10 s (`:228-230`).
- **Missed schedules:** if more than 100 runs were missed, the controller won't start a Job. When the deadline is set, it counts misses only within that deadline window. A run skipped under `Forbid` counts as missed (`:233-244`). Only `Allow` with an unset or large deadline gives "at least once" (`:224-226`).
- **Time zone:** without `.spec.timeZone`, the schedule uses the kube-controller-manager's local time zone (`cron-jobs.md:176-188`). If the zone name later becomes invalid, the controller stops creating Jobs and emits an `UnknownTimeZone` event (`reference/kubernetes-api/workload-resources/cron-job-v1.md:57-90`).

**Recommendation:** set `timeZone` explicitly, use `Forbid`, and set a deadline of a few hours. Make the job idempotent, keyed on the scheduled-timestamp annotation.

## 2. How do the Job limits interact?

- **backoffLimit (Guarantee):** the default is 6. Failed Pods are recreated with exponential back-off (10 s, 20 s, 40 s…, capped at 6 min). With `OnFailure`, container restarts count towards the limit too. When the limit is reached, the Job fails (`concepts/workloads/controllers/job.md:358-382`) and its running Pods are terminated (`:622-625`).
- **restartPolicy:** a Job needs `OnFailure` or `Never`; the Pod default is `Always` (`job.md:1186-1194`). With `OnFailure`, the Pod is terminated at the limit, which makes debugging harder, so the docs suggest `Never` (`:377-382`).
- **activeDeadlineSeconds:** this limits the Job's total duration, however many Pods it creates. When it's reached, Pods are terminated and the Job gets `reason: DeadlineExceeded`. It **takes precedence over backoffLimit** (`job.md:627-636`), so the deadline wins.
  - The Pod template has its own field with the same name, so set it at the right level (`:656-658`).
  - Suspending a Job resets the timer (`reference/kubernetes-api/workload-resources/job-v1.md:101-107`).
- **ttlSecondsAfterFinished:** this only applies after the Job is Complete or Failed. It then deletes the Job and its Pods together, and finalizers are honoured. Unset means no automatic deletion (`job.md:737-793`).

**Gap:** with a short TTL, logs from failed Pods disappear. A log pipeline needs to be in place before the TTL is shortened.

## 3. How do we keep batch Pods on the batch nodes?

You need both mechanisms.

- **Taints keep other Pods off; they don't pull Pods on.** A toleration allows a Pod onto the dedicated nodes "as well as any other nodes". To keep batch Pods *only* there, you also need a node label plus a required node affinity, ideally injected by an admission controller (`concepts/scheduling-eviction/taint-and-toleration.md:176-191`).
- **Node affinity:** `requiredDuringSchedulingIgnoredDuringExecution` is a hard rule, while `preferred…` is not. If node labels change, Pods already running keep running (`concepts/scheduling-eviction/assign-pod-node.md:103-157`).
- **NoSchedule vs NoExecute:** `NoSchedule` blocks new Pods without the matching toleration, but doesn't evict running ones. `NoExecute` also evicts Pods that don't tolerate it, unless they set `tolerationSeconds`. `PreferNoSchedule` is only a soft preference (`taint-and-toleration.md:101-150`, `:157-174`).
- **Prereq (DaemonSets):** DaemonSets get some NoExecute tolerations automatically, for unreachable and not-ready nodes (`taint-and-toleration.md:261-290`). Any DaemonSet that needs to run on batch nodes has to tolerate the dedicated taint as well.

**Recommendation:** use `NoSchedule` to start with, so Pods already running there aren't evicted. Use `NoExecute` only for a deliberate cleanup.

## 4. How do priority and preemption make batch Pods yield?

- **Config:** give batch a low-value PriorityClass and interactive services a higher one. `globalDefault` sets the priority for Pods that have no class (`reference/kubernetes-api/workload-resources/priority-class-v1.md:29-59`). A Pod that names a class that doesn't exist is rejected (`concepts/scheduling-eviction/pod-priority-preemption.md:154`).
- **preemptionPolicy:** `Never` jumps the queue but never preempts, and such Pods can still be preempted themselves (`pod-priority-preemption.md:103-147`). It's useful for batch that should go ahead of other batch without killing anything.
- **Guarantee (victim shutdown):** preempted Pods get their normal graceful termination period, which delays the preemptor Pod. The docs suggest a small grace period for low-priority Pods (`:214-228`). That conflicts with checkpointing a job that runs for hours, so we have to choose.
- **PDBs:** they are honoured only on a best-effort basis. If no victims can be found without violating a PDB, preemption happens anyway (`:230-238`).

## 5. What does a ResourceQuota require, and does it affect running Pods?

- **Prereq:** once a namespace has a `cpu`/`memory` quota, every new Pod must set requests or limits for those resources, or it may be rejected. A LimitRange can supply defaults (`concepts/policy/resource-quotas.md:1-46`, `:48-62`).
- **Guarantee:** a request that would exceed the quota fails with `403 FORBIDDEN` (`:36-37`).
  - The Pod is never created, so the Job controller has to keep retrying. How backoffLimit treats that isn't documented here (**Gap**).
- **Guarantee:** changes to a quota "will not affect already created resources". If the quotas add up to more than the cluster's capacity, it's first come, first served (`:74-77`).
- **Gap:** a quota doesn't reserve capacity.

## 6. Who sees ConfigMap edits, and when?

| Consumer | Sees edits? | Source |
|---|---|---|
| Volume mount | Eventually: after the kubelet sync period plus the cache delay (watch, TTL or direct). The task page says up to about 1 min + 1 min with defaults. | `concepts/configuration/configmap.md:191-209`; `tasks/configure-pod-container/configure-pod-configmap.md:743-761` |
| subPath mount | Never | same ranges |
| Environment variables | Only after the Pod restarts | `configmap.md:205` |
| Immutable ConfigMap | Can't be edited or made mutable again. Delete and recreate it, then recreate the Pods. | `configmap.md:299-328`; `tutorials/configuration/updating-configuration-via-a-configmap.md:723-734` |

**Decision:** the docs don't define when a job reads its settings (**Gap**). A report that runs for hours could pick up a daytime edit halfway through. Use versioned, immutable ConfigMaps that each Job references by name, or read the config once at startup.

## 7. Which Pods does the kubelet evict under memory pressure?

- **Order (Guarantee):** first, Pods whose usage exceeds their requests, ranked by priority and then by how far over they are. Then Pods within their requests, by priority. The kubelet doesn't use QoS class directly (`concepts/scheduling-eviction/node-pressure-eviction.md:318-362`).
  - A low-priority Pod that stays within its requests is not evicted before a higher-priority Pod that is over its requests (`pod-priority-preemption.md:343-369`).
- **No PDB, no termination grace period:** eviction for node pressure ignores PDBs and `terminationGracePeriodSeconds`. Soft thresholds use `eviction-max-pod-grace-period`; hard thresholds use 0 s (`node-pressure-eviction.md:2-36`).
- **Config:** give batch Pods memory requests equal to their limits, so they are Guaranteed. The security checklist also recommends memory limit ≤ request (`concepts/security/security-checklist.md:100-136`).
- **Gap:** an evicted Pod ends up Failed (`:28-29`), so it probably counts against backoffLimit, but the docs don't state this.

## 8. What does the restricted Pod Security Standard require?

- **Requirements:** everything in Baseline, plus:
  - only these volume types: configMap, csi, downwardAPI, emptyDir, ephemeral, PVC, projected, secret;
  - `allowPrivilegeEscalation: false`;
  - `runAsNonRoot: true`, and no `runAsUser: 0`;
  - a seccomp profile of `RuntimeDefault` or `Localhost` (no profile at all is prohibited);
  - capabilities drop `ALL`, adding back only `NET_BIND_SERVICE`.

  If any container fails, the whole Pod fails (`concepts/security/pod-security-standards.md:300-445`).
- **Modes (Guarantee):** `enforce` prohibits creating a non-compliant Pod. `audit` allows it and records an annotation. `warn` allows it and returns a warning, including for Job and CronJob templates (`reference/labels-annotations-taints/_index.md:2370-2451`).
- **Rollout:** first do a server-side dry run of the enforce label, then audit or warn for a soak period (`tasks/configure-pod-container/migrate-from-psp.md:247-272`). Exempting `kube-system` needs strict RBAC (`tutorials/security/cluster-level-pss.md:159-215`).
- **Gap:** enforce only rejects Pods. Since `warn` also reports on Job templates, use warn first. Otherwise a non-compliant CronJob is accepted, but its Pods are refused every night.

## 9. How do Pods avoid holding API credentials they don't need?

- **Config:** set `automountServiceAccountToken: false` on the ServiceAccount, on the Pod, or on both. If both set a value, the Pod spec wins (`tasks/configure-pod-container/configure-service-account.md:67-100`).
- **Recommendation:** turn it off on each namespace's `default` ServiceAccount. Give the Jobs that really need the API their own ServiceAccount with minimal RBAC.

## 10. Prioritized rollout and validation checklist

1. **Pod Security:** apply restricted in `warn` + `audit` and dry-run the enforce label. Fix the templates, then switch to `enforce` (Q8).
2. **API credentials:** disable token automount by default (Q9).
3. **Quota:** create a LimitRange and ResourceQuota in each namespace, and set memory requests equal to limits (Q5, Q7).
4. **Priority:** create the PriorityClasses and decide on a `globalDefault`. Test that interactive Pods preempt batch (Q4).
5. **Batch node placement:** a NoSchedule taint plus a required node affinity, ideally injected by admission. Check DaemonSet tolerations (Q3).
6. **CronJob:** an explicit `timeZone`, `Forbid`, a deadline of at least 10 s (in practice hours), and idempotent jobs (Q1).
7. **Job limits:** `restartPolicy: Never`, `activeDeadlineSeconds` above the worst-case run time, and a TTL only after log shipping is in place (Q2).
8. **Config:** versioned immutable ConfigMaps, no subPath for live config (Q6).

**Limits that still need validation, not guaranteed by these documents:**
- The real CronJob run rate. Duplicate or missed runs remain possible, so idempotency must be tested.
- How long the job takes to shut down within its termination grace period after preemption, and whether its checkpoints survive. PDBs are best effort, and node-pressure eviction can kill with a 0 s grace period.
- Whether the batch nodes are actually large enough for the quotas, given that quota doesn't reserve capacity.
- The kubelet's actual ConfigMap propagation delay and eviction thresholds on our nodes.
- Whether the job images run as non-root with the RuntimeDefault seccomp profile and all capabilities dropped.
- How preemptions, evictions and quota rejections count against backoffLimit.