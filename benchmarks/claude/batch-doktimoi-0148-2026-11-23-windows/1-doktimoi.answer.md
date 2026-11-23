I have evidence for all ten questions, so I'm writing the memo now.

# Decision memo: six-replica API on Kubernetes v1.32

**Verdict: don't approve the design as proposed.** Five changes are needed first: the rollout settings, the probes, the termination budget, the network policy and the handling of Secrets. In the sections below, **[G]** marks a documented guarantee, **[C]** a configuration choice, **[P]** a prerequisite and **[N]** something these docs do not establish. All paths are under `docs/`.

## 1. Does the PDB keep five replicas available?

No. A PDB covers only some causes of downtime.

- **Node failure:** [G] PDBs can't prevent involuntary disruptions, though those disruptions still count against the budget (`concepts/workloads/pods/disruptions.md:92-131`). The docs state outright that a budget "does not truly guarantee" the minimum; a node can fail while the app is already at that minimum (`tasks/run-application/configure-pdb.md:148-176`).
- **Node drain:** [G] `kubectl drain` goes through the Eviction API, which respects the PDB and retries rejected evictions (`disruptions.md:92-131`). With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time. [C] The docs recommend the `AlwaysAllow` unhealthy-pod eviction policy. Without it, a drain waits for Pods to become healthy (`disruptions.md:133-145`).
- **Rolling update:** [G] Deployments are **not limited by PDBs** during rolling updates (`disruptions.md:133-145`). With `maxUnavailable: 2`, availability during an update is set only by the Deployment, so it can drop to 4 (`concepts/workloads/controllers/deployment.md:1189-1199`).
- **Recommendation:** [C] Use `maxUnavailable: 0` and `maxSurge: 1`. Both can't be 0 at the same time (`deployment.md:1201-1310`). Express the PDB as `maxUnavailable: 1`, which the docs recommend because it adjusts when the replica count changes (`configure-pdb.md:148-176`). Also make sure the PDB never demands all replicas, or a drain will never finish (`configure-pdb.md:148-176`).

## 2. How should replicas be spread across zones?

[C] Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1` (`concepts/scheduling-eviction/topology-spread-constraints.md:76-126`).

- **`DoNotSchedule`** (the default) caps the difference between the fullest zone and the global minimum. A Pod that would break that cap isn't scheduled.
- **`ScheduleAnyway`** only ranks nodes that reduce skew higher; the Pod is still placed (`:76-126`).
- **`minDomains`** works only with `DoNotSchedule`. When fewer eligible zones exist than `minDomains`, the global minimum is treated as 0 (`:76-126`).
- **Without explicit constraints**, the built-in default for zones is `maxSkew: 5` with `ScheduleAnyway`, which is too loose for this design (`:532-578`).
- **Zone outages:** [N] The docs don't describe a zone outage directly. They do say constraints aren't guaranteed to hold after Pods are removed, and zones are discovered only from existing nodes. A zone with no nodes isn't considered at all (`:605-623`). So with `DoNotSchedule`, replacement Pods can stay Pending. With `ScheduleAnyway`, they pile into the zones that remain. Pick one deliberately and test it.

## 3. Which probes fit slow startup?

- **Startup probe:** [C] Set `failureThreshold × periodSeconds` to cover the worst-case startup time. In the docs' example, 30 × 10 gives 300 seconds (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **Order:** [G] All other probes are disabled until the startup probe succeeds. If it fails, the container is killed and restarted according to its restart policy (`concepts/workloads/pods/pod-lifecycle.md:474-500`). After it succeeds once, liveness takes over (`configure-liveness-readiness-startup-probes.md:311-347`).
- **When traffic stops:** [G] A failing readiness probe removes the Pod's IP from the Service endpoints, and readiness defaults to `Failure` before the initial delay (`pod-lifecycle.md:474-500`). Readiness runs for the container's whole life, and readiness and liveness don't depend on each other (`configure-liveness-readiness-startup-probes.md:349-388`).
- **When a container restarts:** [G] A failing liveness probe restarts the container (`pod-lifecycle.md:474-500`).
- **Recommendation:** Keep the liveness probe light. Don't make it depend on the database. [N] The docs don't say this about database dependencies specifically; it's a design judgement.

## 4. Termination order. Does 30 seconds finish requests?

[G] The Pod is marked Terminating with its grace period. The kubelet then runs `preStop`. If `preStop` is still running when the grace period ends, the kubelet adds a one-time 2-second extension. After `preStop`, it sends TERM to PID 1. The default grace period is 30 seconds, and if `preStop` needs longer you must raise it (`pod-lifecycle.md:584-634`). When the grace period expires, SIGKILL is sent (`:636-645`).

[G] **Endpoints during shutdown:** in parallel with this, terminating endpoints stay in the EndpointSlice with `ready=false`, so load balancers stop sending regular traffic. A `serving` condition shows whether the Pod is still actually serving (`:584-634`).

[N] **Nothing guarantees that 30 seconds is enough.** The `preStop` hook, the drain and the longest request all share one clock. Set `terminationGracePeriodSeconds` to at least the measured p99 request time plus the `preStop` time plus a margin. Evictions during a drain use the same grace period (`disruptions.md:133-145`).

## 5. CPU, memory and the HPA

- **Requests:** [G] A container may use more than it requests (`concepts/configuration/manage-resources-containers.md:27-67`).
- **CPU limit:** [G] Enforced by throttling. It is a hard limit, so the container slows down rather than dying (`:27-67`).
- **Memory limit:** [G] Enforced reactively by OOM kills, and only when the kernel detects memory pressure (`:27-67`).
- **Limit without a request:** [G] The limit is copied in as the request (`:27-67`).
- **HPA dependency:** [G] Utilization is measured as a percentage of the request. If any container lacks a CPU request, utilization is undefined and the **HPA takes no action** for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-121`).
- **Prerequisite:** [P] The HPA needs `metrics.k8s.io`, usually Metrics Server, which must be installed separately (`:89-121`).
- **Recommendation:** [C] Set CPU and memory requests on every container, including sidecars. Set a memory limit. A CPU limit would add throttling to the long requests, so add one only after load testing.

## 6. HPA behaviour

- **Missing metrics:** [G] Pods without metrics are assumed to use 100% of the target when scaling down and 0% when scaling up.
- **Not-yet-ready Pods:** [G] They're assumed to use 0% during a scale-up. Readiness timing is governed by `initial-readiness-delay` (30 s) and `cpu-initialization-period` (5 min).
- **Result:** [G] The controller recomputes the ratio. If the direction reverses or the result is within tolerance, it does nothing. The status still reports the original average (`horizontal-pod-autoscale.md:167-202`).
- **Defaults:** [G] Scale-down has a 300-second stabilization window. Scale-up has no window and may add up to 4 Pods or 100% every 15 seconds (`:455-486`).
- **Why scaling differs from the raw ratio:** the conservative assumptions above, the tolerance, the stabilization window and the rate policies.
- **Watch for:** slow startup keeps new Pods not-ready, which dampens scale-up. Set `minReplicas` ≥ 6 so the HPA doesn't undercut the zone spread.

## 7. Least-privilege networking

- **Isolation:** [G] A Pod is unrestricted by default. Ingress and egress isolation are separate: a Pod becomes isolated in one direction once any policy selecting it lists that direction in `policyTypes`. Policies are additive (their union applies) and never conflict. Reply traffic is allowed implicitly. A connection needs the source Pod's egress **and** the destination Pod's ingress to allow it (`concepts/services-networking/network-policies.md:51-81`). Traffic to and from the Pod's own node is always allowed (`:1-44`).
- **Plan:** [C] Default-deny ingress and egress in the namespace (`:254-262`, `:234-242`). Then allow: ingress controller → API on its port, API → database on its port, and the database's ingress from the API.
- **DNS:** [N] The network-policy page has no DNS guidance. An exact search found none. Under default-deny egress, name resolution will fail unless you add an explicit allow, so test it.
- **CNI support:** [P] A network plugin that enforces NetworkPolicy is required; otherwise policies **have no effect** (`:45-49`).
- **Existing connections:** [N] Whether a policy change affects connections already open is implementation-defined (`:464-472`).

## 8. Is base64 enough for Secrets?

No. Base64 is just an encoding; the docs show converting values with the `base64` tool (`tasks/inject-data-application/distribute-credentials-secure.md:17-34`).

- [G] Secrets are stored **unencrypted in etcd by default**. Anyone with API or etcd access can read them (`concepts/configuration/secret.md:1-53`).
- [C] **Encryption at rest:** enabling it means even someone with etcd backups can't read them (`tasks/administer-cluster/securing-a-cluster.md:251-265`, `tasks/administer-cluster/encrypt-data.md:1-32`).
- [C] **Also:** least-privilege RBAC, limiting Secrets to the containers that need them, and an external secret store (`secret.md:1-53`).
- [G] **Why Pod creation matters:** permission to create Pods or Deployments in a namespace lets you read every Secret there and act as any ServiceAccount in it (`secret.md:1-53`, `concepts/security/rbac-good-practices.md:100-120`).
- **Recommendation:** remove the Secrets from Git and rotate them.

## 9. Reclaim policy and storage

- [G] Dynamically provisioned PVs inherit the StorageClass's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
- [G] Otherwise, "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-215`). So the docs treat the policy as fixed on each PV.
- [N] No page states outright that changing a class leaves existing PVs alone. The linked task page isn't in this corpus, so patch each existing PV and check it.
- **Retain:** [G] When the PVC is deleted, the PV becomes Released and the data stays. Cleanup is manual (`persistent-volumes.md:185-199`).
- **Delete:** [G] Both the PV and the external storage asset are removed (`:201-215`).
- **StatefulSet:** [G] `persistentVolumeClaimRetentionPolicy` defaults to `Retain` for both deletion and scale-down. It applies only to those two events, not to replacement after a node failure, and needs the `StatefulSetAutoDeletePVC` feature gate (`concepts/workloads/controllers/statefulset.md:387-436`, `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`).
- **So:** deleting a PVC triggers the PV's reclaim policy, while deleting or scaling down a StatefulSet doesn't delete PVCs unless configured to. Use `Retain` for database volumes.

## 10. Prioritized checklist

1. **Secrets:** remove them from Git, rotate them, enable encryption at rest and tighten RBAC, including Pod-creation rights (§8).
2. **Network:** confirm the CNI enforces NetworkPolicy, apply default-deny plus explicit allows including DNS, and test the paths in both directions (§7).
3. **Storage:** set database PVs and the StorageClass to `Retain`, and verify with `kubectl get pv` (§9).
4. **Resources:** set requests everywhere, confirm Metrics Server is running and that the HPA reports utilization (§5–6).
5. **Probes:** add the startup, readiness and liveness probes, sized from measured startup times (§3).
6. **Termination:** add a `preStop` hook and size the grace period from measured request times (§4).
7. **Rollout and PDB:** `maxSurge: 1` / `maxUnavailable: 0`, PDB `maxUnavailable: 1` with `AlwaysAllow` (§1).
8. **Spread:** zone spread with `maxSkew: 1`. Choose `DoNotSchedule` or `ScheduleAnyway` and rehearse the zone-loss case (§2).
9. **Drills:** a node drain, a rolling update under load and a node kill.

**Limits that still need application or cluster validation:**

- Whether 30 seconds (or any grace period) covers the longest request (§4).
- Behaviour during a zone outage, and whether the node autoscaler is aware of topology (§2).
- Whether the CNI enforces policies, and how DNS egress behaves under default-deny (§7).
- Whether five replicas survive involuntary failures. The PDB doesn't protect against them (§1).
- The reclaim policy on existing PVs (§9).
- Whether the database tolerates restarts and failover. [N] The docs don't establish this.