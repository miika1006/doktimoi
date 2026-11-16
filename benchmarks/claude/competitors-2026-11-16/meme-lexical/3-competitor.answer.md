# Decision memo: production readiness of the six-replica API design

**Sources:** Kubernetes v1.32 docs in `docs/` only. Citations are `path:lines`. Labels used below: **[G]** documented guarantee or behaviour, **[C]** configuration choice, **[P]** prerequisite, **[N]** something the docs do not establish (or that I am inferring).

**Verdict:** Don't approve the design as proposed. The rollout setting conflicts with the PDB's intent. The 30-second grace period is not proven long enough for long requests. Default-allow networking and Secrets in Git leave real gaps. The storage reclaim behaviour is the default `Delete` unless someone changes it.

---

### 1. Does the PDB keep five replicas available?

- **Node failure: no.** "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" [G] (`concepts/workloads/pods/disruptions.md:130-131`).
- **Node drain: yes, within limits.** `kubectl drain` uses the Eviction API, which respects PDBs. Rejected evictions are retried until they succeed or a timeout is reached [G] (`disruptions.md:107-121`). With `minAvailable: 5` and 6 replicas, only one Pod can be evicted at a time. "Healthy" means the Pod's `Ready` condition is True (`tasks/run-application/configure-pdb.md:236-240`). Under the default `IfHealthyBudget` policy, a Pod that is running but not Ready can block a drain. The docs recommend `AlwaysAllow` (`configure-pdb.md:242-274`, `disruptions.md:138-141`).
- **Rolling update: no.** Deployments "are not limited by PDBs when doing rolling upgrades" [G] (`disruptions.md:133-136`). `maxUnavailable: 2` lets the Deployment drop to 4 available Pods (`concepts/workloads/controllers/deployment.md:1189-1199`).
- **[N]** The intended Pod count comes from `.spec.replicas` (`disruptions.md:126-128`). If the HPA scales the Deployment to 5 or fewer replicas, an absolute `minAvailable: 5` would allow no voluntary evictions at all. This is my inference, so test it.
- **Recommendation [C]:** set `maxUnavailable: 0` and `maxSurge: 1`. This is valid because only one of the two may be 0 (`deployment.md:1191-1211`). Consider expressing the PDB as `maxUnavailable: 1` instead of `minAvailable: 5`.

### 2. Spreading replicas across zones

- **[C]** Use `topologyKey: topology.kubernetes.io/zone` and `maxSkew: 1`. A topology key groups nodes that share a label value into one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- **`DoNotSchedule` (the default):** `maxSkew` is a hard maximum difference from the global minimum. A Pod that would break it is not scheduled (`:82-93`, `:124-126`).
- **`ScheduleAnyway`:** the scheduler only prefers nodes that reduce skew (`:92-93`, `:126`).
- Add `matchLabelKeys: [pod-template-hash]` so that spreading is calculated per revision during rollouts (`:134-160`).
- **[G] limits:**
  - Spread is not maintained when Pods are removed, for example on scale-down (`:607-611`).
  - Zones are discovered only from existing nodes. A node group scaled to zero is not counted as a domain (`:614-619`).
  - `minDomains` makes the global minimum 0 when there are too few eligible domains (`:107-115`).
- **[N]** What happens during an actual zone outage is not documented. My inference: with `DoNotSchedule`, replacement Pods may stay Pending; with `ScheduleAnyway`, they pile into the surviving zones. Choose deliberately and test it.

### 3. Probes for slow startup

- **startupProbe:** all other probes are disabled until it succeeds. If it fails, the container is killed and restarted under the restart policy [G] (`concepts/workloads/pods/pod-lifecycle.md:492-497`).
  - Set `failureThreshold × periodSeconds` to cover the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-318`).
  - Example: 30 × 10 s = 300 s. After the first success, liveness takes over (`:342-347`).
- **readinessProbe:** a failure removes the Pod from Service endpoints, so traffic stops but there is no restart (`pod-lifecycle.md:485-490`). It runs for the container's whole lifecycle (`probes.md:360-362`).
- **livenessProbe:** a failure kills the container (`pod-lifecycle.md:479-483`). Readiness and liveness do not depend on each other (`probes.md:364-368`).
- **[C]** Keep the liveness probe on the app's own health. Readiness can also check backends such as the database (`pod-lifecycle.md:524-528`).

### 4. Termination order

1. The Pod is marked Terminating.
2. `preStop` runs. The grace-period clock (default 30 s) is already running. If the hook is still running when it expires, a one-off 2-second extension is granted (`pod-lifecycle.md:584-601`).
3. SIGTERM (or the image's STOPSIGNAL) is sent. Containers receive it in arbitrary order (`:572`, `:603-610`).
4. At the same time, endpoints are marked terminating with `ready=false`. Load balancers stop using them for regular traffic, while `serving` reflects actual readiness (`:612-632`).
5. When the grace period expires, SIGKILL is sent (`:573`, `:636-639`).

**[N]** 30 seconds is **not** guaranteed to finish long requests. The docs say that if `preStop` needs longer, you must raise `terminationGracePeriodSeconds` (`:598-601`). Size it as preStop time plus the longest request plus a margin.

### 5. Resources

- CPU limits are enforced by throttling. Memory limits are enforced reactively by OOM kills, only under memory pressure (`concepts/configuration/manage-resources-containers.md:36-53`).
- **[G]** HPA utilization is a percentage of the container *request*. If any container lacks a CPU request, utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-101`).
- **[C]** Set CPU requests on every container, including sidecars. Set memory limits. Validate that CPU limits do not throttle startup or long requests.

### 6. HPA behaviour

- Pods with missing metrics are set aside. Unready Pods, or Pods whose metric predates readiness, are set aside for CPU (`hpa.md:156-165`).
- The readiness windows are 30 s (`initial-readiness-delay`) and 5 min (`cpu-initialization-period`) (`:167-178`).
- Missing metrics are treated as 100% usage on scale-down and 0% on scale-up. Not-yet-ready Pods count as 0% on scale-up (`:183-191`).
- If the recalculated ratio reverses direction or falls within tolerance, nothing happens (`:193-197`). The status still reports the raw value (`:199-202`).
- The downscale stabilization window defaults to 5 minutes and takes the highest recommendation in that window (`:213-218`).
- Result: scaling differs from the raw ratio. Slow startup makes scale-up more damped.

### 7. Least-privilege networking

- **[P]** A NetworkPolicy has no effect without a network plugin (CNI) that implements it (`concepts/services-networking/network-policies.md:45-49`).
- **Isolation:**
  - Ingress and egress isolation are independent. A Pod becomes isolated in a direction once any policy selecting it lists that type (`:51-73`).
  - Policies are additive, so the allowed traffic is their union (`:75-77`).
  - **Both** the source's egress and the destination's ingress must allow a connection (`:79-81`).
  - Traffic from the node is always allowed (`:35-36`, `:70-71`).
- **[C]** Apply default-deny for ingress and egress in the namespace (`:208-242`), then allow:
  - ingress from the ingress controller on the API port;
  - egress to the database, with a matching ingress rule on the database side.
- **DNS [N]:** my searches found no DNS-specific text. Once a Pod is egress-isolated, only listed egress is allowed (`:59-65`), so DNS to the cluster resolver must be explicitly allowed. That is an inference.
- **[N]** `ipBlock` behaviour under NAT varies by plugin (`:192-206`).

### 8. Secrets

- **[G]** Base64 is not protection. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them (`concepts/configuration/secret.md:35-40`).
- The listed mitigations are:
  - encryption at rest;
  - least-privilege RBAC;
  - restricting Secret access to specific containers;
  - external secret stores (`:42-48`).
- Encryption at rest covers API data, not mounted volumes (`tasks/administer-cluster/encrypt-data.md:12-32`).
- `list` and `watch` reveal Secret contents (`concepts/security/rbac-good-practices.md:93-98`).
- **Pod creation matters:** permission to create Pods or Deployments can read any Secret in the namespace (`secret.md:38-40`). It also implicitly grants access to every ServiceAccount in the namespace (`rbac-good-practices.md:100-113`).
- Other least-privilege rules: prefer namespace-scoped RoleBindings, avoid wildcards, and disable token automount (`:25-45`, `:71-75`).
- **[C]** Remove plaintext Secrets from Git. Note that the docs here do not prescribe a Git workflow.

### 9. Storage reclaim

- Dynamic PVs take the StorageClass's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
- **Delete** removes the PV and the external storage asset. **Retain** keeps a "released" PV that needs manual cleanup (`concepts/storage/persistent-volumes.md:185-210`).
- The docs say to edit or patch an existing PV to change its policy (`:207-210`). So changing the class does not rewrite existing PVs. That is an inference.
- StatefulSet `persistentVolumeClaimRetentionPolicy`:
  - It is separate from the PV reclaim policy, has two settings (`whenDeleted`, `whenScaled`), and defaults to `Retain`.
  - It only applies when the StatefulSet is deleted or scaled down, not when a Pod is replaced after a node failure.
  - It requires the `StatefulSetAutoDeletePVC` feature gate (`concepts/workloads/controllers/statefulset.md:387-423`).
- Deleting a PVC is what triggers the PV reclaim policy.
- **[C]** Use `Retain` for the database's volumes. The stateless API should need no PV.

### 10. Prioritized rollout and validation checklist

1. Change the rollout to `maxSurge: 1` and `maxUnavailable: 0`. Set the PDB with `unhealthyPodEvictionPolicy: AlwaysAllow`, and check how it interacts with the HPA's minimum replicas (Q1).
2. Add the startup, readiness and liveness probes, and measure worst-case startup time (Q3).
3. Raise `terminationGracePeriodSeconds` to the measured drain time and add a `preStop` hook (Q4).
4. Set CPU requests on every container, then deploy the HPA (Q5–6).
5. Add zone spread constraints and test with a node group in each zone (Q2).
6. Confirm the CNI enforces NetworkPolicy, then apply default-deny plus allows, including DNS (Q7).
7. Enable encryption at rest, tighten RBAC including Pod creation, and remove Secrets from Git (Q8).
8. Set `Retain` on the database StorageClass and patch existing PVs (Q9).

**Limits that still need application or cluster validation:**
- **Request drain time:** whether in-flight long requests finish inside the grace period. Nothing kills them before SIGKILL, but nothing guarantees they complete.
- **Zone outage:** how scheduling behaves when a zone is down.
- **CNI enforcement:** whether the network plugin enforces policies and DNS/NAT `ipBlock` rules.
- **Endpoint draining:** whether load balancers honour the `serving` and `terminating` conditions.
- **Database:** the database's own failover and consistency. The docs do not establish it.