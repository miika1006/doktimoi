# Decision memo: production readiness review of the six-replica API Deployment

**Scope:** Kubernetes v1.32 documentation under `docs\` only. Each citation is `path:lines`. Every finding is labelled as a **Guarantee** (documented behaviour), **Config** (a choice the team makes), **Prereq** (something the cluster must provide) or **Gap** (something these docs do not establish).

**Verdict:** Do not approve the design as proposed. Four items need changing before production: the rollout settings conflict with the PDB, networking allows all traffic by default, Secrets are only base64-encoded, and the 30-second termination window is not tied to how long requests actually take.

---

### 1. Does the PDB guarantee five available replicas?

No, in none of the three cases.

- **Node failure.** A PDB cannot prevent involuntary disruptions, although they do count against the budget (`concepts/workloads/pods/disruptions.md:92-131`). The docs also state that a budget "does not truly guarantee" the minimum, because a node can fail while the app is already at the minimum (`tasks/run-application/configure-pdb.md:148-176`). If one node holds two replicas, availability drops to four. (Guarantee: the PDB gives no protection here.)
- **Node drain.** `kubectl drain` uses the Eviction API and retries rejected evictions, so the PDB is respected (`disruptions.md:92-131`). With six replicas and `minAvailable: 5`, one Pod can be evicted at a time. Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:21-65`). The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy so that a broken Pod does not block a drain (`disruptions.md:132-145`).
- **Rolling update.** Pods taken down by a rollout count against the budget, but Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:132-145`). With `maxUnavailable: 2`, the Deployment can go down to four available Pods (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommendation (Config):**
- Set the rollout to `maxUnavailable: 0, maxSurge: 1`. `maxSurge` cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1201-1310`).
- Express the PDB as `maxUnavailable: 1` rather than `minAvailable: 5`. The docs recommend this form because it adjusts automatically when the replica count changes (`configure-pdb.md:148-176`), which matters here because the HPA changes the replica count.
- Never let the budget reach zero allowed evictions, or drains will never complete (`configure-pdb.md:148-176`).
- Budget extra capacity so evicted Pods can be rescheduled (`tutorials/stateful-application/zookeeper.md:1136-1153`).

### 2. How should replicas be spread across zones?

- **topologyKey:** use the node label that identifies the zone. Changing the key to a node label spreads Pods across nodes instead of zones (`concepts/scheduling-eviction/topology-spread-constraints.md:335-354`).
- **maxSkew:** with `DoNotSchedule`, this is the maximum allowed difference between a domain's matching Pods and the global minimum. With `ScheduleAnyway`, the scheduler only gives preference to placements that reduce skew (`topology-spread-constraints.md:76-93`).
- **DoNotSchedule vs ScheduleAnyway:** `ScheduleAnyway` keeps the Pod schedulable, but that preference is normalized together with other scheduling priorities (`topology-spread-constraints.md:335-354`).
- **Recommendation (Config):** `maxSkew: 1` across zones with `DoNotSchedule` (two Pods per zone), plus a soft per-node constraint (`ScheduleAnyway`).

**What happens when a zone is unavailable (Guarantee/Gap):**
- Constraints are not re-enforced when Pods are removed, so scale-down can leave Pods imbalanced.
- Zones are discovered only from existing nodes, so a zone whose node group has scaled to zero is not considered at all (`topology-spread-constraints.md:605-623`).
- What a hard constraint does while a zone still has nodes but those nodes are unreachable is not established by the retrieved text. Test it.

### 3. Which probes fit slow startup?

- **Startup probe:** size `failureThreshold × periodSeconds` to cover the worst-case startup time. For example, 30 × 10 s gives 300 s; if it never succeeds, the container is killed and handled by its `restartPolicy` (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **When the other probes begin:** liveness and readiness probes are disabled until the startup probe succeeds (`concepts/workloads/pods/pod-lifecycle.md:474-500`; `configure-liveness-readiness-startup-probes.md:2-41`).
- **When traffic stops:** a failing readiness probe removes the Pod's IP from Service endpoints. Readiness defaults to `Failure` before the initial delay (`pod-lifecycle.md:474-500`).
- **When a container restarts:** a failing liveness probe kills the container.
- **Config:** give liveness a higher `failureThreshold` than readiness, so the Pod is taken out of traffic before it is killed. Use liveness only to detect unrecoverable failure such as a deadlock (`configure-liveness-readiness-startup-probes.md:2-41`).
- **Gap:** the database dependency should not be part of liveness. These docs do not tell you how to check it.

### 4. Termination order, and is 30 seconds enough?

The sequence (`pod-lifecycle.md:584-610`, `612-634`, `636-645`):

1. The Pod is marked as terminating.
2. The `preStop` hook runs. The grace-period countdown starts *before* `preStop` begins (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`). If `preStop` is still running when the grace period ends, the kubelet grants a one-off 2-second extension.
3. SIGTERM is sent, to containers in arbitrary order.
4. When the grace period expires, SIGKILL is sent.

At the same time as step 1, the control plane marks the Pod's endpoints as terminating. A terminating endpoint always has `ready=false`, so load balancers stop sending it new traffic; the `serving` condition reports whether it can still handle traffic while draining (`concepts/services-networking/endpoint-slices.md:100-117`).

The default grace period is 30 s. If `preStop` needs longer, you must raise it (`pod-lifecycle.md:584-610`).

**Is 30 seconds guaranteed to finish requests? No.** The 30 s covers both `preStop` and the application's own shutdown. **Config:** set `terminationGracePeriodSeconds` to at least preStop delay + the longest request (p99.9) + a safety margin. **Gap:** how long requests actually last is an application measurement.

### 5. Resources, throttling vs OOM, and the effect on HPA

- **Requests:** a container may use more than its request (`concepts/configuration/manage-resources-containers.md:27-67`).
- **CPU limit:** enforced by throttling; a container cannot exceed it.
- **Memory limit:** enforced reactively by OOM kills, and only when the kernel detects memory pressure.
- **Limit without a request:** the limit is copied as the request (same lines).
- **Effect on HPA:** utilization is measured as a percentage of the request. If any container lacks the request, utilization is undefined and the HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-121`, `255-281`). Because utilization is summed across containers, one hot container can be hidden by the others.
- **Config:** set a CPU request on every container, and set memory request and limit.
- **Gap:** whether to set a CPU limit at all, given throttling of long requests, needs load testing.

### 6. HPA with missing metrics and not-yet-ready Pods

- **Not-yet-ready Pods:** unready Pods, and Pods whose latest metric predates readiness, are set aside. The readiness delay defaults to 30 s and the CPU initialization period to 5 min (`horizontal-pod-autoscale.md:129-165`, `167-202`).
- **Missing metrics:** Pods without metrics are assumed to use 100% of target when scaling down and 0% when scaling up.
- **Further dampening:** not-yet-ready Pods are counted as 0% when scaling up.
- **Recompute rule:** if the recomputed ratio reverses the scaling direction or falls within tolerance, nothing happens.
- **Why scaling differs from the raw ratio:**
  - The 0.1 tolerance skips changes when the ratio is close to 1.0 (`horizontal-pod-autoscale.md:129-165`).
  - Scale-down has a 300 s stabilization window by default; scale-up has none and is capped at max(4 Pods, 100%) per 15 s (`horizontal-pod-autoscale.md:455-486`).
  - The status shows the *original* utilization, not the adjusted value (`horizontal-pod-autoscale.md:167-202`).
- **Prereq:** Metrics Server must be deployed separately (`horizontal-pod-autoscale.md:89-121`).
- **Config:** set HPA `minReplicas ≥ 6` so the zone spread and PDB still hold.

### 7. Least-privilege networking

- **Default:** Pods are not isolated in either direction.
- **Isolation:** a Pod becomes isolated for a direction once any policy selects it with that direction in `policyTypes`. Allowed connections are then the union of all matching policies; policies are additive and never conflict.
- **Both ends:** a connection works only if the source's egress *and* the destination's ingress allow it (`concepts/services-networking/network-policies.md:51-81`).
- **Node exception:** an ingress-isolated Pod still accepts traffic from its own node (same lines).
- **Config:** default-deny ingress and egress for the namespace. Then allow ingress to the API port from the ingress or client namespaces, and egress to the database's IPs/port (`network-policies.md:83-140`).
- **Prereq:** the CNI plugin must enforce NetworkPolicy; without that, a policy "will have no effect" (`network-policies.md:45-49`, `83-140`). Only TCP, UDP and SCTP are guaranteed to be filtered (`network-policies.md:264-307`).
- **Gap:** an exact search found no DNS guidance in `network-policies.md`. From the egress-isolation rule, an explicit egress allowance to the cluster DNS is needed (my inference). Validate it.

### 8. Is base64 enough to protect Secrets?

No. Secrets are stored unencrypted in etcd by default. Anyone with API access or etcd access can read them. Anyone who can create a Pod, or even a Deployment, in a namespace can read every Secret in that namespace (`concepts/configuration/secret.md:1-53`).

**Required:**
- Enable encryption at rest.
- Restrict Secret access with least-privilege RBAC.
- Limit Secret access to the containers that need it.
- Consider an external Secret store (`secret.md:1-53`).
- Encrypt etcd backups (`tasks/administer-cluster/securing-a-cluster.md:251-265`).

**Config:** remove plaintext/base64 Secrets from Git. Treat Pod-create and workload-create permissions as equivalent to Secret-read access in this namespace.

### 9. StorageClass reclaim policy and existing PVs

- **Where the policy comes from:** dynamically provisioned PVs take the class's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`; `reference/kubernetes-api/config-and-storage-resources/storage-class-v1.md:83-99`).
- **Existing PVs:** if the class does not match expectations, "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). Changing the class therefore does not fix existing PVs. That conclusion is my inference from creation-time inheritance; the docs do not state it explicitly.
- **Delete:** removes both the PV and the backing storage asset (`persistent-volumes.md:201-210`).
- **Retain:** leaves the PV in a "released" state. An administrator must clean up and delete it manually, and it cannot be bound to a new claim (`persistent-volumes.md:185-199`).
- **PVC deletion vs StatefulSet deletion/scaling:**
  - Deleting or scaling down a StatefulSet does not delete its volumes. Deleting the PVCs may delete the volumes, depending on the reclaim policy (`tutorials/stateful-application/cassandra.md:239-263`).
  - `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`) applies only when a StatefulSet is deleted or scaled down, not when a node fails. It requires the `StatefulSetAutoDeletePVC` feature gate (`concepts/workloads/controllers/statefulset.md:387-436`; `stateful-set-v1.md:130-157`).
- **Config:** use `Retain` for database data and patch existing PVs explicitly.

### 10. Prioritized rollout and validation checklist

1. **Secrets.** Encryption at rest, least-privilege RBAC, Secrets out of Git, and an audit of who can create Pods or workloads (Q8).
2. **NetworkPolicy.** Confirm the CNI enforces it, then apply default-deny plus allowances for ingress, the database and DNS. Test both ends of each connection (Q7).
3. **Database storage.** Reclaim policy `Retain`, existing PVs patched, retention policy decided (Q9).
4. **Rollout and PDB.** Rollout `maxUnavailable: 0, maxSurge: 1`; PDB `maxUnavailable: 1` with `AlwaysAllow`; spare capacity reserved (Q1).
5. **Zone spread.** Zone constraint plus soft node constraint; HPA `minReplicas ≥ 6` (Q2, Q6).
6. **Probes.** Startup, readiness and liveness probes sized from the measured worst-case startup (Q3).
7. **Termination.** preStop delay and grace period sized from the measured request length (Q4).
8. **Resources and HPA.** Requests on every container, Metrics Server confirmed, behaviour under load observed (Q5, Q6).
9. **Game days.** Drain a node, kill a node, simulate losing a zone, and run a rollout under load.

**Limits that still need application or cluster validation (Gap):**
- Real request duration, and whether the app handles SIGTERM correctly (Q4).
- Scheduling behaviour when a zone has nodes but they are unreachable, and how the node autoscaler handles empty zones (Q2).
- Whether the CNI enforces NetworkPolicy, including the DNS and database egress rules (Q7).
- Whether the storage driver supports `Delete`/`Retain`, and how the database recovers after a failover (Q9).
- Whether CPU-utilization scaling is the right signal for long, possibly I/O-bound requests (Q5, Q6).