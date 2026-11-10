# Decision memo: production review of the six-replica API design

**Basis:** only the supplied Kubernetes v1.32 docs under `docs/`. Paths below are relative to that folder. **Labels:** *Guarantee* means documented platform behaviour. *Config* means a choice the team makes. *Prereq* means something that must already exist in the cluster. *Not established* means the docs do not settle it.

**Verdict:** do not approve the design as written. The PDB and the rollout settings contradict each other. The 30-second grace period is not shown to be enough for long requests. Default-allow networking and Secrets in Git do not meet the documented good practice. The reclaim policy of the dynamically provisioned storage has to be checked.

---

### 1. Does `minAvailable: 5` guarantee five replicas?

No, and none of the three cases are covered.

- **Node failure:** a PDB "does not truly guarantee" the count. A node can fail while the set is already at the minimum, and the budget "can only protect against voluntary evictions" (*Guarantee*, `tasks/run-application/configure-pdb.md:149-156`).
- **Node drain:** the PDB does apply, because drain uses eviction. Evictions that would break the budget are refused, so the drain blocks until replacements become available or capacity is added (`concepts/workloads/pods/disruptions.md:190-226`). With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time. Pods evicted this way are still terminated gracefully (`disruptions.md:143-145`). The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy so that misbehaving Pods do not stall drains (`disruptions.md:138-141`).
- **Deployment rolling update:** the PDB does not limit it. Workload resources "are not limited by PDBs when doing rolling upgrades"; the workload's own spec controls this instead (`disruptions.md:133-136`). With `maxUnavailable: 2` the rollout may drop to 4 available Pods (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommendation (*Config*):** set `maxUnavailable: 0` and `maxSurge: 1`. Both cannot be 0 at the same time (`deployment.md:1194, 1201-1206`). Express the PDB as `maxUnavailable: 1`, which the docs recommend because it follows replica-count changes (`configure-pdb.md:174-176`). Do not set it to 0 or 100%, or drains will never complete (`configure-pdb.md:158-162`). Surge needs spare cluster capacity (*Prereq*).

### 2. How should replicas be spread across zones?

- `maxSkew` sets how uneven the Pods may be.
  - Under `DoNotSchedule` it is the largest allowed difference from the global minimum across eligible domains, so it is a hard rule.
  - Under `ScheduleAnyway` it only raises the priority of placements that reduce skew.

  Source: `concepts/scheduling-eviction/topology-spread-constraints.md:83-93`.
- `ScheduleAnyway` keeps the Pod schedulable. Its preference is "jointly normalized" with other scheduling priorities (`topology-spread-constraints.md:350-354`).
- Without explicit constraints, the built-in default is only `maxSkew: 5` on zone with `ScheduleAnyway` (`topology-spread-constraints.md:537-547`). With six Pods, that is too loose to enforce a 2/2/2 spread.

**Recommendation (*Config*):** set `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1`, `DoNotSchedule`. Add a hostname constraint with `ScheduleAnyway`.

**When a zone is unavailable (*Not established* as safe):**
- With `DoNotSchedule`, replacement Pods can stay Pending rather than pile into the surviving zones. That is the trade-off; the docs do not prescribe a choice.
- The scheduler learns zones only from existing nodes, so a zone scaled to zero nodes is not considered (`topology-spread-constraints.md:613-618`).
- Nothing guarantees the spread is kept when Pods are removed, for example on scale-down (`topology-spread-constraints.md:607-608`).

### 3. Which probes fit slow startup?

- **Startup probe:** set `failureThreshold × periodSeconds` to cover the worst-case startup (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
  - All other probes are disabled until it succeeds.
  - If it fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:494-499`).
  - Liveness and readiness delays start only after the startup probe succeeds (`configure-liveness-readiness-startup-probes.md:398-402`).
- **When traffic stops:** when the readiness probe fails `failureThreshold` times. The Pod's IP is then removed from Service endpoints and the container keeps running (`pod-lifecycle.md:486-491`; `configure-liveness-readiness-startup-probes.md:420-424`).
- **When a container restarts:** when the liveness or startup probe reaches `failureThreshold`. That restart honours `terminationGracePeriodSeconds` (`configure-liveness-readiness-startup-probes.md:417-419`).

**Recommendation (*Config*):** readiness should check whether the Pod can serve, including its dependencies if the team wants that. Liveness should only detect deadlock. The real startup time is *Not established* by the docs and must be measured.

### 4. Termination order, and whether 30 seconds is enough

The sequence (*Guarantee*):
1. The Pod is marked as terminating.
2. `preStop` runs inside the grace period, which defaults to 30 s. If `preStop` is still running when the period ends, the kubelet adds a one-off 2-second extension (`pod-lifecycle.md:584-603`).
3. Process 1 in each container receives TERM, in arbitrary order across containers (`pod-lifecycle.md:605-610`).
4. When the grace period expires, any remaining processes receive SIGKILL (`pod-lifecycle.md:636-640`).

At the same time, the endpoints stay in the EndpointSlice but are marked terminating with `ready=false`. Load balancers therefore stop sending regular traffic to them, and consumers can check `serving` to drain connections (`pod-lifecycle.md:612-631`; `concepts/services-networking/endpoint-slices.md:100-117`).

**Is 30 s enough?** Not guaranteed. The docs say that if `preStop` needs longer, you "must modify `terminationGracePeriodSeconds`" (`pod-lifecycle.md:600-603`). **Recommendation:** set the grace period to at least the longest request time plus the `preStop` time.

### 5. Resources, throttling versus OOM, and HPA

- **CPU limit:** a hard limit, enforced by throttling.
- **Memory limit:** enforced reactively by OOM kill under memory pressure (`concepts/configuration/manage-resources-containers.md:44-58`).
- **Requests:** a container may use more than its request when the node has room (`manage-resources-containers.md:29-34`). If only a limit is set, the limit is copied into the request (`manage-resources-containers.md:63-67`).
- **HPA:** utilization is calculated as a percentage of the request. If a container lacks a CPU request, utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`).

**Recommendation (*Config*):** set CPU requests on every container and memory limits. Validate whether CPU limits are needed, because throttling stretches long requests.

### 6. How HPA handles missing metrics and not-ready Pods

- Pods being deleted are ignored, and failed Pods are discarded.
- Pods with missing metrics are set aside.
- For CPU, Pods that are not yet ready, or whose metric predates readiness, are also set aside (`horizontal-pod-autoscale.md:154-165`). The readiness delay defaults to 30 s and the CPU initialization period to 5 minutes (`horizontal-pod-autoscale.md:167-178`).
- Missing-metric Pods are then counted as 100% for scale-down and 0% for scale-up. Not-ready Pods count as 0% for scale-up.
- If the adjusted ratio reverses direction or falls within tolerance, nothing scales. The status still reports the original average (`horizontal-pod-autoscale.md:180-202`). The default tolerance is 0.1 (`horizontal-pod-autoscale.md:146-148`).
- **Downscale stabilization:** 300 s by default. Scale-up has no window and adds at most 4 Pods or 100% every 15 s (`horizontal-pod-autoscale.md:455-486`).

So actual scaling can differ from the raw ratio. Slow startup lengthens the not-ready period.

**Prereq:** a metrics API, usually Metrics Server, which is launched separately (`horizontal-pod-autoscale.md:114-117`).

### 7. Replacing default-allow networking

- **Isolation:** Pods are non-isolated by default. A policy that selects a Pod and lists `Ingress` or `Egress` in `policyTypes` isolates that direction.
- **Additive:** allowed connections are the union of all applicable policies, so evaluation order does not matter.
- **Both ends:** a connection needs the source's egress and the destination's ingress to allow it (`concepts/services-networking/network-policies.md:52-81`).
- **Plan (*Config*):** default-deny both directions (`network-policies.md:254-262`). Then allow ingress from the Service's clients, and egress to the database (whose own ingress must also allow the API) and to DNS.
- **DNS:** a default-deny egress policy blocks all egress (`network-policies.md:234-242`), which implies DNS is blocked too. The docs I searched give no DNS-specific rule (*Not established*), so DNS egress must be tested.
- **CNI support (*Prereq*):** without a network plugin that implements NetworkPolicy, the policies have no effect (`network-policies.md:45-49`).

### 8. Is base64 enough to protect Secrets?

No. Base64 is "obscured but not secret" (`concepts/configuration/secret.md:303-305`). By default, Secrets are stored unencrypted in etcd. Anyone with API access or etcd access can read them. Anyone who can create a Pod, or indirectly a Deployment, in the namespace can read any Secret in that namespace (`secret.md:35-41`).

**Required steps** (`secret.md:43-48`):
- Enable encryption at rest. A raw key in the EncryptionConfig only moderately improves security; KMS is preferred (`tasks/administer-cluster/encrypt-data.md:355-367`).
- Use least-privilege RBAC: namespace-scoped RoleBindings and no wildcards (`concepts/security/rbac-good-practices.md:25-45`).
- Restrict Secret access to specific containers.
- Consider an external secret store.

Base64 values committed to Git are effectively plaintext, so remove them from Git.

### 9. StorageClass reclaim policy and existing PVs

- Dynamically provisioned PVs take their policy from the class's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`).
- Changing the class does not change existing PVs. They "must be edited or patched after" creation (`concepts/storage/persistent-volumes.md:203-210`). Manually created PVs keep the policy they were given (`storage-classes.md:134-135`).
- **Delete:** removes both the PV and the external storage asset when the claim is deleted (`persistent-volumes.md:203-206`).
- **Retain:** the PV becomes "released" and the data is cleaned up manually (`persistent-volumes.md:185-199`).
- **StatefulSet versus PVC deletion:** PVCs created by a StatefulSet are kept by default when the StatefulSet is deleted or scaled down. The `whenDeleted` and `whenScaled` settings can make them `Delete`. These settings apply only to deletion and scale-down; on node failure the PVC is kept (`concepts/workloads/controllers/statefulset.md:387-422`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-142`).
- **Recommendation:** use `Retain` for database volumes and patch any existing PVs.

### 10. Prioritized rollout and validation checklist

1. Encrypt Secrets at rest (KMS), remove them from Git, and tighten RBAC, including who can create Pods (Q8).
2. Patch database PVs to `Retain` and verify the StatefulSet retention settings (Q9).
3. Fix the rollout: `maxUnavailable: 0` and `maxSurge: 1`, plus a PDB with `maxUnavailable: 1` and `AlwaysAllow` (Q1).
4. Set CPU and memory requests and memory limits, then confirm the HPA reads utilization (Q5, Q6).
5. Add startup, readiness and liveness probes sized to measured startup time (Q3).
6. Size the grace period and `preStop` to the longest request (Q4).
7. Add zone spread constraints (Q2).
8. Apply default-deny network policy plus allow-lists after confirming the CNI enforces it (Q7).
9. Test: a node drain, a rollout under load, a zone outage, a failed DNS lookup, and an HPA scale-up while Pods are starting.

**Limits that need application or cluster validation, because the docs do not guarantee them:**
- The worst-case startup and request durations, and therefore the probe thresholds and the grace period.
- Whether the CNI enforces NetworkPolicy, and which DNS endpoints need egress.
- Spare capacity for surge and for rescheduling after a zone loss. Drains block without it.
- Whether the HPA's response is fast enough given the 30 s / 5 min readiness windows and the 300 s downscale window.
- How the database handles connection churn during rollouts.
- How the storage driver behaves under `Delete` and `Retain`.