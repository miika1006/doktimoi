# Decision memo: hardening the production API Deployment on Kubernetes v1.32

**Scope and method.** This memo uses only the local v1.32 documentation. Paths are relative to `docs/`. Each point is labelled as one of four kinds:

- **[G]**: a guarantee the docs state.
- **[C]**: a configuration choice.
- **[P]**: a prerequisite.
- **[N]**: something the docs do not establish.

**Verdict.** Do not approve the design as proposed. Three parts of it contradict the docs:

- The PDB does not protect rolling updates, and `maxUnavailable: 2` breaks the 5-replica target.
- Base64 Secrets in Git are not protection.
- Default-allow networking contradicts least privilege.

The probes, termination handling, HPA and storage settings need more configuration and testing.

---

### 1. Does the PDB guarantee five available replicas?

No, in none of the three cases is this guaranteed outright.

- **Node failure.** **[G]** A PDB cannot prevent involuntary disruptions such as hardware failure or a node disappearing, but those disruptions "do count against the budget" (`concepts/workloads/pods/disruptions.md:21-65`, `:92-131`).
- **Node drain.** **[G]** `kubectl drain` uses the Eviction API. Evictions can be temporarily rejected, and drain retries until a timeout. With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time (`disruptions.md:92-131`). **[N]** If the pods are not managed by a supported controller, or if the API server does not support eviction, drain falls back to a plain DELETE (`reference/kubectl/generated/kubectl_drain/_index.md:22-37`). Deleting Pods or Deployments directly bypasses PDBs (`disruptions.md:21-65`).
- **Rolling update.** **[G]** Deployments "are not limited by PDBs when doing rolling upgrades", although pods taken down by the rollout still count against the budget (`disruptions.md:133-145`). With `maxUnavailable: 2`, the rollout may drop availability to 4 (`concepts/workloads/controllers/deployment.md:1183-1199`).

**Recommendation [C]:**

- Set `maxUnavailable: 0` and `maxSurge: 1`. `maxSurge` cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1201-1310`).
- Set `unhealthyPodEvictionPolicy: AlwaysAllow` on the PDB so a node drain is not blocked by unhealthy pods (`disruptions.md:133-145`).
- Note that the PDB's "intended" count comes from `.spec.replicas` (`disruptions.md:92-131`). That count changes when the HPA scales, so consider a percentage-based PDB.

### 2. Spreading replicas across zones

- **`topologyKey`** **[C]**: use `topology.kubernetes.io/zone`. Each label value is one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:80-140`).
- **`maxSkew`** **[G]**: with `DoNotSchedule`, this is the maximum difference between a domain's count of matching pods and the global minimum. With `ScheduleAnyway`, the scheduler only prefers placements that reduce skew (`:80-140`).
- **`DoNotSchedule` vs `ScheduleAnyway`** **[G]**: `DoNotSchedule` is the default and leaves a violating Pod pending. `ScheduleAnyway` always schedules the Pod, and its preference is "jointly normalized" with other scheduling priorities (`:335-354`).

**Recommendation [C]:** use `maxSkew: 1` with `DoNotSchedule` on zone, plus a softer `ScheduleAnyway` constraint on hostname. `minDomains` (DoNotSchedule only) treats the global minimum as 0 when fewer eligible domains exist (`:80-140`).

**When a zone is unavailable** **[N]**, the docs do not guarantee recovery. Constraints are not re-satisfied when pods are removed, so the Descheduler is suggested for rebalancing. Zones are known only from nodes that exist, so a zone scaled to zero nodes is invisible to the scheduler (`:605-623`). With `DoNotSchedule`, replacement pods may therefore stay pending. That outcome must be tested.

### 3. Probes for slow startup

- **Startup probe** **[G]**: all other probes are disabled until it succeeds. If it fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:474-500`). Size `failureThreshold × periodSeconds` to cover the worst-case startup. For example, 30 × 10 gives 300 s, after which the container is killed if it still hasn't started (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `pod-lifecycle.md:544-557`).
- **Readiness probe** **[G]**: a failure removes the Pod's IP from Service endpoints, so this is when traffic stops. Before the initial delay, readiness defaults to `Failure` (`pod-lifecycle.md:474-500`).
- **Liveness probe** **[G]**: a failure kills and restarts the container (`:474-500`). **[C]** Use the same cheap endpoint as readiness but with a higher `failureThreshold`, so the Pod is not-ready for a while before it is killed. Liveness should indicate only unrecoverable failure (`configure-liveness-readiness-startup-probes.md:2-41`).

### 4. Termination order, and is 30 seconds enough?

**[G]** The order is:

1. Deletion records the grace period, which defaults to 30 s.
2. If a `preStop` hook is defined, it runs inside that grace period. A hook still running at expiry gets a one-off 2-second extension. If the hook needs more time, you must raise `terminationGracePeriodSeconds`.
3. SIGTERM (or the image's STOPSIGNAL) is sent to the containers in arbitrary order.
4. When the grace period expires, SIGKILL is sent and the Pod object is removed (`pod-lifecycle.md:559-610`, `:634-660`).

**[G]** At the same time, the control plane marks the Pod's endpoints as terminating. Their `ready` value is always `false`, so load balancers stop sending regular traffic. The `serving` condition can still be used for draining (`pod-lifecycle.md:612-634`; `concepts/services-networking/endpoint-slices.md:100-117`).

**[N]** Thirty seconds is not guaranteed to finish long requests. Nothing in the docs links the grace period to how long requests last. Measure the longest request time, and set the grace period to cover the preStop time plus the time to drain requests.

### 5. Resources

**[G]** Requests and limits behave as follows (`concepts/configuration/manage-resources-containers.md:27-67`):

- A container can use more than its request.
- A CPU limit is a hard cap enforced by throttling.
- A memory limit is enforced reactively by OOM kills, and only under memory pressure.
- If only a limit is set, the limit is copied into the request.

**[G]** Under node OOM, low-QoS pods that use a lot of memory relative to their requests are killed first. The kubelet can then restart an OOM-killed container (`concepts/scheduling-eviction/node-pressure-eviction.md:432-460`).

**[G]** Utilization-based HPA divides usage by the request. If any container lacks the relevant request, the Pod's utilization is undefined and the HPA "will not take any action for that metric" (`tasks/run-application/horizontal-pod-autoscale.md:89-121`, `:255-281`).

**[C]** Set a CPU request on every container, including sidecars, and set memory requests and limits. A CPU limit may cause throttling. Validate its effect on latency, especially during startup.

### 6. HPA behaviour

**[G]** How the HPA calculates replicas:

- The base formula is `ceil(currentReplicas × current/desired)`, with a default tolerance of 0.1. Pods that are being deleted or have failed are ignored (`horizontal-pod-autoscale.md:130-165`).
- Pods with missing metrics are set aside. They are then assumed to use 100% of the target when scaling down and 0% when scaling up.
- On CPU, pods that are not yet ready, or whose latest metric predates readiness, are set aside and assumed to use 0% on scale-up.
- The flags `--horizontal-pod-autoscaler-initial-readiness-delay` (30 s) and `--horizontal-pod-autoscaler-cpu-initialization-period` (5 min) control what counts as "not yet ready".
- If the recalculated ratio reverses direction or falls within tolerance, the HPA does nothing.
- The status still reports the original average (`:167-202`).

**[G]** The default scale-down stabilization window is 300 s. Scale-up has no window and is limited to the larger of 100% or 4 Pods per 15 s (`:455-497`).

Slow startup and readiness therefore damp scale-up on purpose, so scaling will not follow the raw ratio. **[P]** The HPA needs a metrics API, usually Metrics Server, which is deployed separately (`:89-121`).

### 7. Least-privilege networking

**[P]** NetworkPolicy has no effect unless the network plugin implements it (`concepts/services-networking/network-policies.md:45-49`).

**[G]** How isolation works (`:51-81`):

- Pods are non-isolated by default in both directions.
- Any policy that selects a Pod and lists `Ingress` or `Egress` isolates the Pod in that direction.
- Allowed rules add together, and policies never conflict.
- Reply traffic is allowed implicitly.
- A connection needs both the source Pod's egress and the destination Pod's ingress to allow it.
- An ingress-isolated Pod still accepts connections from its own node.

**[C]** Apply namespace default-deny for ingress and for egress (`:214-222`, `:234-252`). Then add explicit rules:

- Ingress from the client or ingress-controller pods to the API port only.
- Egress from the API to the database's pods or CIDR on the database port only. Rules match both `to` and `ports`, as in the documented example (`:120-140`).
- Matching ingress on the database side.

**[N]** The policy page I searched does not cover DNS. Default-deny egress blocks every outbound connection that is not allowed, so add an explicit egress rule for the cluster DNS service and test name resolution.

Avoid a blanket allow-all-egress policy: once it exists, no other policy can deny egress (`:244-252`).

### 8. Secrets

**[G]** Base64 is not protection. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them. Anyone who can create a Pod in a namespace, or even a Deployment, can read every Secret in that namespace (`concepts/configuration/secret.md:1-53`).

**[C]** Required steps (`secret.md:1-53`):

- Enable encryption at rest.
- Grant least-privilege RBAC on Secrets.
- Limit which containers get each Secret.
- Consider an external secret store.

Encryption at rest also protects etcd backups (`tasks/administer-cluster/securing-a-cluster.md:251-265`). Treat permission to create Pods or Deployments as permission to read Secrets.

**[N]** Removing plaintext Secrets from Git, through sealed or external secrets, is a process decision. These docs do not prescribe a specific tool beyond the ones listed above.

### 9. StorageClass reclaim policy

**[G]** How reclaim policy is set and applied:

- A dynamically provisioned PV takes the `reclaimPolicy` its StorageClass has when the PV is created. The default is `Delete`.
- A manually created PV keeps the policy it was given at creation (`concepts/storage/storage-classes.md:126-135`).
- For an existing PV that should keep a different policy, the PV itself "must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`).
- **[N]** The docs do not explicitly state that editing the class leaves existing PVs unchanged. That is the reading these passages support, so patch the existing PVs directly.

**[G]** Retain vs Delete:

- With **Retain**, deleting the PVC leaves the PV "Released", with its data intact. Reclaiming it is manual.
- With **Delete**, deleting the PVC removes both the PV and the external storage asset (`persistent-volumes.md:185-210`).

**[G]** StatefulSet deletion and scale-down are separate from PVC deletion:

- `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`) defaults to `Retain` and needs the `StatefulSetAutoDeletePVC` feature gate.
- It applies only when the StatefulSet is deleted or scaled down, not when a node fails (`concepts/workloads/controllers/statefulset.md:387-463`).
- Without it, scale-down leaves the PVCs and PVs in place (`tutorials/stateful-application/basic-stateful-set.md:543-568`).

The PV's reclaim policy then decides what happens when those PVCs are deleted. **[C]** For database volumes, use Retain.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** rotate any credentials ever committed to Git, enable encryption at rest, and restrict both Secret RBAC and Pod-create RBAC (§8).
2. **Network:** confirm the CNI enforces NetworkPolicy, then apply default-deny plus explicit API, database and DNS rules, and test each path (§7).
3. **Storage:** patch existing database PVs to Retain, set the StorageClass `reclaimPolicy`, and rehearse deleting and restoring a PVC (§9).
4. **Probes:** add a startup probe sized to the measured p99.9 startup time, plus readiness and liveness probes (§3).
5. **Termination:** add a `preStop` drain and raise the grace period above the measured longest request (§4).
6. **Resources:** set CPU and memory requests on every container, set limits, and verify the HPA shows a utilization value (§5–6).
7. **Rollout and disruption:** set `maxUnavailable: 0` and `maxSurge: 1`, keep the PDB at `minAvailable: 5` (or a percentage) with `AlwaysAllow`, and add zone spread with `maxSkew: 1` (§1–2).
8. **Game days:** drain a node, take one zone down, and load-test with HPA scaling.

**Limits the docs do not guarantee, which you must validate:**

- **Node or zone loss:** availability can drop below 5. The PDB cannot prevent it, and topology spread does not rebalance or create capacity in a missing zone (§1–2).
- **Grace period:** whether any grace period completes long requests and the database connection draining (§4).
- **HPA response time:** whether scale-up is fast enough given slow startup, readiness damping, the 300-second scale-down window and Metrics Server availability (§6).
- **CNI enforcement and DNS behaviour** under default-deny egress (§7).
- **Database consistency** during pod restarts, and whether the backing storage really retains data (§9).