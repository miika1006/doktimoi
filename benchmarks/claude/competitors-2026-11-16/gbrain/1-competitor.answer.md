# Decision memo: production readiness of the six-replica API design

**Basis:** Kubernetes v1.32 docs in the supplied `docs/` folder only. Search was keyword-only. Where these docs do not settle a point, the memo says so.

**Verdict:** Not ready as proposed. Three parts of the design undermine each other:
- The PDB does not limit Deployment rollouts, and `maxUnavailable: 2` breaks the five-replica target.
- Base64 Secrets in Git are not protected.
- Default-allow networking is the opposite of least privilege.

---

### 1. Does the PDB guarantee five available replicas?

**No.** With six replicas and `minAvailable: 5`, only one voluntary disruption is allowed at a time.

- **Node failure:** This is an involuntary disruption (`concepts/workloads/pods/disruptions.md:26-34`). A PDB cannot prevent it, although the lost Pods do count against the budget (`:130-131`). With two Pods per zone, losing a zone leaves four. Drains are then blocked until Pods recover (`:195-197`).
- **Node drain:** `kubectl drain` uses the Eviction API, which respects the PDB. It evicts one Pod at a time and retries rejected evictions (`:107-121`). Drains can stall if a replacement Pod cannot be scheduled (`:212-219`). Deleting Pods or Deployments directly bypasses PDBs (`:62-65`).
- **Rolling update:** Deployments are not limited by PDBs during rolling updates (`:133-136`). `maxUnavailable: 2` lets availability fall to four (`concepts/workloads/controllers/deployment.md:1191-1199`).

**Recommended rollout settings:** `maxUnavailable: 0` and `maxSurge: 1`. This combination is allowed because only one of the two may be 0 (`deployment.md:1194, 1203-1206`). Add the PDB's `AlwaysAllow` unhealthy-Pod eviction policy so drains are not blocked by misbehaving Pods (`disruptions.md:138-141`).

**Watch with HPA:** The PDB computes the "intended" Pod count from `.spec.replicas` (`disruptions.md:126-128`). When the HPA changes the replica count, a fixed `minAvailable: 5` allows a different number of disruptions, so check the PDB value against the HPA's minimum.

### 2. How should replicas be spread across zones?

Use these settings:
- `topologyKey: topology.kubernetes.io/zone`, which is the recommended well-known label (`concepts/scheduling-eviction/topology-spread-constraints.md:206-215`).
- `maxSkew: 1`, with `matchLabelKeys: [pod-template-hash]` so each Deployment revision is spread on its own (`:134-160`).

How the fields work:
- **maxSkew:** With `DoNotSchedule`, this is the largest allowed difference between a zone's Pod count and the global minimum (`:82-91`).
- **DoNotSchedule** (the default) leaves a Pod Pending rather than break the constraint. **ScheduleAnyway** still schedules it and only prefers placements that lower the skew (`:92-93, 124-126`).

**When a zone is unavailable:**
- Zones are discovered from existing nodes. A zone with no nodes is not considered at all (`:614-623`).
- Removing Pods can leave the spread unbalanced, because constraints are only checked at scheduling time (`:607-611`).
- The docs do not spell out exactly what happens when a zone fails. Inference: with `DoNotSchedule`, replacements may stay Pending. With `ScheduleAnyway`, they pack into the surviving zones.

**Recommendation:** Use `DoNotSchedule` together with spare capacity in each zone, and test a zone failure.

### 3. Which probes fit slow startup?

- **startupProbe:** Same endpoint as the liveness probe. Set `failureThreshold × periodSeconds` to cover the worst-case startup time. The example gives 30 × 10 s = 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **When the other probes begin:** All other probes are disabled until the startup probe succeeds (`concepts/workloads/pods/pod-lifecycle.md:492-497`). Their delays also start only after that (`probes task:398-402`).
- **When a container restarts:** When the liveness or startup probe fails `failureThreshold` times in a row (`:412-418`; `pod-lifecycle.md:479-483`).
- **When traffic stops:** When the readiness probe fails, the Pod is removed from Service endpoints, but its containers keep running (`pod-lifecycle.md:485-490`; `probes task:349-358`).
- **Database dependency:** A readiness probe can check back-end dependencies while the liveness probe checks only the app itself (`pod-lifecycle.md:524-528`).
- **Caution:** Make the liveness probe check the app only, never the database, or a database outage can trigger restarts across all replicas. The docs do not state this directly.

### 4. Termination order: is 30 seconds enough?

The order the docs describe:
1. The Pod is marked Terminating.
2. If a `preStop` hook is defined, the kubelet runs it.
3. SIGTERM is sent to each container, in arbitrary order (`pod-lifecycle.md:584-610`).

The grace-period clock covers both `preStop` and SIGTERM handling:
- The default grace period is 30 s.
- If `preStop` is still running when the period expires, the kubelet adds one 2-second extension (`:591-601`).
- After that, SIGKILL is sent to anything still running (`:572-577, 636-639`).

**Service endpoints:** At the same time, the control plane evaluates removing the Pod from EndpointSlices. Terminating endpoints are not removed immediately. They report `ready=false` and expose a separate `serving` condition (`:612-632`).

**Is 30 s guaranteed?** No. Nothing in the docs guarantees that long requests finish in 30 s. Measure the longest request duration and set `terminationGracePeriodSeconds` to cover the `preStop` time plus draining time.

### 5. CPU and memory requests and limits

- **Requests:** The kubelet reserves the request. A container may use more than its request if the node has spare capacity (`concepts/configuration/manage-resources-containers.md:20-34`).
- **CPU limit:** Enforced by throttling. It is a hard cap (`:43-46`).
- **Memory limit:** Enforced reactively by OOM kills. The kernel kills the container only under memory pressure (`:48-53`).
- **Limit without a request:** The request defaults to the limit (`:63-67`).
- **Effect on HPA:** If any container lacks a CPU request, CPU utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`).

**Recommendation:** Set CPU requests on every container, sidecars included.

### 6. How does HPA handle missing metrics and not-yet-ready Pods?

- **Skipped Pods:** Pods being deleted and failed Pods are ignored. Pods with missing metrics are set aside, and so are not-yet-ready Pods when scaling on CPU (`horizontal-pod-autoscale.md:153-178`).
- **Readiness timing:** Two controller flags decide which Pods count as not yet ready. The initial-readiness delay defaults to 30 s and the CPU-initialization period to 5 minutes. A slow-starting app is directly affected.
- **Conservative recalculation:**
  - Pods with missing metrics are assumed to use 100% of the target when scaling down and 0% when scaling up.
  - Not-yet-ready Pods are assumed to use 0% when scaling up.
  - If this reverses the scaling direction, or brings the ratio within the 0.1 tolerance, the HPA does nothing (`:144-147, 183-197`).
- **Scale-down smoothing:** The HPA picks the highest recommendation from the last 5 minutes, which is the default downscale stabilization window (`:213-218`).
- **Status:** The HPA reports the original, unadjusted utilization in its status (`:199-202`).

For these reasons, scaling can differ from the raw ratio.

### 7. Replacing default-allow networking

- **Ingress and egress isolation:** These are separate. A Pod becomes isolated in a direction only when some policy selecting it lists that direction in `policyTypes`. Reply traffic is allowed implicitly (`concepts/services-networking/network-policies.md:51-73`).
- **Additive policies:** Policies combine as a union. Evaluation order does not matter (`:75-77`).
- **Both ends:** A connection needs the source Pod's egress *and* the destination Pod's ingress to allow it (`:79-81`).
- **Plan:**
  - Start with a namespace-wide default-deny for both directions (`:254-262`).
  - Allow ingress to the API from its callers only.
  - Allow egress from the API to the database port only.
  - Allow the database's ingress from the API.
- **DNS:** Once egress is denied, DNS lookups are denied too unless explicitly allowed. This follows from `:59-64`; the docs I found do not give a DNS example, so the DNS rule needs testing.
- **Limits of what policies cover:**
  - Traffic from the Pod's own node is always allowed (`:35-36`).
  - Deny rules are only guaranteed for TCP, UDP and SCTP (`:275-279`).
  - Whether `ipBlock` sees original or rewritten addresses depends on the plugin (`:196-206`).
- **CNI support (prerequisite):** Without a network plugin that enforces NetworkPolicy, policy objects have no effect (`:45-49`).

### 8. Is base64 enough to protect Secrets?

**No.** Secrets are stored unencrypted in etcd by default. Anyone with API access or etcd access can read them (`concepts/configuration/secret.md:35-37`). Base64-encoded files in Git add a second exposure: anyone who can read the repository can read the Secrets.

**Pod-creation permission matters.** Anyone who can create a Pod in a namespace can read any Secret there. This includes indirect access, such as permission to create a Deployment (`:38-40`).

Required steps (`:42-51`):
- Enable encryption at rest. It covers API data only, not mounted volumes (`tasks/administer-cluster/encrypt-data.md:12-32`).
- Apply least-privilege RBAC to Secrets, and also to create/update on Pods and Deployments.
- Restrict Secret access to the containers that need it.
- Consider an external secret store.

### 9. StorageClass reclaim policy and existing PVs

- **What sets a PV's policy:** Dynamically provisioned PVs take the `reclaimPolicy` from their class when they are created. The default is `Delete` (`concepts/storage/storage-classes.md:126-135`). Existing PVs must be edited or patched one by one (`concepts/storage/persistent-volumes.md:201-210`).
- **Inference:** Changing the class's policy therefore does not change existing PVs. The docs do not state this explicitly.
- **Retain vs Delete:**
  - **Retain:** After the PVC is deleted, the PV becomes "Released" and the data stays. Cleanup is manual (`:185-199`).
  - **Delete:** Removes both the PV and the external storage asset (`:201-205`).
- **StatefulSets:** `persistentVolumeClaimRetentionPolicy` sets two cases. `whenDeleted` applies when the StatefulSet is deleted. `whenScaled` applies when replicas are scaled down. Both default to `Retain` (`concepts/workloads/controllers/statefulset.md:387-423`).
  - These policies apply only when the StatefulSet is deleted or scaled down. A Pod replaced after node failure keeps its PVC (`:417-421`).
  - Even when the PVC is deleted, whether the data survives still depends on the PV reclaim policy.

**Recommendation:** Use `Retain` for the database's volumes.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** Remove them from Git and rotate them. Enable encryption at rest. Restrict RBAC, including Pod creation (Q8).
2. **Storage:** Set `Retain` on the database's StorageClass and patch existing PVs (Q9).
3. **Rollouts:** Set `maxUnavailable: 0, maxSurge: 1` and the `AlwaysAllow` PDB policy. Check the PDB value against the HPA's minimum (Q1).
4. **Probes:** Size the startup probe to measured worst-case startup. Make readiness check the database dependency and liveness check the app only (Q3).
5. **Termination:** Add `preStop` and set the grace period to the longest request plus margin (Q4).
6. **Resources:** Set CPU requests everywhere and a memory limit. Confirm Metrics Server is running (`horizontal-pod-autoscale.md:113-118`) (Q5–6).
7. **Zones:** Add zone spread constraints and per-zone spare capacity (Q2).
8. **Networking:** Confirm the CNI enforces NetworkPolicy. Then apply default-deny plus allow rules for the API, the database and DNS (Q7).

**Limits that still need application or cluster testing** (these docs do not guarantee them):
- That the longest request finishes within the chosen grace period.
- Real startup time compared with the startup probe's threshold and the HPA's 5-minute CPU-initialization window.
- That replacements can be scheduled when a zone is lost, and whether drains stall.
- Which voluntary disruptions the provider runs (`disruptions.md:58-60, 81-89`).
- That the CNI actually enforces the policies, including DNS and the database path.
- How the application and database tolerate connection resets during rollouts.