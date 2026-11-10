# Decision memo: production readiness review of the zone-spread API Deployment

**Corpus:** the supplied Kubernetes v1.32 docs. All paths are relative to `docs/`, and line ranges are given as `path:start-end`.
**Labels used below:** **G** = documented guarantee, **C** = configuration choice, **P** = prerequisite, **N** = not established by the docs.

**Verdict:** Don't approve the design as written. Four parts are unsafe or misunderstood: the PDB and rollout interaction, the 30 s grace period for long requests, default-allow networking, and base64 Secrets in Git. It can be approved once the changes below are made.

---

### 1. Does `minAvailable: 5` guarantee five replicas?

No, it only does so in one of the three cases.

- **Node failure (involuntary):** **G** PDBs cannot prevent involuntary disruptions, though those disruptions do count against the budget (`concepts/workloads/pods/disruptions.md:130-131`). A single node holding two replicas would leave four.
- **Node drain:** **G** `kubectl drain` goes through the Eviction API, which respects the PDB. Rejected evictions are retried until they succeed or a timeout is reached (`disruptions.md:107-121`). With six desired replicas and `minAvailable: 5`, one Pod can be evicted at a time. Evicted Pods still honor `terminationGracePeriodSeconds` (`:143-145`). **C** Set `unhealthyPodEvictionPolicy: AlwaysAllow` so that Pods that are already unhealthy don't block a drain (`:138-141`; `tasks/run-application/configure-pdb.md:248-266`). **N** Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:62-65`).
- **Rolling update:** **G** Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can fall to 4 of 6 (`concepts/workloads/controllers/deployment.md:1191-1199`).

**Recommendation:** use `maxUnavailable: 0, maxSurge: 1` (or 2). `maxUnavailable` may be 0 only when `maxSurge` is non-zero (`deployment.md:1194, 1203-1206`). Add `minReadySeconds` and a `progressDeadlineSeconds` that is longer than the worst-case startup (`deployment.md:1314-1325`). Also, the PDB's "intended" count comes from `.spec.replicas` (`disruptions.md:126-128`). Once HPA scales the Deployment out, `minAvailable: 5` becomes a much weaker limit, so consider `maxUnavailable: 1` on the PDB instead.

### 2. Zone spreading

- **C** Use `maxSkew: 1`, `topologyKey: topology.kubernetes.io/zone` and `whenUnsatisfiable: DoNotSchedule`, which gives 2/2/2.
- **C** Add a second constraint on `kubernetes.io/hostname` with `ScheduleAnyway`. The docs show combining several constraints like this (`concepts/scheduling-eviction/topology-spread-constraints.md:536-546`).
- **C** Add `matchLabelKeys: [pod-template-hash]` so that spreading is calculated per revision during a rollout (`:134-146`).

How the fields work:

- **`maxSkew`:** with `DoNotSchedule`, this is the maximum allowed difference from the global minimum. With `ScheduleAnyway`, it only gives preference to placements that reduce skew (`:82-93`).
- **`topologyKey`:** the node label whose values define the domains (`:117-122`).
- **`DoNotSchedule` vs `ScheduleAnyway`:** `DoNotSchedule` (the default) refuses to schedule a Pod that would violate the constraint. `ScheduleAnyway` schedules it while keeping skew as low as possible (`:124-126`).

What happens when a zone is unavailable:

- **G** A violating Pod stays `Pending` (`:416-423`).
- Domains are discovered only from nodes that exist (`:610-616`).
- Pods on tainted nodes still count (`:609`).
- **G** Removing Pods doesn't rebalance them (`:607-608`).
- **N** The docs don't spell out the exact rescheduling outcome during a real zone outage. This must be tested: `DoNotSchedule` may leave replacement Pods `Pending`.

### 3. Probes for slow startup

- **startupProbe:** **G** While a startup probe is defined, all other probes are disabled until it succeeds. If it fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:492-497`). **C** Set `failureThreshold × periodSeconds` to cover the worst-case startup. For example, 30 × 10 gives 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **Other probes begin** only after the startup probe succeeds. Liveness and readiness delays also start counting from that point (`:398-402`).
- **readinessProbe:** **G** When it fails, the Pod is removed from Service endpoints and stops receiving traffic, but it is not restarted (`pod-lifecycle.md:485-490`; probes doc `:419-422`).
- **livenessProbe:** **G** After `failureThreshold` consecutive failures, the container is restarted (`probes doc:413-418`; `pod-lifecycle.md:479-483`).
- **C** Keep liveness checks shallow. Liveness should not depend on the database; put dependency checks in readiness (`probes doc:350-358`). This last point is design judgment: the docs only describe readiness as the place for external-dependency unavailability.

### 4. Termination order and the 30-second budget

1. The Pod is marked Terminating and the grace-period clock starts. The default is 30 s (`pod-lifecycle.md:579-589`).
2. `preStop` runs inside that budget. If it is still running when the budget expires, the kubelet grants a one-time 2 s extension (`:591-600`).
3. SIGTERM is then sent to each container's PID 1. If there are no sidecars, the order between containers is arbitrary (`:604-610`).
4. At the same time, the control plane marks the endpoint as terminating with `ready=false`, so load balancers stop sending regular traffic. The `serving` condition can be used for draining (`:612-633`).
5. When the grace period expires, remaining processes get SIGKILL (`:635-640`).

**Is 30 s enough?** No. Nothing here guarantees that long requests will finish. **C** Set `terminationGracePeriodSeconds` to at least preStop delay + longest request + margin (`:599-601`). **N** How fast endpoint updates propagate to kube-proxy and external load balancers isn't established by the docs.

### 5. CPU and memory resources

- **CPU limit:** **G** enforced by throttling. It is a hard cap (`concepts/configuration/manage-resources-containers.md:43-46`).
- **Memory limit:** **G** enforced reactively by OOM kills, which happen only under memory pressure (`:48-53`).
- **Limit without a request:** **G** the request is copied from the limit, unless an admission mechanism sets a default (`:64-68`).
- **Effect on HPA:** **G** If any container lacks a CPU request, the Pod's utilization is undefined and HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:90-101`).
- **C** Set CPU requests on every container, including sidecars. Set a memory limit. Treat a CPU limit with care, because throttling during slow startup can delay probe success (inference; **N**).

### 6. HPA behaviour

- **G** Pods being deleted are ignored, and failed Pods are discarded. Pods with missing metrics, and Pods that are not yet ready (for CPU scaling), are set aside (`horizontal-pod-autoscale.md:153-166`). The readiness window defaults are 30 s and 5 min (`:168-179`).
- **G** Missing Pods are then assumed to use 100% for scale-down and 0% for scale-up. Not-yet-ready Pods are assumed to use 0% for scale-up. If the result reverses direction or falls within the tolerance (0.1), the HPA does nothing (`:146-147, 183-197`).
- **G** The status shows the raw average, not the adjusted one (`:199-202`).
- **G** Downscale stabilization takes the highest recommendation over the last 300 s (`:211-217, 478-486`).

As a result, scaling can lag or undershoot the raw ratio, especially with slow-starting Pods.

### 7. Least-privilege networking

- **P** A network plugin that enforces NetworkPolicy is required. Without one, policies have no effect (`concepts/services-networking/network-policies.md:16, 47-49`). **N** Enforcement is eventual, with no timing guarantee (`:362-381`).
- **G** A Pod becomes isolated in a direction only when some policy selects it with that `policyType`. Allowed connections then combine additively as a union, and evaluation order doesn't matter (`:59-77`).
- **G** A connection needs both egress on the source and ingress on the destination to allow it (`:79-81`).

**C** Recommended setup:

- Default-deny ingress and egress in the namespace.
- Allow ingress from the ingress controller on the API port.
- Allow API → database egress, plus matching ingress on the database side.
- Allow DNS egress. Default-deny plus a DNS allowance is recommended in `concepts/security/multi-tenancy.md:215-222`. **N** The DNS port and labels are not specified in this corpus and must be verified.

### 8. Secrets

Base64 is not protection. **G** Base64 is "obscured but not secret" (`concepts/configuration/secret.md:306`). Secrets are stored unencrypted in etcd by default (`:36-37`).

- **Encryption at rest:** **P** Enable it with a non-`identity` first provider (`tasks/administer-cluster/encrypt-data.md:60-73, 95-98`). Then rewrite existing Secrets (`:603`).
- **RBAC:** **C** Grant least privilege (`secret.md:41-49`). `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:92-98`).
- **Pod creation:** **G** Anyone who can create Pods, or a Deployment, in a namespace can read every Secret there and act as any ServiceAccount in it (`secret.md:38-40`; `rbac-good-practices.md:100-108`).
- **Git:** Remove the Secret values from Git and rotate them. The docs suggest external secret store providers (`secret.md:47`). **N** Git practices themselves aren't covered.

### 9. Storage reclaim policy

- **G** A StorageClass `reclaimPolicy` applies only to PVs it provisions dynamically, and defaults to `Delete`. Manually created PVs keep the policy they were given (`concepts/storage/storage-classes.md:127-135`). Changing the class therefore doesn't change existing PVs. Those must be patched individually (`concepts/storage/persistent-volumes.md:203-210`).
- **Retain:** after the PVC is deleted, the PV is Released and its data stays. Cleanup is manual (`:185-201`).
- **Delete:** removes both the PV and the backing storage asset (`:203-206`).
- **StatefulSet:** deleting it or scaling it down does not delete its PVCs by default (`concepts/workloads/controllers/statefulset.md:52-54`). The optional `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`) controls this (`:389-412`).

**C** Use `Retain` for database volumes.

### 10. Prioritized rollout and validation checklist

1. Remove the Secrets from Git, rotate them, enable encryption at rest and rewrite existing Secrets, and tighten RBAC, including who can create workloads (Q8).
2. Confirm the CNI enforces NetworkPolicy, then apply default-deny plus explicit allows for ingress, the database and DNS (Q7).
3. Set CPU and memory requests on every container (Q5).
4. Add startup, readiness and liveness probes sized to the measured worst-case startup (Q3).
5. Change the rollout to `maxUnavailable: 0, maxSurge: 1`, with `minReadySeconds` and `progressDeadlineSeconds`. Use a PDB of `maxUnavailable: 1` with `AlwaysAllow` (Q1).
6. Add zone and hostname topology spread constraints with `matchLabelKeys` (Q2).
7. Raise the grace period above the longest request time, and add a `preStop` drain (Q4).
8. Set `Retain` on the StorageClass and patch existing PVs (Q9).
9. Tune HPA `minReplicas` (at least 6) and the scale-down behaviour (Q6).

**Limits that still need validation.** These docs don't guarantee them; application or cluster testing must establish them:

- **Endpoint propagation time:** how long until load balancers stop sending new requests (Q4).
- **Draining behaviour:** whether in-flight requests actually finish within the chosen grace period, and how the app reacts to SIGTERM (Q4).
- **Zone-loss behaviour:** scheduling of replacement Pods, and spare node capacity in the remaining zones under `DoNotSchedule` (Q2).
- **CNI enforcement:** that the plugin really enforces policy, how long rollout takes, and the correct DNS selectors and ports (Q7).
- **Database failover:** failover and connection-pool behaviour during rolling and drained restarts (**N** throughout).
- **Voluntary disruptions from the provider:** what the hosting provider's automation does (`disruptions.md:81-89`).
- **Metrics pipeline:** availability of the metrics HPA depends on (Q6).