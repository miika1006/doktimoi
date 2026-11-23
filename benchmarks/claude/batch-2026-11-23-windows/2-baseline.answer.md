# Decision memo: production design review of the API Deployment

**Basis:** only the supplied Kubernetes v1.32 docs. Paths are relative to `docs/`. Each point is tagged **[G]** guarantee, **[C]** configuration choice, **[P]** prerequisite or **[N]** not established by these docs.

**Decision:** Don't approve the design as written. The PDB, the rollout settings, the 30-second grace period, the networking and the Secrets handling each fall short of what the team assumes. The fixes are below.

---

### 1. PDB `minAvailable: 5`

- **Node failure:** this is an involuntary disruption. A PDB can't prevent it, though it counts against the budget **[G]** (`concepts/workloads/pods/pod-disruptions.md`… correctly `concepts/workloads/pods/disruptions.md:21-50, 130-131`).
- **Node drain:** `kubectl drain` uses the Eviction API, which respects the PDB. It retries rejected evictions until it succeeds or times out **[G]** (`disruptions.md:106-121`). With six replicas and `minAvailable: 5`, only one Pod can be evicted at a time. Slow startup makes each drain step longer. The default unhealthy-Pod policy waits for Pods to become healthy, so set `AlwaysAllow` **[C]** (`disruptions.md:138-141`). Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:62-65`).
- **Rolling update:** Deployments are not limited by PDBs during rolling updates (`disruptions.md:133-136`). `maxUnavailable: 2` lets availability fall to 4, which breaks the stated goal of five **[G]** (`concepts/workloads/controllers/deployment.md:1191-1199`).
- **Recommendation [C]:** use `maxUnavailable: 0` and `maxSurge: 1`. Zero is allowed when surge is non-zero (`deployment.md:1194, 1203-1206`). Also set a `minReadySeconds` so new Pods must stay ready before they count as available (`deployment.md:1325-1328`), and a `progressDeadlineSeconds` larger than that value (`deployment.md:1314-1321`).

### 2. Spreading across zones

- **`maxSkew`** is the largest allowed difference in Pod count between domains. With `DoNotSchedule` it is measured against the global minimum. With `ScheduleAnyway` the scheduler only prefers placements that reduce skew (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`).
- **`topologyKey`** is a node label key. Each value of that label is one domain (`:117-122`).
- **`DoNotSchedule`** (the default) leaves a Pod unscheduled when the constraint can't be met. **`ScheduleAnyway`** schedules it anyway (`:124-126`).
- **`minDomains`** treats the global minimum as 0 when fewer eligible domains exist than required (`:107-115`).
- **Recommendation [C]:** use `topology.kubernetes.io/zone` with `maxSkew: 1`, plus a hostname constraint, as in the example at `:541-546`. Add `matchLabelKeys: [pod-template-hash]` so that old and new revisions are counted separately (`:134-160`).
- **Zone unavailable:** the scheduler learns domains only from nodes that exist (`:614-619`). Spread is not maintained after Pods are removed (`:607-608`). With `DoNotSchedule` and `minDomains: 3`, replacement Pods may stay Pending, so `ScheduleAnyway` at zone level gives better availability. How failed-but-still-registered nodes are counted is **[N]** and needs a test.

### 3. Probes for slow startup

- **startupProbe:** while it runs, the other probes are disabled. If it fails, the container is killed **[G]** (`concepts/workloads/pods/pod-lifecycle.md:492-497`). Allow startup time of at least `failureThreshold × periodSeconds`, for example 30 × 10 = 300 s. Liveness takes over after the first success (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:340-346`; `pod-lifecycle.md:546-557`).
- **readinessProbe:** it runs for the container's whole lifecycle. When it fails, the Pod is removed from Service endpoints and **traffic stops**, but the container is not restarted (`probes task:361-367, 412-421`; `pod-lifecycle.md:485-490`).
- **livenessProbe:** when it fails, the container **restarts** **[G]** (`pod-lifecycle.md:479-483`). Use a cheap endpoint with a higher `failureThreshold` than readiness, so a Pod goes unready before it is killed (`probes task:19-21`).
- **Delays:** liveness and readiness delays only begin after the startup probe succeeds (`probes task:398-402`).
- **Database:** a readiness check against the database is optional (`pod-lifecycle.md:524-528`). Don't put the database in liveness, because a database outage would then restart every replica. This is a design inference, not a documented rule.

### 4. Termination

1. The Pod is marked Terminating. The **grace-period clock starts**, and `preStop` runs inside that budget. If `preStop` overruns, there is a single 2-second extension (`pod-lifecycle.md:584-601`).
2. SIGTERM goes to PID 1 in each container (`:603-610`; image `STOPSIGNAL` may override it, `:572`).
3. *At the same time*, the Pod's endpoints are marked terminating with `ready: false`. The `serving` condition is still reported (`:612-632`). Endpoint removal is **concurrent with** shutdown, not ordered before it.
4. When the grace period expires, SIGKILL is sent and the Pod object is deleted (`:636-645`).
5. A kubelet restart restarts the full grace period (`:576-577`).

**30 seconds does not guarantee that requests finish.** Any request longer than the remaining time is killed. Set `terminationGracePeriodSeconds` ≥ longest request + `preStop` + margin **[C]**. Eviction uses the same setting (`disruptions.md:143-145`).

### 5. Resources

- **CPU limit:** enforced by throttling, a hard ceiling **[G]** (`concepts/configuration/manage-resources-containers.md:43-46, 252-254`).
- **Memory limit:** enforced reactively by OOM kills under memory pressure (`:48-53`).
- **CPU request:** acts as a weight under contention and is used for scheduling (`:255-258`).
- **Missing CPU requests:** CPU utilization is undefined and the HPA **takes no action** on that metric **[G]** (`tasks/run-application/horizontal-pod-autoscale.md:93-101, 256-260`). CPU requests are therefore a **[P]** prerequisite for autoscaling.
- **Memory limit:** setting one is **[C]**. Without it, memory use has no upper bound (`manage-resources-containers.md:295-296`).

### 6. HPA behaviour

- Pods that are being deleted or have failed are ignored. Pods with missing metrics, and CPU-based Pods that are not yet ready, are set aside (`horizontal-pod-autoscale.md:153-167`).
- The not-ready window is 30 s, and the CPU initialization period is 5 min (`:168-178`).
- **Missing metrics:** assumed to be 100% of target for scale-down and 0% for scale-up. **Not-yet-ready Pods:** assumed 0% for scale-up. Scaling is skipped if the recalculated ratio reverses direction or falls within the 0.1 tolerance (`:140-147, 183-197`).
- **Default downscale stabilization:** 5 minutes, using the highest recommendation in that window (`:213-218, 478-482`).
- **Result:** with slow startup, the actual scaling will differ from the raw ratio.

### 7. Least-privilege networking

- **[P]** A NetworkPolicy has **no effect** unless the network plugin enforces it (`concepts/services-networking/network-policies.md:16, 47-49`).
- **Isolation:** a Pod is isolated for egress or ingress only when a policy selecting it lists that `policyType`. Allowed traffic is the union of all applicable policies, so policies are additive (`:59-77`).
- **Both ends:** a connection needs egress allowed at the source **and** ingress allowed at the destination (`:79-81`).
- **Plan:**
  - default-deny ingress and egress (`:214-268`);
  - allow ingress from the Service's clients on the app port;
  - allow egress to the database, with matching ingress on the database side;
  - allow egress for DNS.
- **DNS:** the docs say nothing specific about DNS. Port, protocol and selector are **[N]**.
- **Caveats:** deny-all is only guaranteed for TCP, UDP and SCTP (`:275-279`). A new Pod may start unprotected or without connectivity until the plugin applies the rules (`:360-384`).

### 8. Secrets

- Base64 is "obscured but not secret" (`concepts/configuration/secret.md:305-307`).
- Secrets are stored unencrypted in etcd by default (`:36-37`). Base64 Secrets in Git are therefore effectively plaintext for anyone with repository access (inference).
- **[P]** Enable encryption at rest. The default `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:64-66, 234-235`). Existing Secrets must be rewritten to become encrypted (`:594-604`).
- **[C]** Grant least-privilege RBAC (`secret.md:42-48`). `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:93-98`).
- **Why Pod creation matters:** anyone who can create a Pod, or a Deployment, can read every Secret in the namespace and act as any service account there (`secret.md:38-40`; `rbac-good-practices.md:101-108`).
- Consider an external secret store (`secret.md:47`).

### 9. Storage reclaim

- **Changing the StorageClass:** its `reclaimPolicy` applies when a PV is dynamically provisioned. If unset, it defaults to `Delete` (`concepts/storage/storage-classes.md:34-36, 128-132`). Existing PVs keep their own policy and must be patched individually (`concepts/storage/persistent-volumes.md:203-210`). That changing the class leaves existing PVs untouched is inferred from these passages, not stated outright.
- **Retain vs Delete:**
  - **Retain:** after the PVC is deleted, the PV is "Released" and the data stays until an admin cleans it up manually (`:185-199`).
  - **Delete:** removes both the PV and the external storage asset (`:201-206`).
- **PVC deletion:** triggers the reclaim policy.
- **StatefulSet deletion or scale-down:** does *not* delete volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). This changes only if `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`) is set to `Delete` (`:391-416, 440-446`). The API Deployment itself should hold no PVC data.

### 10. Prioritized rollout and validation checklist

1. Encrypt Secrets at rest and rewrite existing ones. Remove Secrets from Git. Tighten RBAC, including who can create Pods or Deployments.
2. Set CPU and memory requests, and a memory limit. Without CPU requests the HPA is inert.
3. Add startup, readiness and liveness probes. Set `minReadySeconds`.
4. Use rollout `maxUnavailable: 0` / `maxSurge: 1`. Keep the PDB at `minAvailable: 5` (or `maxUnavailable: 1`) with `AlwaysAllow`.
5. Raise `terminationGracePeriodSeconds` above the longest request plus `preStop`.
6. Add zone and host spread with `matchLabelKeys`.
7. Confirm the CNI enforces NetworkPolicy. Then apply default-deny plus explicit allows for clients, the database and DNS. Test both ends of each connection.
8. Set the database storage to `Retain`, patch existing PVs, and confirm the StatefulSet retention policy.
9. Validate with drills: a node drain, a rolling update under load, loss of a zone, and HPA scaling during startup.

**Limits that still need validation, because these docs don't guarantee them:**

- **[N]** The real request duration and shutdown time against the grace period, and whether the load balancer and endpoints stop traffic before SIGTERM. Removal happens concurrently, not first.
- **[N]** Whether a zone outage leaves Pods Pending under `DoNotSchedule`. Whether the node autoscaler knows about the zones (`topology-spread-constraints.md:614-623`).
- **[N]** Which CNI is installed, whether it supports NetworkPolicy, how long rules take to apply, and the exact DNS endpoints.
- **[N]** Whether the cluster or provider runs automated voluntary disruptions (`disruptions.md:81-89`).
- **[N]** The database's own failover and consistency behaviour. Kubernetes storage policies only govern volume lifecycle.