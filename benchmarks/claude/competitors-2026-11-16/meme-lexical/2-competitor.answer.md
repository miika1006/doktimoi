# Decision memo: production readiness of the six-replica API

**Recommendation:** Do not approve the design as written. Four parts conflict with what the documentation guarantees: rolling updates with `maxUnavailable: 2`, default-allow networking, base64 Secrets in Git, and the default `Delete` reclaim policy for database data. Approve it once the changes below are made and the validations in section 10 pass.

Kinds of claim: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs. Paths are relative to `docs/`.

---

### 1. PDB `minAvailable: 5`

- **Node failure:** **[G]** The PDB cannot protect against this. "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:130-131`). Hardware failure, VM loss, partition and node-pressure eviction are involuntary (`:26-34`). If a node or zone holding two replicas is lost, only four remain.
- **Node drain:** **[G]** Drain goes through the Eviction API, which respects the budget. With 6 replicas and minAvailable 5, only one eviction is allowed at a time (`:119-121`). In the docs' example, drain stops until the replacement Pod becomes available, or until a new node is added (`:195-223`). **[C]** `AlwaysAllow` is recommended so unhealthy Pods don't block drains (`:138-141`).
- **Rolling update:** **[G]** Deployments "are not limited by PDBs when doing rolling upgrades", even though those Pods count against the budget (`:133-136`). `maxUnavailable: 2` lets availability fall to 4 of 6 (`concepts/workloads/controllers/deployment.md:1191-1199`). This directly conflicts with the intent of minAvailable 5.
- **Recommendation [C]:** Use `maxUnavailable: 0` and `maxSurge: 1`. maxUnavailable can be 0 only if maxSurge is not 0 (`deployment.md:1194, 1203-1206`). Add `minReadySeconds` so a new Pod counts as available only after it has stayed ready for a while (`:1325-1328`). Budget for the extra surge capacity (`:329-330`).

### 2. Spreading across zones

- **[C]** Use `topologySpreadConstraints` with `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1` and `labelSelector` set to the app's labels. Add `matchLabelKeys: [pod-template-hash]` so spread is calculated per revision during rollouts (`concepts/scheduling-eviction/topology-spread-constraints.md:117-120, 128-160`).
- **[G] maxSkew:** With `DoNotSchedule`, this is the largest allowed difference from the global minimum. `ScheduleAnyway` only gives preference to placements that reduce skew (`:82-93`).
- **[G] DoNotSchedule vs ScheduleAnyway:** `DoNotSchedule` is the default and leaves the Pod unscheduled. `ScheduleAnyway` places it anyway (`:124-126`).
- **[G] When a zone is unavailable:** Under `DoNotSchedule`, replacement Pods may stay Pending instead of piling into the remaining zones. Under `ScheduleAnyway`, capacity wins over balance.
- **[G] Limits:** Spread is not maintained when Pods are removed. Zones are known only from existing nodes, so a zone scaled to zero nodes is ignored (`:607-619`). `minDomains` changes the global-minimum calculation (`:107-115`).
- **[N]** Whether spare capacity exists in the surviving zones. Choose `ScheduleAnyway` if availability matters more than balance.

### 3. Probes for slow startup

- **Startup probe [C]:** Use the same endpoint as liveness, with `failureThreshold × periodSeconds` greater than the worst-case startup time. The docs' example is 30×10 = 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-318, 343-346`; `concepts/workloads/pods/pod-lifecycle.md:552-557`).
- **[G] When the other probes begin:** Liveness and readiness are disabled until the startup probe succeeds (`pod-lifecycle.md:492-497`).
- **[G] When a container restarts:** A failing startup or liveness probe kills the container, which then follows its restart policy (`:479-483, 495-496`).
- **[G] When traffic stops:** A failing readiness probe removes the Pod from all matching Services' endpoints. Readiness starts as Failure (`:485-490`).
- **[C]** Keep a dependency check (for example, the database) in readiness, not liveness (`:524-528`).

### 4. Termination order

**[G]** The sequence (`pod-lifecycle.md:572-640`):

1. The Pod is marked Terminating.
2. `preStop` runs. If it is still running when the grace period ends, the kubelet adds a one-time 2-second extension (`:591-601`).
3. SIGTERM, or the image's STOPSIGNAL, is sent (`:572, 603-610`).
4. At the same time, endpoints are marked terminating with `ready=false`, so load balancers stop using them for regular traffic (`:612-628`).
5. When the grace period expires, SIGKILL is sent (`:637-639`).

**[G]** The grace-period clock covers both preStop and SIGTERM handling; a preStop that needs more time requires a larger `terminationGracePeriodSeconds` (`:598-601`). Evictions honor the grace period (`disruptions.md:143-145`).

**[N]** That 30 seconds is enough to finish long requests. Nothing guarantees it. Measure the 99th-percentile request time plus drain time and set the grace period above it.

### 5. Resources

- **[G] CPU limit:** Enforced by throttling. It is a hard limit (`concepts/configuration/manage-resources-containers.md:43-46`).
- **[G] Memory limit:** Enforced reactively by OOM kills under memory pressure (`:48-53`). The result shows as `OOMKilled` (`:901-922`).
- **[G] Missing CPU requests:** If any container lacks a CPU request, CPU utilization for the Pod is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:90-102`).
- **[C]** Set CPU requests on every container, including sidecars. Set memory limits. Decide on CPU limits carefully, because throttling makes slow startup and long requests even slower.

### 6. HPA behaviour

- **[G] Not-yet-ready Pods and missing metrics:** Both are set aside (`horizontal-pod-autoscale.md:160-178`). The average is then recomputed conservatively: missing Pods count as 100% on scale-down and 0% on scale-up. Not-yet-ready Pods count as 0% on scale-up (`:183-191`).
- **[G] No action:** The HPA does nothing if the recomputed ratio reverses direction or falls within the 0.1 tolerance (`:145-147, 193-197`).
- **[G] Downscale stabilization:** The highest recommendation within the window is used. The default window is 5 minutes / 300 s; there is no scale-up window (`:213-218, 480-484`).
- **[G]** If a metric can't be fetched, scale-down is skipped (`:204-211`).
- **Why scaling can differ from the raw ratio:** tolerance, set-aside Pods, conservative recomputation and the stabilization window. Slow startup keeps new Pods "not yet ready" longer. The relevant controller flags default to 30 s and 5 min (`:172-178`).

### 7. Least-privilege networking

- **[P]** The CNI plugin must implement NetworkPolicy. Without that, policies have no effect (`concepts/services-networking/network-policies.md:47-49`).
- **[G] Isolation:** Pods are non-isolated by default. Any policy that selects a Pod with Ingress or Egress in `policyTypes` isolates it in that direction. Allowed traffic is the union of all applicable policies, and reply traffic is implicit (`:59-77`).
- **[G] Both ends:** The source's egress and the destination's ingress must both allow a connection (`:79-81`).
- **[G] Exceptions:** Traffic from the Pod's own node is always allowed (`:35-36, 70-71`).
- **[C]** Apply default-deny ingress and egress (`:214-259`). Then allow ingress from the ingress or load-balancer Pods to the API port, and egress from the API to the database port. The database side needs a matching ingress allow. The security checklist asks for the same (`concepts/security/security-checklist.md:54-57`).
- **[N] DNS:** The sources I retrieved don't say how to allow DNS (a search for DNS/port-53 guidance returned nothing). Under egress default-deny, DNS will still be blocked unless explicitly allowed, so add a DNS egress rule and test it.

### 8. Secrets

- **[G]** Base64 is not protection. Base64 values are "obscured but not secret" (`concepts/configuration/secret.md:306`). Secrets are stored unencrypted in etcd by default (`:36-37`). Committing them to Git exposes them to everyone with repository access **[N: the docs don't address Git; this is an inference]**.
- **[C]** Enable encryption at rest. Use least-privilege RBAC. Restrict Secrets to specific containers. Consider an external secret store (`:42-48`).
- **[G]** `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:93-98`).
- **[G] Why Pod creation matters:** Anyone who can create Pods, or Deployments, in a namespace can read every Secret there and act as any ServiceAccount there (`secret.md:38-40`; `rbac-good-practices.md:100-108`).

### 9. Storage reclaim

- **[G] Changing the StorageClass:** A dynamically provisioned PV gets the class's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`). The PV keeps that policy afterwards, so changing the class later does not update existing PVs. Each one must be edited or patched (`concepts/storage/persistent-volumes.md:205-210`).
- **[G] Delete:** Deleting the PVC removes both the PV and the underlying storage asset (`persistent-volumes.md:201-205`).
- **[G] Retain:** The PV becomes "Released" and the data stays. An administrator has to clean it up manually (`:185-199`).
- **[G] PVC deletion vs StatefulSet deletion or scaling:** Deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). `persistentVolumeClaimRetentionPolicy` `whenDeleted`/`whenScaled: Delete` changes this, and requires the `StatefulSetAutoDeletePVC` feature gate (`:391-411`). Deleting a PVC is what triggers the PV's reclaim policy.
- **[C]** Use `Retain` for database data.

### 10. Rollout and validation checklist (in priority order)

1. Move Secrets out of Git. Enable encryption at rest. Audit RBAC for `get`/`list`/`watch` on Secrets and for Pod-creation rights (Q8).
2. Set `reclaimPolicy: Retain` on the class and patch existing database PVs (Q9).
3. Change the rollout to `maxUnavailable: 0`, `maxSurge: 1` and add `minReadySeconds`. Keep the PDB and add `AlwaysAllow` (Q1).
4. Add startup, readiness and liveness probes (Q3), CPU requests on every container, and memory limits (Q5).
5. Set the termination grace period above measured drain time plus preStop (Q4).
6. Add zone topology spread (Q2).
7. Confirm the CNI supports NetworkPolicy. Apply default-deny, then allows for the app, the database and DNS (Q7).
8. Configure HPA behaviour and minimum replicas (Q6).
9. Rehearse: drain a node, run a rollout, and simulate a zone failure. Watch available replica count and error rates during each.

**Limits that need application or cluster validation, because these docs do not guarantee them:**

- **Request completion within the grace period.** Graceful shutdown on SIGTERM, and long-request duration, are application behaviour (`pod-lifecycle.md:572-577, 619-622`).
- **Surviving a zone loss.** Spare capacity in the remaining zones and node-autoscaler behaviour are cluster facts (`topology-spread-constraints.md:614-619`; `disruptions.md:212-223`).
- **Actual network enforcement, including DNS.** This depends on the CNI (`network-policies.md:47-49`).
- **Metrics-pipeline availability.** HPA behaviour depends on it (`horizontal-pod-autoscale.md:204-211`).
- **Which voluntary-disruption sources the provider runs** (`disruptions.md:58-60, 84-87`).
- **The database's own failover and consistency.** Kubernetes storage policies keep or delete volumes but do not establish database correctness.