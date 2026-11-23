# Decision memo: production readiness of the six-replica API Deployment

**Scope and evidence.** I reviewed this design using only the Kubernetes v1.32 documentation under `docs/`. All paths below are relative to that folder. Each point is labelled as one of four kinds:
- **[G]** a documented guarantee
- **[C]** a configuration choice
- **[P]** a prerequisite
- **[N]** something these documents do not establish

**Verdict:** do not approve the design as written. Three parts conflict with what the team wants: `maxUnavailable: 2` against `minAvailable: 5`, default-allow networking, and plain base64 Secrets in Git. Other parts rest on prerequisites nobody has confirmed yet.

---

### 1. Does the PDB keep five replicas available?

No, not in all three cases.

- **Node failure.** [G] A PDB cannot prevent involuntary disruptions, though they still count against the budget (`concepts/workloads/pods/disruptions.md:92-131`; examples of involuntary disruptions at `:21-65`). The docs say directly that a budget "does not truly guarantee" the minimum. A node can fail while the app is already at its minimum and push it below that number (`tasks/run-application/configure-pdb.md:148-176`).
- **Node drain.** [G] `kubectl drain` goes through the Eviction API, which respects the PDB. Rejected evictions are retried until they succeed or a timeout is reached (`disruptions.md:92-131`). With six replicas and `minAvailable: 5`, only one Pod can be evicted at a time. [C] Set `unhealthyPodEvictionPolicy: AlwaysAllow` so that a misbehaving Pod does not block the drain (`disruptions.md:133-145`). Deleting Pods or Deployments directly skips the PDB entirely (`disruptions.md:21-65`).
- **Rolling update.** [G] A Deployment is not limited by a PDB during a rolling update. Pods taken down by the update still count against the budget (`disruptions.md:133-145`). `maxUnavailable: 2` therefore lets availability drop to 4, rounding down when it is a percentage (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommendation [C]:** use `maxUnavailable: 0` with `maxSurge: 1` (or 2). The two cannot both be 0 (`deployment.md:1201-1310`). Old Pods are then removed only after new Pods become available. This needs spare cluster capacity for the extra Pods.

Because the HPA changes the replica count, prefer a PDB written as `maxUnavailable: 1`. That form adjusts automatically when the replica count changes (`configure-pdb.md:148-176`).

### 2. Spreading replicas across zones

[C] Add one constraint per Pod:
- `topologyKey: topology.kubernetes.io/zone`
- `maxSkew: 1`
- `whenUnsatisfiable: DoNotSchedule`

How the fields work:
- `topologyKey` names a node label. Nodes with the same value form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:76-126`).
- With `DoNotSchedule`, which is the default, `maxSkew` is the largest allowed difference between any domain and the global minimum. A Pod that would break this is not scheduled.
- With `ScheduleAnyway`, the scheduler still places the Pod and only prefers nodes that reduce the skew (`:76-126`).

Optionally add a hostname constraint with `ScheduleAnyway`. If you set nothing, the built-in defaults apply: `ScheduleAnyway` with `maxSkew: 5` per zone, which is weak for six Pods (`:532-578`).

**Limits:**
- [G] The constraint is not re-checked when Pods are removed, so scale-down can leave the spread uneven (`:605-623`).
- [G] The scheduler only knows about zones that currently have nodes. A zone with zero nodes is ignored until a node appears there (`:605-623`).
- [N] The docs do not describe what happens to six Pods across three zones during a full zone outage. Expect `DoNotSchedule` to leave replacement Pods Pending when placing them would break the skew. Test this behaviour.

### 3. Probes for slow startup

- **Startup probe [C]:** set `failureThreshold × periodSeconds` to cover the worst-case startup time (e.g. 30 × 10 s = 300 s). [G] Liveness and readiness probes are disabled until the startup probe succeeds. If it never succeeds, the container is killed and handled by the restart policy (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `concepts/workloads/pods/pod-lifecycle.md:474-500`).
- **Readiness probe:** [G] when it fails, the Pod's IP is removed from every matching Service. That is when traffic stops; the container is **not** restarted. Readiness is `Failure` before the initial delay (`pod-lifecycle.md:474-500`).
- **Liveness probe:** [G] when it fails, the container is killed and restarted (`pod-lifecycle.md:474-500`). [C] A common pattern is to use the same cheap endpoint as readiness with a higher `failureThreshold`, and to point liveness only at unrecoverable states such as deadlock (`configure-liveness-readiness-startup-probes.md:2-41`).
- [N] Whether the probes should check the database dependency is not covered. Validate it so that a database outage does not cause restart storms.

### 4. Termination order

1. [G] The Pod is marked terminating, and the grace-period clock starts **before** `preStop` runs. The default grace period is 30 s. If `preStop` is still running when it expires, the Pod gets a single 2 s extension (`pod-lifecycle.md:584-610`; `reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`).
2. After `preStop`, SIGTERM (or the image's `STOPSIGNAL`) is sent to each container, in arbitrary order (`pod-lifecycle.md:559-582`, `:584-610`).
3. At the same time, the control plane marks the endpoint as terminating. `ready` is always false, so regular traffic stops, while `serving` still reports the Pod's actual readiness (`pod-lifecycle.md:610-636`; `concepts/services-networking/endpoint-slices.md:100-117`).
4. When the grace period ends, SIGKILL is sent and the Pod object is removed (`pod-lifecycle.md:636-645`).

**Is 30 s enough? No guarantee.** Time spent in `preStop` comes out of the same 30 s. [C] Set `terminationGracePeriodSeconds` above `preStop` + the longest request + the time to drain. [N] How quickly load balancers and clients stop sending traffic is not established.

### 5. Resources

- [G] Requests can be exceeded when the node has spare capacity.
- CPU limits are enforced by **throttling**: the kernel restricts CPU and the container slows down.
- Memory limits are enforced **reactively by OOM kill**, only under memory pressure, so a container may run over its limit for a while and then be killed (`concepts/configuration/manage-resources-containers.md:27-67`).
- If only a limit is set, the limit is copied into the request (`:27-67`).
- [G] HPA utilization is a percentage of the request. If any container lacks a CPU request, utilization is undefined and the HPA takes **no action** on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-104`).

[C] Set CPU requests on every container. Use a memory limit sized from load testing.

### 6. HPA behaviour

- [G] Pods with missing metrics are assumed to use 100% of the target on scale-down and 0% on scale-up. Not-yet-ready Pods are assumed to use 0% when scaling up (`horizontal-pod-autoscale.md:167-202`).
- [G] If this recalculation reverses the scaling direction or lands within tolerance, the HPA does nothing.
- [G] HPA status still shows the original, unadjusted utilization (`:167-202`).
- [G] For slow starters, the 30 s initial-readiness delay and the 5 min CPU-initialization period matter (`:167-202`).
- [G] The default scale-down stabilization window is 300 s. Scale-up has no window and is limited to the larger of 100% or 4 Pods per 15 s (`:455-486`).

Together, these dampening and stabilization rules explain why actual scaling differs from the raw ratio.

### 7. Least-privilege networking

- [G] A Pod becomes isolated for ingress or egress only when some NetworkPolicy selects it and lists that direction in `policyTypes`. Once isolated, only the union of the policies' allow lists is permitted, and policies never conflict. Replies are allowed implicitly. For ingress, traffic from the Pod's own node is always allowed (`concepts/services-networking/network-policies.md:51-81`).
- [G] A connection must be allowed **both** by the source Pod's egress rules and by the destination Pod's ingress rules (`:51-81`).
- [P] NetworkPolicy does nothing without a network plugin that implements it (`:45-49`).

[C] Recommended policy set:
- default-deny for ingress and egress;
- allow ingress only from the callers;
- allow egress to the database;
- a matching ingress allow on the database side.

[N] My search found no DNS guidance in the policy page. Allowing egress to the cluster DNS must be added and tested, not assumed.

### 8. Secrets

Base64 alone is **not** sufficient.

- [G] Base64 values are "obscured but not secret" (`concepts/configuration/secret.md:306`). `data` values must be base64-encoded (`:452-460`).
- [G] By default, Secrets are stored **unencrypted** in etcd. Anyone with API or etcd access can read them.
- [G] Anyone allowed to create a Pod in the namespace, even indirectly through a Deployment, can read every Secret in that namespace (`secret.md:1-53`).

[C]/[P] Required steps:
- enable encryption at rest (`tasks/administer-cluster/securing-a-cluster.md:251-265`), preferring KMS over a raw key in the configuration file (`tasks/administer-cluster/encrypt-data.md:347-404`);
- use least-privilege RBAC both for reading Secrets and for creating Pods or workloads;
- restrict which containers can access each Secret;
- take plaintext Secret values out of Git.

### 9. Storage reclaim

- [G] A dynamically provisioned PV takes its reclaim policy from the StorageClass when the PV is created. The default is `Delete` (`concepts/storage/storage-classes.md:126-135`).
- [G] Otherwise, the PV itself "must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). Changing the StorageClass therefore does not reliably update existing PVs; patch each one. [N] Retroactive behaviour is not stated explicitly.
- [G] **Retain:** deleting the PVC leaves the PV in a Released state, and an administrator must clean it up and delete the asset manually (`:185-199`).
- [G] **Delete:** deleting the PVC removes both the PV and the external storage asset (`:201-210`).
- [G] StatefulSet PVC retention is a separate setting. `whenDeleted` and `whenScaled` default to `Retain` and need the `StatefulSetAutoDeletePVC` feature gate. These rules apply only when the StatefulSet is deleted or scaled down, not when a node fails (`concepts/workloads/controllers/statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`).

[C] Use `Retain` for database volumes.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** enable encryption at rest with KMS, tighten RBAC for Secrets and Pod creation, and remove Secrets from Git.
2. **Network:** confirm the network plugin enforces NetworkPolicy. Apply default-deny plus explicit allows, including DNS and both ends of the database connection.
3. **Storage:** set the database StorageClass to `Retain` and patch existing PVs.
4. **Rollout and PDB:** set `maxSurge: 1` and `maxUnavailable: 0`. Use a PDB with `maxUnavailable: 1` and `AlwaysAllow` for unhealthy Pods.
5. **Zone spread:** set zone spread to `maxSkew: 1` with `DoNotSchedule`.
6. **Probes:** add a startup probe that covers the slowest startup, plus separate readiness and liveness probes.
7. **Resources and HPA:** set CPU requests and a memory limit, then tune the HPA.
8. **Termination:** set `preStop` and a grace period based on the longest request duration.
9. **Drills:** drain a node, run a rollout, and simulate a zone loss, measuring how many replicas stay available.

**Limits that still need validation** (not guaranteed by these documents):
- Worst-case startup time and request duration (Q3, Q4).
- How long load balancers and clients take to stop sending traffic to a terminating Pod (Q4).
- Scheduling and capacity during a zone outage, and spare capacity for surge Pods (Q1, Q2).
- DNS egress rules and whether the cluster's network plugin enforces policies (Q7).
- Behaviour when the HPA scales between metric gaps and when node-pressure evictions push availability below 5 (Q1, Q6).