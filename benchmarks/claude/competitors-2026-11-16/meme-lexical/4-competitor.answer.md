# Decision memo: production review of the API Deployment (Kubernetes v1.32 docs)

**Verdict:** Not ready to ship as proposed. Several settings rest on guarantees the docs don't give. The biggest problems are the PDB/rollout combination, the plaintext Secrets in Git, and the open network. Citations are `path:lines` under `docs/`.

**Labels:** **[G]** documented guarantee or behaviour · **[C]** configuration choice · **[P]** prerequisite · **[N]** not established by the docs.

---

### 1. Does `minAvailable: 5` keep five replicas available?

- **Node failure: no.** This is an involuntary disruption. PDBs can't prevent these, though such failures do count against the budget [G] (`concepts/workloads/pods/disruptions.md:30-34, 130-131`).
- **Node drain: partly.** `kubectl drain` goes through the Eviction API, which respects the PDB and retries when an eviction is refused [G] (`disruptions.md:107-116`). Two caveats:
  - Deleting pods or Deployments bypasses the PDB (`disruptions.md:62-65`).
  - With the default `IfHealthyBudget` policy, pods that never become healthy can block the drain. `AlwaysAllow` is recommended (`disruptions.md:138-141`; `tasks/run-application/configure-pdb.md:254-274`).
- **Rolling update: no.** Rollouts count against the budget, but Deployments are not limited by PDBs during rolling upgrades [G] (`disruptions.md:133-136`). With `maxUnavailable: 2`, the rollout may drop to 4 of 6 available (`concepts/workloads/controllers/deployment.md:1191-1199`).
- **Recommendation [C]:** set `maxUnavailable: 0` and `maxSurge: 1` (or 2). `maxUnavailable` may be 0 only when `maxSurge` is not 0 (`deployment.md:1194, 1203-1211`). Also note that `minAvailable: 5` of 6 leaves only one eviction of headroom. Any single unready pod blocks drains (`disruptions.md:118-121, 195-197`).

### 2. Zone spreading

- **topologyKey** is a node label. Each distinct value of that label is one domain. Use `topology.kubernetes.io/zone` [C] (`concepts/scheduling-eviction/topology-spread-constraints.md:117-120`; `reference/kubernetes-api/workload-resources/pod-v1.md:226`).
- **maxSkew** behaves differently per mode:
  - With `DoNotSchedule` it is a hard limit: a zone may hold at most `maxSkew` more pods than the emptiest eligible zone.
  - With `ScheduleAnyway` it is only a scoring preference (`topology-spread-constraints.md:82-93`).
- **`DoNotSchedule`** (the default) won't place a pod that would exceed the skew. **`ScheduleAnyway`** places it anyway and favours nodes that reduce skew (`:124-126`). A constraint is "unsatisfiable" only when every possible node would violate it (`pod-v1.md:233`).
- **Recommendation [C]:** `maxSkew: 1`, the zone key, `DoNotSchedule`, `minDomains: 3`, and `matchLabelKeys: [pod-template-hash]` so that each rollout revision is balanced on its own (`:107-115, 142-160`).
- **When a zone is unavailable [N/limits]:**
  - The scheduler only knows the zones that currently have nodes (`:614-623`).
  - With `minDomains: 3` and fewer eligible zones, the global minimum is treated as 0 (`:109-112`). A hard constraint can then leave replacement pods unscheduled. This is my inference; the docs don't state a timeline for it.
  - Constraints are not re-checked when pods are removed (`:607-611`).
  - Decide explicitly whether you prefer stricter spreading (`DoNotSchedule`) or restoring capacity (`ScheduleAnyway`) during a zone outage. Test the choice.

### 3. Probes for slow startup

- **startupProbe:** while it is defined, all other probes are disabled until it succeeds. If it fails, the container is killed and restarted under the restart policy [G] (`concepts/workloads/pods/pod-lifecycle.md:492-497`).
  - Size `failureThreshold × periodSeconds` to cover the worst-case startup time. Use the same endpoint as liveness (`pod-lifecycle.md:552-557`; `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:316-318`).
- **readinessProbe:** controls when traffic stops. On failure, the Pod's IP is removed from Service endpoints. Before the initial delay, readiness defaults to Failure (`pod-lifecycle.md:485-490`).
  - It may additionally check the database. Liveness should check only the process itself (`:524-528`).
- **livenessProbe:** controls when the container restarts. On failure, the kubelet kills the container (`:480-483`).
  - Keep liveness independent of the database. Otherwise a database outage restarts every replica. This is a design inference from `:524-528`.

### 4. Termination order

On deletion, these steps happen:

1. The grace-period deadline is recorded on the Pod in the API server (`pod-lifecycle.md:584-589`).
2. The `preStop` hook runs. It consumes the same grace period. If it is still running when the period ends, the kubelet adds a one-time 2-second extension (`:591-601`).
3. TERM (or the image's STOPSIGNAL) is sent to PID 1. The order across containers is not guaranteed (`:572, 603-610`).
4. In parallel, the endpoint is marked terminating with `ready=false`, so load balancers stop sending it regular traffic. The `serving` condition shows the pod's actual readiness (`:612-632`).
5. When the grace period expires, SIGKILL is sent (`:636-640`).

**Is 30 seconds enough? [N]** 30 s is only the default (`:594`). Nothing guarantees that long requests finish in time. Set `terminationGracePeriodSeconds` to at least the preStop delay plus the longest request plus a margin, and measure it. The same value applies to evictions (`disruptions.md:143-145`).

### 5. Resources

- **CPU limits** are enforced by throttling. CPU limits are hard caps (`concepts/configuration/manage-resources-containers.md:43-46`).
- **Memory limits** are enforced reactively by OOM kills, only when the kernel detects memory pressure (`:48-53`).
- **Utilization-based HPA needs CPU requests.** HPA computes utilization as a percentage of the container's request (`tasks/run-application/horizontal-pod-autoscale.md:92-97`). If any container lacks a CPU request, utilization is undefined and HPA takes no action for that metric [G] (`:99-102`).
- **Recommendation [C]:** set CPU requests on every container, including sidecars, and set a memory limit. Treat a CPU limit with caution, because throttling during startup slows a startup that is already slow. That last point is an inference.

### 6. HPA behaviour

- **Exclusions:**
  - Pods being deleted are ignored and failed pods are discarded (`horizontal-pod-autoscale.md:156-158`).
  - Pods with missing metrics are set aside (`:160-161`).
  - For CPU, pods that are not yet ready, or whose last sample predates readiness, are also set aside. Two windows govern this: initial-readiness-delay (30 s) and cpu-initialization-period (5 min) (`:163-178`).
- **Conservative recompute:** missing pods are assumed to use 100% of the target on scale-down and 0% on scale-up. Not-yet-ready pods are assumed to use 0% on scale-up. If the result reverses direction or falls within tolerance, nothing happens (`:183-197`).
- **Why results differ from the raw ratio:**
  - There is a 0.1 tolerance (`:145-147`).
  - The status field reports the unadjusted average (`:199-202`).
  - With multiple metrics, the highest recommendation wins (`:204-211`).
  - The downscale stabilization window defaults to 5 minutes and uses the highest recommendation within it (`:213-218`).
- **Implication:** slow-starting pods dampen scale-up. Set `minReplicas ≥ 6` so the PDB and zone spread stay meaningful. That is an inference.

### 7. Least-privilege networking

- **[P]** NetworkPolicy has no effect without a CNI plugin that implements it (`concepts/services-networking/network-policies.md:47-49`).
- **Isolation:**
  - Pods are non-isolated by default.
  - A pod becomes isolated for egress or ingress once any policy selecting it lists that type in `policyTypes`.
  - Allowed traffic is the union of matching rules, and replies are allowed implicitly (`:53-73`).
  - Policies are additive and never conflict (`:75-77`).
- **Both ends of a connection:** the source's egress policy *and* the destination's ingress policy must both allow it (`:79-81`).
- **Exceptions:** traffic from the pod's own node is always allowed, and a pod can't block itself (`:33-36, 70-71`).
- **Plan [C]:**
  1. Apply a default deny for all ingress and egress in the namespace (`:254-262`).
  2. Allow ingress from the Service's clients or ingress controller on the app port.
  3. Allow egress to the database pods or CIDR on the database port.
  4. Make sure the database side allows ingress from the API.
  5. Allow DNS egress.
- **DNS [N]:** I found no passage on DNS egress in this corpus. Because egress is denied by default (`:234-242`), an explicit DNS rule is necessary by inference. Find the DNS pod labels and ports in your own cluster.
- **NAT caveat:** `ipBlock` behaviour under NAT varies (`:200-206`).

### 8. Secrets

**Base64 encoding is not protection.**

- By default, Secrets are stored unencrypted in etcd. Anyone with API or etcd access can read them (`concepts/configuration/secret.md:35-37`).
- Anyone who can create a Pod, or indirectly a Deployment, in the namespace can read every Secret there (`:38-40`). Pod-create rights therefore count as secret-read rights.
- **Required steps:**
  1. Encryption at rest [P].
  2. Least-privilege RBAC [C].
  3. Restrict Secret access to the containers that need it.
  4. Consider an external secret store (`:42-48`).
- **Remove plaintext Secrets from Git.** The docs say nothing on Git workflows [N]. Since base64 data is still plaintext in effect, rotate any credential that has already been committed.

### 9. Reclaim policy and storage

- Dynamically provisioned PVs take the StorageClass's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`).
- **Changing the class does not touch existing PVs [N/inference].** The docs say that if the class is wrong, each PV must be edited or patched after creation (`concepts/storage/persistent-volumes.md:205-210`; `reference/kubernetes-api/config-and-storage-resources/persistent-volume-v1.md:118-120`). That implies a class change only affects newly provisioned volumes.
- **Retain vs Delete:**
  - **Retain:** deleting the PVC leaves the PV "Released" with its data. Cleanup and asset deletion are manual (`persistent-volumes.md:185-199`).
  - **Delete:** deletes both the PV and the external storage asset (`:201-205`).
- **PVC deletion vs StatefulSet deletion or scaling:**
  - The StatefulSet `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`) defaults to Retain. It needs the `StatefulSetAutoDeletePVC` feature gate [P]. It applies only when the StatefulSet is deleted or scaled down, not on node failure (`concepts/workloads/controllers/statefulset.md:387-423`).
  - Deleting the StatefulSet does not delete PVCs by default. Deleting a PVC whose PV has `Delete` destroys the data.
- **Recommendation:** use Retain for the database volumes.

### 10. Prioritized rollout and validation checklist

1. **Security:** enable encryption at rest. Purge and rotate the Secrets committed to Git. Lock down RBAC, including pod-create rights.
2. **Network:** confirm the CNI enforces NetworkPolicy. Apply default-deny, then the allow rules (clients→API, API→DB, DNS). Test both directions.
3. **Storage:** patch existing PVs to Retain and set the StorageClass to Retain. Test restore.
4. **Resources and HPA:** set CPU requests on every container, `minReplicas ≥ 6`, and a memory limit. Load-test HPA.
5. **Probes:** add a startupProbe sized from measured p99 startup time, plus separate readiness and liveness endpoints.
6. **Termination:** add a preStop delay. Set the grace period from measured request durations, and check that no 5xx errors occur during rollouts.
7. **Rollout and PDB:** `maxUnavailable: 0`, `maxSurge: 1`, PDB with `AlwaysAllow`. Run drain drills.
8. **Zone spread:** apply the spread constraint and simulate a zone outage.

**Limits the docs do not guarantee and that still need validation:**
- Whether the chosen grace period actually completes in-flight requests.
- Whether replacement capacity gets scheduled during a zone loss under `DoNotSchedule`.
- Whether the CNI enforces policy and correctly handles DNS and NAT for the database.
- Database-side connection draining and failover.
- That the provider's automated disruptions use the Eviction API (`disruptions.md:81-89`).
- Actual HPA reaction time given the startup and stabilization windows.