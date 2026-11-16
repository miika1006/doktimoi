# Decision memo: production readiness of the six-replica API

**Recommendation: don't approve the design as proposed.** Three parts conflict with each other or with the documented behaviour: the PDB combined with `maxUnavailable: 2`, Secrets committed to Git as base64, and default-allow networking. The probes, termination handling and storage policy also need explicit settings before rollout.

Citations are `docs/<path>:<lines>`. Labels used below: **[G]** documented guarantee or behaviour, **[C]** a configuration choice, **[P]** a prerequisite, **[N]** something the docs don't establish.

---

### 1. Does the PDB guarantee five available replicas?

No, not in any of the three cases.

- **Node failure.** **[G]** A PDB cannot prevent involuntary disruptions, though they count against the budget (`docs/concepts/workloads/pods/disruptions.md:130-131`). Losing a node is listed as involuntary (`:30-34`).
- **Node drain.** **[G]** `kubectl drain` goes through the Eviction API, which respects the PDB and retries rejected evictions (`:107-121`). With six replicas and `minAvailable: 5`, only one Pod can be evicted at a time. If one Pod is already unavailable, every drain blocks until a replacement becomes available (worked example at `:195-223`). **[G]** Deleting Pods or Deployments directly bypasses the PDB (`:62-65`). **[C]** The docs recommend `unhealthyPodEvictionPolicy: AlwaysAllow` so that misbehaving Pods don't stall a drain (`:138-141`).
- **Rolling update.** **[G]** Pods taken down by a rolling update count against the budget, but Deployments are not limited by PDBs during rolling updates (`:133-136`). With `maxUnavailable: 2`, availability can fall to 4 of 6 (`docs/concepts/workloads/controllers/deployment.md:1191-1199`).

**[C] Recommendation:** set `maxUnavailable: 0` and `maxSurge: 1`. The two fields cannot both be 0 (`deployment.md:1194, 1203-1211`). Also either lower the PDB to `minAvailable: 4` or plan for the fact that one unhealthy Pod freezes all node maintenance.

### 2. Zone spreading

**[C]** Use `topologySpreadConstraints` with `maxSkew: 1`, `topologyKey: topology.kubernetes.io/zone`, `whenUnsatisfiable: DoNotSchedule` and `minDomains: 3`. Add `matchLabelKeys: [pod-template-hash]` so that spreading is counted per revision during rollouts (`docs/concepts/scheduling-eviction/topology-spread-constraints.md:82-148`; well-known zone key at `:206-209`).

- **[G]** With `DoNotSchedule`, `maxSkew` is the maximum allowed difference from the global minimum (`:86-91`). `DoNotSchedule` is the default and leaves a non-conforming Pod unscheduled. `ScheduleAnyway` still schedules the Pod and only prefers nodes that reduce skew (`:92-93, 124-126`).
- **[G]** `topologyKey` names a node label. Nodes with the same value form one domain (`:117-122`).
- **[G] Zone loss.** When there are fewer eligible domains than `minDomains`, the global minimum is treated as 0 (`:109-112`). With `DoNotSchedule`, replacement Pods may therefore stay Pending rather than piling into the surviving zones. `ScheduleAnyway` trades balance for capacity.
- **[G]** Constraints are not re-enforced when Pods are removed, so scale-down can leave the spread unbalanced (`:608-609`).
- **[N]** The docs don't establish whether the two surviving zones have enough capacity to run all six replicas.

### 3. Probes for slow startup

- **[G]** While a startup probe is defined and has not yet succeeded, all other probes are disabled. If it fails, the kubelet kills the container (`docs/concepts/workloads/pods/pod-lifecycle.md:492-497`; `docs/reference/kubernetes-api/workload-resources/pod-v1.md:1028`).
- **[C]** Point the startup probe at the liveness endpoint and set its `failureThreshold` × `periodSeconds` above the worst-case startup time. Leave the liveness probe at its defaults (`pod-lifecycle.md:544-557`).
- **[G] When traffic stops:** when the readiness probe fails, the Pod is removed from Service endpoints (`:485-490`). A Pod with a readiness probe starts without traffic (`:514-518`).
- **[G] When a container restarts:** when liveness fails, the container is killed and its restart policy applies (`:479-483`).
- **[C]** Make readiness check the database dependency and keep liveness local to the process (`:524-528`). Otherwise a database outage would restart every replica.

### 4. Termination

**[G] Order of events** (`pod-lifecycle.md:581-645`):

1. The Pod is marked Terminating and the grace-period clock starts.
2. The `preStop` hook runs inside that same budget. If it overruns, the kubelet grants a one-off 2-second extension (`:591-601`).
3. SIGTERM is sent, in arbitrary order across containers (`:603-610`).
4. At the same time, the endpoint becomes `ready: false` with a `serving` condition, so load balancers stop sending new regular traffic (`:612-632`).
5. When the grace period expires, SIGKILL is sent and the Pod object is deleted (`:636-645`).

**[G]** Evictions honour `terminationGracePeriodSeconds` (`disruptions.md:143-145`).

**Is 30 seconds enough? No guarantee.** 30 s is only the default (`:594`). Time spent in `preStop` comes out of the same window, and the docs explicitly say to raise `terminationGracePeriodSeconds` if needed (`:598-601`).

**[N]** The docs don't say how long your requests take or how quickly load balancers react to the endpoint change. Measure the p99 request duration and set the grace period above preStop time plus that drain time.

### 5. Resources

- **[G]** A CPU limit is enforced by throttling. A memory limit is enforced reactively by the kernel OOM killer, and only under memory pressure (`docs/concepts/configuration/manage-resources-containers.md:43-53`).
- **[G]** If a limit is set without a request, the request defaults to the limit (`:63-66`).
- **[G]** If any container lacks a CPU request, Pod CPU utilization is undefined and the HPA takes no action for that metric (`docs/tasks/run-application/horizontal-pod-autoscale.md:99-101`). Utilization is measured against requests and summed across containers (`:257-280`).
- **[C]** Set CPU requests on every container, and a memory limit.

### 6. HPA behaviour

**[G]** (`horizontal-pod-autoscale.md:153-218`):

- Pods with a deletion timestamp are ignored. Pods missing metrics are set aside (`:156-161`).
- For CPU, not-yet-ready Pods are also set aside. "Not yet ready" is decided by two windows: a 30-second initial-readiness delay and a 5-minute CPU initialization period (`:163-178`).
- Missing metrics are then assumed to be 100% of target on scale-down and 0% on scale-up. Not-yet-ready Pods count as 0% on scale-up. If the adjusted ratio reverses direction or falls within tolerance, nothing happens (`:183-197`).
- The status still reports the unadjusted value (`:199-202`).
- Downscale stabilization picks the highest recommendation within a 5-minute window (`:213-218`).

**Why this matters here:** with slow startup, actual scaling will lag and be smaller than the raw usage/target ratio suggests.

### 7. Network least privilege

- **[P]** NetworkPolicy only has effect if the CNI plugin supports it (`docs/concepts/services-networking/network-policies.md:45-49, 92-95`).
- **[G]** Ingress and egress isolation are independent of each other. A Pod becomes isolated in a direction once any policy that selects it lists that direction in `policyTypes` (`:51-73`).
- **[G]** Policies are additive: the allowed set is the union of all applicable policies (`:75-77`).
- **[G]** A connection is allowed only if both the source's egress and the destination's ingress allow it (`:79-81`).
- **[G]** Traffic from the node is always allowed (`:33-36`).

**[C] Recommendation:** add a namespace default-deny for both ingress and egress (`:208-259`). Then allow:

- ingress to the API only from the ingress/load-balancer source;
- egress from the API to the database port;
- ingress to the database from the API.

**[N]** The retrieved pages don't document DNS requirements. Once egress is denied, an explicit egress rule to the cluster DNS will almost certainly be needed. Validate this in staging.

### 8. Secrets

**[G]** Base64 is not protection. Secrets are stored unencrypted in etcd by default. Anyone with API access or etcd access can read them. Anyone who can create Pods in the namespace, including indirectly by creating a Deployment, can read any Secret in that namespace (`docs/concepts/configuration/secret.md:35-41`). `stringData` exists only so you can skip the encoding (`:260-263`).

**[C/P] Steps:**

- Enable encryption at rest. Without `--encryption-provider-config`, or with `identity` as the first provider, data is not encrypted (`docs/tasks/administer-cluster/encrypt-data.md:61-64`).
- Restrict Secret access with least-privilege RBAC, limit it to specific containers, and consider an external secret store (`secret.md:42-48`).
- Restrict who can create Pods and workloads.
- Remove the plaintext-equivalent Secrets from Git.

### 9. Reclaim policy

- **[G]** Dynamically provisioned PVs get the StorageClass `reclaimPolicy` when they are created, defaulting to `Delete` (`docs/concepts/storage/storage-classes.md:126-135`; `docs/reference/kubernetes-api/config-and-storage-resources/persistent-volume-v1.md:120`).
- **[G]** To change an existing PV, edit or patch the PV itself (`docs/concepts/storage/persistent-volumes.md:205-210`).
- **[N]** The docs don't state in one sentence that editing the class leaves existing PVs unchanged. That follows from the per-PV, creation-time inheritance above. Verify by listing the PVs after any change.

**Retain vs Delete:**

- **[G] Retain:** deleting the PVC leaves the PV "Released" and keeps the data. Cleaning up the storage asset is manual (`:185-199`).
- **[G] Delete:** deleting the PVC removes both the PV and the external storage asset (`:201-205`).

**StatefulSet deletion and scaling vs PVC deletion:**

- **[G]** `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`) controls only whether PVCs are deleted when the StatefulSet is deleted or scaled down. It requires the `StatefulSetAutoDeletePVC` feature gate (`docs/concepts/workloads/controllers/statefulset.md:391-423`).
- Once a PVC is deleted, the PV's reclaim policy decides what happens to the data.
- A replacement Pod after node failure keeps its existing PVC (`:417-421`).

**[C]** Use `Retain` for the database volumes.

### 10. Prioritized checklist

1. Remove Secrets from Git. Enable and verify encryption at rest. Audit RBAC for Secret read and Pod/workload create.
2. Patch existing database PVs to `Retain` and verify each one.
3. Set the rollout to `maxSurge: 1` / `maxUnavailable: 0`. Revisit the PDB minimum and set `AlwaysAllow`.
4. Add CPU and memory requests and a memory limit. Confirm the HPA reports utilization.
5. Add startup, readiness and liveness probes sized from measured startup time.
6. Add a `preStop` hook and size the grace period from measured drain time.
7. Add zone spread with `minDomains`.
8. Confirm the CNI enforces NetworkPolicy, apply default-deny plus explicit allows including DNS, and test both ends of each connection.
9. Rehearse a node drain, a rolling update and a simulated zone loss while watching endpoints and error rates.

**Limits that still need application or cluster validation:**

- Request-drain time against the grace period, and how quickly load balancers react to endpoint changes.
- Whether two surviving zones can hold six replicas, or the HPA maximum.
- Actual startup duration, which determines the startup-probe and HPA readiness-window settings.
- CNI NetworkPolicy support and the exact DNS egress rule.
- Whether the storage driver supports `Delete`/expansion as expected (`persistent-volumes.md:203, 423-425`).
- Database failover behaviour. Nothing in these documents covers it.