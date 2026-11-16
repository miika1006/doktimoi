# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs)

**Recommendation:** Do not approve the design as written. Four parts need to change first: the PDB/rollout combination, the termination budget, how Secrets are handled, and the networking default. The storage reclaim choice needs an explicit decision. In the answers below, **[G]** marks a documented guarantee, **[C]** a configuration choice, **[P]** a prerequisite, and **[U]** something these docs do not establish. All paths are relative to `docs/`.

---

### 1. PDB `minAvailable: 5`

- **Node failure:** this is an involuntary disruption. **[G]** A PDB cannot prevent it, although it counts against the budget (`concepts/workloads/pods/disruptions.md:21-65`, `:92-131`). Losing a node that hosts two replicas drops you to four.
- **Node drain:** this is a voluntary disruption. `kubectl drain` uses the Eviction API, which honors the PDB. Rejected evictions are retried until they succeed or a timeout is reached (`disruptions.md:92-131`). **[G]** With six replicas and `minAvailable: 5`, only one Pod can be evicted at a time. **[C]** The docs recommend setting the `AlwaysAllow` unhealthy-pod eviction policy. By default, a drain waits for Pods to become healthy (`disruptions.md:92-145`).
- **Rolling update:** **[G]** Pods taken down by a rolling update count against the budget, but Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:92-145`). With `maxUnavailable: 2`, availability can drop to four, which violates the intent of the PDB. Deleting Pods or Deployments also bypasses PDBs (`disruptions.md:21-65`).
- **Recommendation [C]:** use `maxUnavailable: 0` and `maxSurge: 1` (or 2). `maxUnavailable` is rounded down from a percentage, and both fields cannot be 0 at once (`concepts/workloads/controllers/deployment.md:1189-1199`, `:1201-1310`). This keeps six available Pods during rollout, as long as surge capacity can be scheduled **[U]**.

### 2. Zone spreading

**[C]** Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1`, and add a second constraint on `kubernetes.io/hostname`. All constraints are ANDed. `maxSkew` is the largest permitted difference from the global minimum. For example, with a 2/2/1 spread the next Pod can only go to the third zone (`reference/kubernetes-api/workload-resources/pod-v1.md:209-240`).

- `DoNotSchedule` (the default) leaves a Pod unscheduled rather than violate the skew.
- `ScheduleAnyway` always schedules the Pod and only prefers lower skew. That preference is "jointly normalized" with other scheduling priorities (`concepts/scheduling-eviction/topology-spread-constraints.md:335-354`, `:95-126`).
- Nodes that lack the topology label are bypassed (`topology-spread-constraints.md:474-499`). **[P]** Every node needs the zone label.
- `minDomains` (only valid with `DoNotSchedule`) treats the global minimum as 0 when fewer eligible domains exist (`:95-126`).

**[U]** The docs do not establish how a zone outage behaves end to end. Under `DoNotSchedule`, replacement Pods might stay Pending to preserve the skew. Under `ScheduleAnyway`, they would land in the surviving zones. This must be tested.

### 3. Probes for slow startup

**[G]** While a startup probe is defined, liveness and readiness probes are disabled until it succeeds. If the startup probe fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:474-500`; `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:2-41`).

- Size `failureThreshold × periodSeconds` to cover the worst-case startup. For example, 30×10 gives 300 s (`configure-liveness-readiness-startup-probes.md:311-347`).
- **When traffic stops:** when readiness fails, the Pod's IP is removed from Service endpoints. Readiness starts as `Failure` before the initial delay (`pod-lifecycle.md:474-500`).
- **When the container restarts:** only when liveness (or startup) fails.
- **[C]** Liveness can use the same cheap endpoint as readiness with a higher `failureThreshold`, so the Pod is marked not-ready before it is killed. Liveness should indicate only unrecoverable failure (`configure-liveness-readiness-startup-probes.md:2-41`).
- **[U]** Do not make liveness depend on the database. The docs do not cover this case; it follows from the caution about restarting only on unrecoverable failure.

### 4. Termination order

1. The Pod is marked terminating. **[G]** The grace-period countdown starts *before* `preStop` runs (`pod-v1.md:992-1012`).
2. `preStop` runs. If it outlasts the grace period, there is a one-off 2-second extension (`pod-lifecycle.md:580-610`).
3. TERM is sent to process 1 in each container, in arbitrary order (`pod-lifecycle.md:580-610`).
4. When the grace period expires, SIGKILL is sent (`pod-lifecycle.md:636-660`).

At the same time, the endpoint is kept but marked terminating with `ready=false`, so load balancers stop sending regular traffic. `serving` shows the Pod's actual readiness while it drains (`pod-lifecycle.md:612-634`; `concepts/services-networking/endpoint-slices.md:100-117`). Eviction honors `terminationGracePeriodSeconds` (`disruptions.md:92-145`).

**Is 30 s enough?** Not guaranteed. 30 s is simply the default (`pod-lifecycle.md:580-610`), and `preStop` time comes out of the same budget. **[C]** Set the grace period to at least (preStop delay + longest request + margin), and make the application handle SIGTERM gracefully **[U]**.

### 5. Resources

- **[G]** CPU limits are enforced by throttling and are a hard cap.
- **[G]** Memory limits are enforced reactively by OOM kills, and only under memory pressure. A container can temporarily exceed its limit.
- If you set a limit but no request, the request defaults to the limit (`concepts/configuration/manage-resources-containers.md:27-67`).
- CPU limits are enforced via CFS quota by default (`tasks/administer-cluster/cpu-management-policies.md:41-52`).
- **[G]** HPA calculates utilization as a percentage of the request. If any container lacks the request, utilization is undefined and HPA "will not take any action for that metric" (`tasks/run-application/horizontal-pod-autoscale.md:89-107`).
- **[C]** Set CPU requests on every container, including sidecars. The right request and limit values must come from load testing **[U]**.

### 6. HPA behaviour

- Pods being deleted are ignored and failed Pods are discarded. Pods with missing metrics are set aside. For CPU, Pods that are not yet ready, or whose metric predates readiness, are also set aside (`horizontal-pod-autoscale.md:129-165`).
- "Not yet ready" is decided using the initial-readiness delay (default 30 s) and the CPU-initialization period (default 5 min) (`:167-200`). **[U]** A slow-starting Pod can fall outside these windows.
- Missing metrics are then filled in conservatively: as 100% of target when scaling down and 0% when scaling up. Not-yet-ready Pods count as 0% when scaling up. If the recalculated ratio reverses direction or falls within tolerance (0.1), nothing happens (`:129-165`, `:167-200`).
- Scale-down uses a 300 s stabilization window. Scale-up has none and is capped at max(4 Pods, 100%) per 15 s (`:455-486`).
- For these reasons, the actual replica count can differ from the raw `ceil(current × ratio)`.
- **[C]** Set HPA `minReplicas ≥ 6`, so autoscaling never undercuts the PDB/zone design.

### 7. Least-privilege networking

- **[G]** Pods are non-isolated by default. A policy whose `policyTypes` includes Ingress or Egress isolates the Pods it selects in that direction. Allowed traffic is the union of all applicable policies; policies are additive and the order they are evaluated in does not matter. Reply traffic is allowed implicitly. A connection needs *both* source egress and destination ingress to allow it (`concepts/services-networking/network-policies.md:51-81`).
- **[C]** Apply default-deny for both ingress and egress (`:254-262`), then add allow rules:
  - ingress from the ingress or gateway Pods on the API port;
  - egress from the API to the database port;
  - ingress on the database from the API.
- **[P]** The CNI plugin must implement NetworkPolicy, otherwise the objects "will have no effect" (`:45-49`).
- **DNS:** the docs show `kube-dns` on 53/UDP and 53/TCP (`tasks/administer-cluster/dns-debugging-resolution.md:158-181`). Under egress isolation that traffic must be allowed explicitly. This is an inference; I found no passage that pairs DNS with NetworkPolicy **[U]**.

### 8. Secrets

base64 is not protection. **[G]** By default, Secrets are stored unencrypted in etcd. Anyone with API or etcd access can read them, and anyone who can create a Pod, or indirectly a Deployment, in the namespace can read every Secret in it (`concepts/configuration/secret.md:1-53`).

**[C]** Take these steps:

- Enable encryption at rest.
- Set least-privilege RBAC on Secrets and on Pod/Deployment creation.
- Restrict which containers can access each Secret.
- Consider an external secret store (`secret.md:1-53`).
- Remove plaintext/base64 Secrets from Git, and rotate any that were committed there. Rotation is an operational inference, not stated in the docs.

### 9. Storage reclaim policy

- **[G]** Dynamically provisioned PVs take their reclaim policy from the StorageClass when they are created, and the class defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
- `Delete` removes both the PV and the external storage asset.
- With `Retain`, the PV becomes "Released" and needs manual cleanup (`concepts/storage/persistent-volumes.md:185-199`, `:201-210`).
- **Existing PVs:** the docs say that otherwise "the PV must be edited or patched after it is created" (`persistent-volumes.md:201-210`). Changing the class is therefore not a documented way to update existing PVs; patch each PV. **[U]** I found no explicit statement covering a StorageClass edit after the fact.
- **PVC vs StatefulSet:**
  - Deleting a PVC triggers the reclaim policy.
  - Deleting or scaling down a StatefulSet does *not* delete its volumes (`concepts/workloads/controllers/statefulset.md:47-64`).
  - `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`) defaults to `Retain`. It applies only to deletion or scale-down, not to node-failure replacement, and the page says it needs the `StatefulSetAutoDeletePVC` feature gate (`statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`).
- **[C]** For database data, use `Retain` and patch any existing `Delete` PVs.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** enable encryption at rest, apply RBAC, and remove Secrets from Git (Q8).
2. **Storage:** set the database StorageClass to `Retain`, patch existing PVs, and confirm the PVC retention policy (Q9).
3. **Resources:** set CPU requests on all containers and add memory limits (Q5).
4. **Probes:** add a startup probe sized to the worst-case startup, then readiness and a conservative liveness probe (Q3).
5. **Termination:** add `preStop` and raise the grace period above the longest request (Q4).
6. **Rollout:** use `maxUnavailable: 0`, `maxSurge: 1`, a PDB with `minAvailable: 5` plus `AlwaysAllow`, and HPA `minReplicas: 6` (Q1, Q6).
7. **Spreading:** add zone and host spread constraints and verify that every node carries the zone label (Q2).
8. **Networking:** confirm CNI support, then apply default-deny plus allow rules, including DNS (Q7).
9. **Validate:** run a drain, a rollout, a zone-loss drill and a scale test.

**Limits that still need application or cluster validation [U]:**

- **Request duration vs grace period:** that the application finishes or drains in-flight requests within the grace period after SIGTERM.
- **Zone loss:** scheduling and capacity during a zone loss, and whether surge Pods actually fit.
- **CNI:** NetworkPolicy enforcement, including DNS reachability.
- **HPA tuning:** that the initialization windows match the real startup time.
- **Drain timeouts:** under a one-at-a-time PDB.
- **Database:** connection-pool limits under the maximum replica count.

None of these is guaranteed merely because the corresponding API field exists.