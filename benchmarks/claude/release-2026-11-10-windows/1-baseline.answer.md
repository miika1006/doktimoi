# Decision memo: API Deployment production review (Kubernetes v1.32 docs)

**Verdict: do not approve the design as proposed.** Four parts of it are unsafe or contradict each other:

- `minAvailable: 5` together with rolling-update `maxUnavailable: 2`.
- Default-allow networking.
- Secrets that are only base64-encoded.
- The default `Delete` reclaim policy on dynamically provisioned storage.

The 30-second grace period and CPU-based HPA need explicit validation. All paths below are relative to `docs/`. Labels used: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

---

### 1. PDB `minAvailable: 5`: is five available replicas guaranteed?

**No, not in any of the three cases.**

- **Node failure.** **[G]** PDBs cannot prevent involuntary disruptions, though those disruptions do count against the budget (`concepts/workloads/pods/disruptions.md:21-34, 130-131`). The docs also say directly that "a disruption budget does not truly guarantee" the minimum, because a node can fail while the app is already at its floor (`tasks/run-application/configure-pdb.md:148-155`). If one node holds two replicas, availability drops to 4 straight away.
- **Node drain.** **[G]** Drain uses the Eviction API, which honours the PDB. With 6 replicas and `minAvailable: 5`, it allows one eviction at a time and retries the ones that are refused (`disruptions.md:107-121`; `configure-pdb.md:131-132`). "Healthy" means `Ready=True` (`configure-pdb.md:236-240`). **[C]** Set `unhealthyPodEvictionPolicy: AlwaysAllow` so that pods which never become Ready don't block drains (`configure-pdb.md:242-274`; `disruptions.md:138-141`). **[G]** If HPA ever brings the replica count down to 5, `minAvailable` equals the replica count and no drain can finish (`configure-pdb.md:157-161`). Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:62-65`).
- **Rolling update.** **[G]** Rolling updates count against the budget, but the PDB does not limit them (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can fall to 4 (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommendation [C]:** `maxUnavailable: 0`, `maxSurge: 1` (allowed, because only one of the two may be 0; `deployment.md:1191-1211`). Also set a readiness probe that is meaningful for the app, HPA `minReplicas ≥ 6`, or a PDB written as `maxUnavailable: 1` instead. **[P]** The surge Pod needs spare capacity in the cluster.

### 2. Spreading replicas across zones

**[C]** Add two constraints:
- `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1`, `whenUnsatisfiable: DoNotSchedule`.
- `kubernetes.io/hostname` with `ScheduleAnyway`.

Add `matchLabelKeys: [pod-template-hash]` so that old and new revisions are not counted together during a rollout (`concepts/scheduling-eviction/topology-spread-constraints.md:134-163`).

How the fields work:
- **maxSkew** is the allowed difference between a domain's count of matching Pods and the global minimum. Example: zones with 2/2/1 Pods have a global minimum of 1 (`:82-93`).
- **topologyKey** groups nodes by the value of a node label (`:117-122`).
- **DoNotSchedule** leaves a Pod unscheduled if placing it would break the skew. **ScheduleAnyway** places it anyway and only prefers nodes that reduce skew (`:124-126`).

**Zone loss.**
- **[G]** Spreading is not maintained after Pods are removed, and nothing rebalances them automatically (`:607-611`).
- **[G]** Domains are discovered from existing nodes, so a zone scaled down to zero nodes is invisible to the scheduler (`:614-623`).
- **[N]** The docs do not describe outage behaviour in detail. With `DoNotSchedule`, replacement Pods may stay Pending if the failed zone still counts as an eligible domain (`minDomains`/global minimum, `:95-115`). Test this.

### 3. Probes for slow startup

- **[C] startupProbe:** `failureThreshold × periodSeconds` must cover the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **[G]** Liveness and readiness probes, including their `initialDelaySeconds`, do not start until the startup probe succeeds (`:31-35, 398-402`).
- **[G] Restart:** the container is restarted when the startup or liveness probe reaches `failureThreshold` consecutive failures, and the restart honours the grace period. A startup probe that never succeeds kills the container after the threshold window (`:346-347, 412-418`).
- **[G] Traffic stops** when readiness fails: the container keeps running, but `Ready=false` removes the Pod from Service load balancing (`:23-29, 419-422`). The readiness probe runs for the container's whole lifetime (`:360-362`).
- **[C]** Make liveness cheap, and give it a higher threshold than readiness. Never make it depend on the database: badly designed liveness probes cause cascading restarts under load (`:19-21, 37-48`).

### 4. Termination order; is 30 seconds enough?

**[G]** The sequence when a Pod is deleted:
1. The Pod is marked Terminating.
2. `preStop` runs first. If it is still running when the grace period ends, the kubelet gives a one-off 2-second extension.
3. SIGTERM is then sent to PID 1 in each container, or the image's STOPSIGNAL if it has one.

The grace-period clock covers both `preStop` and the shutdown after SIGTERM (`concepts/workloads/pods/pod-lifecycle.md:572-610`).

**[G]** At the same time, the control plane evaluates removing the Pod from EndpointSlices. Terminating endpoints stay listed with `ready=false` plus a `serving` condition, so load balancers stop sending new regular traffic (`:612-632`). When the grace period expires, remaining processes get SIGKILL (`:636-644`).

**Is 30 seconds guaranteed? No.** **[G]** The docs say that a `preStop` longer than the grace period requires raising `terminationGracePeriodSeconds` (`:599-600`). **[N]** Your request duration, and how long the load balancer takes to notice the change, are not established by these docs. Set the grace period above the longest request plus the drain time, and measure it.

### 5. Resources, throttling and OOM; effect on HPA

- **[G]** Requests drive scheduling (`concepts/configuration/manage-resources-containers.md:18-23`). A CPU request also sets the container's weight when CPU is contended (`:255-257`).
- **[G]** A CPU limit is a hard ceiling enforced by **throttling**, and CPU overuse never kills the container (`:43-46, 252-254, 275-276`).
- **[G]** A memory limit is enforced reactively by **OOM kill**, followed by a restart if the container is restartable (`:48-53, 261-265`). Using more memory than requested while the node is short of memory makes eviction likely (`:271-273`).
- **[G]** HPA utilization is a percentage of the request. If a container has no CPU request, utilization is undefined and **HPA takes no action** on that metric (`tasks/run-application/horizontal-pod-autoscale.md:90-102`).

**[C]** Set a CPU request on every container, including sidecars.

### 6. HPA: missing metrics, not-ready Pods, stabilization

- **[G]** Terminating Pods are ignored and failed Pods are discarded. Pods with missing metrics or not yet ready are set aside (`horizontal-pod-autoscale.md:153-165`).
- **[G]** "Not yet ready" is judged using `--horizontal-pod-autoscaler-initial-readiness-delay` (default 30s) and `--horizontal-pod-autoscaler-cpu-initialization-period` (default 5 minutes) (`:167-178`).
- **[G]** Missing metrics are then filled in conservatively: as 100% of target on scale-down and 0% on scale-up. Not-ready Pods count as 0% on scale-up. If the adjusted ratio reverses direction or falls within the 0.1 tolerance, nothing happens (`:141-147, 183-197`).
- **[G]** The reported status shows the original, unadjusted average (`:199-202`).
- **[G]** Scale-down takes the highest recommendation from the last 5 minutes (300 s) (`:213-218, 480-481`).

So actual scaling differs from the raw ratio. Slow startup reduces scale-up exactly when you need it.

### 7. Least-privilege networking

- **[P]** You need a network plugin that enforces NetworkPolicy. Without one, NetworkPolicy objects have no effect (`concepts/services-networking/network-policies.md:16, 45-49`).
- **[G]** Pods accept all ingress and egress until some policy selects them for that direction. After that, only the union of the allow rules applies. Policies are additive, and their order doesn't matter (`:53-77`).
- **[G]** A connection needs **both** egress allowed on the source and ingress allowed on the destination (`:79-81`).
- **[G]** Traffic to and from the Pod's own node is always allowed (`:35, 70-72`).
- **[C]** Start with default-deny for both directions (`:254-262`). Then allow ingress from the client namespaces, egress to the database, and egress to DNS.
- **[N]** The policy doc doesn't mention DNS. But default-deny egress blocks all TCP/UDP (`:234-242, 275-279`), so DNS needs an explicit egress rule.
- **[G]** Policies take effect eventually: new Pods may start unprotected, or with no connectivity at all (`:362-391`).

### 8. Is base64 enough for Secrets?

**No.**
- **[G]** base64 "is obscured but not secret" (`concepts/configuration/secret.md:306`). By default, Secrets are stored in etcd unencrypted (`:36-37`).
- **[C]** Turn on encryption at rest. The `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:64-66, 234-235`). Existing Secrets are only encrypted when rewritten (`:595-604`).
- **[C] RBAC.** `get`, `list` and `watch` all expose Secret contents (`concepts/security/rbac-good-practices.md:93-98`).
- **[G] Pod creation matters too.** Anyone who can create Pods or Deployments in a namespace can read every Secret there, and can act as any ServiceAccount in it (`secret.md:38-40`; `rbac-good-practices.md:100-108`).
- **[N]** The Git exposure itself is outside the docs. Remove plaintext-equivalent Secrets from Git.

### 9. StorageClass reclaim policy

- **[G]** Dynamically provisioned PVs take the class's `reclaimPolicy` when they are created. It defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`).
- **[G]** To change an existing PV, patch the PV itself (`concepts/storage/persistent-volumes.md:205-210`).
- **[N]** The docs don't say outright that editing the class leaves existing PVs alone, but the creation-time wording above implies that it does.
- **Retain [G]:** when the PVC is deleted, the PV becomes "released" and the data stays. Reclaiming it is manual (`:185-199`).
- **Delete [G]:** deleting the PVC removes both the PV and the storage asset behind it (`:201-205`).
- **[G]** Deleting or scaling down a StatefulSet does *not* delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). `persistentVolumeClaimRetentionPolicy` controls whether those PVCs are deleted (`whenDeleted`, `whenScaled`; default `Retain`) (`:391-416`).

**[C]** Use `Retain` for database data.

### 10. Prioritized rollout and validation checklist

1. Move Secrets out of Git. Enable encryption at rest and rewrite existing Secrets. Tighten RBAC, including who can create workloads. (Q8)
2. Set the strategy to `maxUnavailable: 0` / `maxSurge: 1`. Keep HPA `minReplicas ≥ 6`. Set `unhealthyPodEvictionPolicy: AlwaysAllow`. (Q1)
3. Add startup, readiness and liveness probes, and size the startup window from measured startup time. (Q3)
4. Set CPU and memory requests on all containers and a memory limit. Decide deliberately whether to set a CPU limit. (Q5)
5. Add zone and host spread constraints with `matchLabelKeys`. (Q2)
6. Set `preStop` plus `terminationGracePeriodSeconds` to at least the longest request plus the drain time. (Q4)
7. Confirm the network plugin enforces NetworkPolicy, then apply default-deny plus the DNS, database and ingress allows. Test from Pods. (Q7)
8. Set `Retain` on the database storage class and patch existing PVs. (Q9)
9. Run a drain test, a rollout test and a simulated zone loss.

**Limits that still need validation, because these documents don't guarantee them:**
- **Availability at 5 during node or zone failure:** the PDB can't stop involuntary disruptions (`configure-pdb.md:148-155`). You need capacity headroom and enough spread.
- **Whether 30 seconds, or any grace period, covers in-flight long requests,** and how fast the load balancer reacts (`pod-lifecycle.md:599-632`).
- **Whether the network plugin enforces policy and how quickly,** including DNS and ICMP behaviour (`network-policies.md:47-49, 275-279, 380-391`).
- **Scheduling during a zone outage** under `DoNotSchedule`, and on autoscaled node pools (`topology-spread-constraints.md:607-623`).
- **Whether the database and the app tolerate restarts, retries and connection churn:** this is application behaviour that the docs don't cover.