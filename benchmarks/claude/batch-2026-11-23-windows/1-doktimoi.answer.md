# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs)

**Scope and method.** This memo checks the proposed design against the supplied v1.32 documentation only. Each finding is labelled as one of four kinds: **Guarantee** (the docs promise this behaviour), **Config** (a choice the team makes), **Prereq** (something that must be in place first) or **Not established** (the docs don't cover it). Paths are relative to `docs/`.

**Verdict:** Do not approve as proposed. Five items need changes before go-live: the rollout settings conflict with the PDB's intent, 30 seconds of grace may be too short, there is no network isolation, base64 Secrets are committed to Git, and the storage reclaim default is `Delete`.

---

### 1. PDB `minAvailable: 5` across the three disruption cases

- **Node drain (voluntary):** The PDB applies here. With 6 replicas it allows one eviction at a time through the Eviction API. `kubectl drain` retries rejected evictions until the Pods are gone or a timeout is reached (`concepts/workloads/pods/disruptions.md:92-131`). Evicted Pods get their full `terminationGracePeriodSeconds` (`disruptions.md:133-145`). Not every voluntary action is covered: deleting Pods or Deployments bypasses the PDB (`disruptions.md:21-65`). The docs recommend `AlwaysAllow` as the unhealthy-Pod eviction policy so a misbehaving app can't stall a drain (`disruptions.md:133-145`).
- **Node failure (involuntary):** **No guarantee.** A PDB cannot prevent involuntary disruptions, though they do count against the budget (`disruptions.md:92-131`, `21-65`). If one replica is lost to a failed node, the budget of 1 is already used up, so a drain started at the same time will block.
- **Rolling update:** **No guarantee.** Pods taken down by a rollout count against the budget, but Deployments "are not limited by PDBs when doing rolling upgrades"; the workload's own spec decides (`disruptions.md:133-145`). With `maxUnavailable: 2`, availability can drop to `replicas − maxUnavailable` = 4 (`concepts/workloads/controllers/deployment.md:1189-1199`, `327-332`). That breaks the intent behind minAvailable 5.
- **Recommendation (Config):** Set `maxUnavailable: 0` and `maxSurge: 1` (or 2). `maxSurge` can't be 0 when `maxUnavailable` is 0 (`deployment.md:1201-1206`). Surge Pods need extra capacity, and terminating Pods keep using resources until their grace period ends (`deployment.md:327-332`). Make sure the HPA minimum is above 5, or the PDB will block every drain.

### 2. Spreading across zones

`topologyKey` names the node label that defines a domain (`topology.kubernetes.io/zone`). `maxSkew` is the largest allowed difference between a domain's matching-Pod count and the global minimum. `DoNotSchedule` is the default and leaves the Pod pending. `ScheduleAnyway` only prefers placements that reduce skew (`concepts/scheduling-eviction/topology-spread-constraints.md:76-93`, `95-126`, `262-333`). Even that preference is weighed together with other scoring factors (`topology-spread-constraints.md:335-354`). Without explicit constraints, the built-in defaults are only `ScheduleAnyway` with zone `maxSkew: 5`, which is too weak for this design (`topology-spread-constraints.md:532-578`).

- **Config:** Use zone spreading with `maxSkew: 1` plus a hostname constraint. Choose `DoNotSchedule` for strict balance or `ScheduleAnyway` to keep the service available. Using `minDomains: 3` requires `DoNotSchedule` (`topology-spread-constraints.md:95-126`).
- **When a zone is unavailable:** Under `DoNotSchedule`, replacement Pods can stay pending if placing them would exceed the skew limit. Nodes that lack the key are skipped (`topology-spread-constraints.md:262-333`). Domains are discovered only from existing nodes, so a zone scaled to zero nodes isn't counted (`topology-spread-constraints.md:605-623`).
- **Not guaranteed:** Balance is not maintained after Pods are removed, for example on scale-down (`topology-spread-constraints.md:605-623`).

### 3. Probes for slow startup

- **Startup probe:** Set `failureThreshold × periodSeconds` to at least the worst-case startup time (example: 30×10 = 300 s). If it never succeeds, the container is killed and its `restartPolicy` applies (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). Liveness and readiness probes don't start until the startup probe succeeds (`concepts/workloads/pods/pod-lifecycle.md:474-500`, `configure-liveness-readiness-startup-probes.md:2-41`).
- **When traffic stops:** A failed readiness probe removes the Pod's IP from the endpoints of every matching Service. Readiness counts as Failure before the initial delay (`pod-lifecycle.md:474-500`).
- **When a container restarts:** A failed liveness probe, or a failed startup probe, kills the container (`pod-lifecycle.md:474-500`).
- **Config:** Point readiness at whether dependencies such as the DB are usable. Liveness should catch only real deadlocks, using a higher `failureThreshold` than readiness (`configure-liveness-readiness-startup-probes.md:2-41`).

### 4. Termination order: is 30 seconds enough?

1. The Pod is marked terminating with its deadline. The kubelet runs `preStop`, and the default grace period is 30 s (`pod-lifecycle.md:584-610`).
2. At the same time, the endpoint is marked terminating with `ready=false`, so load balancers stop sending it regular traffic. The `serving` condition still allows draining (`pod-lifecycle.md:612-634`, `concepts/services-networking/endpoint-slices.md:100-117`).
3. SIGTERM goes to PID 1. Containers receive it in no guaranteed order (`pod-lifecycle.md:560-582`, `584-610`).
4. When the grace period expires, SIGKILL is sent (`pod-lifecycle.md:636-645`). A `preStop` hook that is still running gets only a one-off 2 s extension. **The `preStop` hook shares the same clock,** so if it needs longer you must raise `terminationGracePeriodSeconds` (`pod-lifecycle.md:584-610`).

**Not guaranteed:** Nothing in the docs ensures that long requests finish within 30 s. Size the grace period from the measured worst-case request time plus the `preStop` duration.

### 5. Resources and throttling versus OOM

- **CPU limit:** A hard limit enforced by throttling (`concepts/configuration/manage-resources-containers.md:27-67`, `245-262`). The CFS quota is the default enforcement mechanism (`tasks/administer-cluster/cpu-management-policies.md:41-52`).
- **CPU request:** Sets a weighting under contention (`manage-resources-containers.md:245-262`).
- **Memory limit:** Enforced reactively by OOM kill, and the kernel acts only under memory pressure (`manage-resources-containers.md:27-67`). An OOM-killed container is restarted (`tasks/configure-pod-container/assign-memory-resource.md:130-197`). If only a limit is set, the request defaults to that limit (`manage-resources-containers.md:27-67`).
- **Effect on HPA:** Utilization is measured as a percentage of the request. **If any container lacks a CPU request, utilization is undefined and the HPA takes no action** for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-121`).
- **Config:** Set CPU requests on every container, including sidecars.

### 6. HPA: missing metrics, not-ready Pods and stabilization

- **Missing metrics:** These Pods are assumed to use 100% of the target when scaling down and 0% when scaling up.
- **Not-yet-ready Pods:** Treated as 0% on scale-up. A Pod counts as not yet ready based on `--horizontal-pod-autoscaler-initial-readiness-delay` (default 30 s) and `--horizontal-pod-autoscaler-cpu-initialization-period` (default 5 min).
- **Effect on the ratio:** If the recalculated ratio reverses direction or falls within tolerance, the HPA does nothing. The reported utilization is still the raw value (`horizontal-pod-autoscale.md:167-202`).
- **Default scale-down:** 300 s stabilization, using the highest recommendation from that window, at up to 100% per 15 s. Scale-up has no stabilization (`horizontal-pod-autoscale.md:455-486`, `reference/kubernetes-api/workload-resources/horizontal-pod-autoscaler-v2.md:90-170`).
- **Prereq:** `metrics.k8s.io` is usually provided by Metrics Server, which must be deployed separately (`horizontal-pod-autoscale.md:89-121`).
- **Consequence:** Slow startup means new Pods dampen scale-up. Actual scaling will therefore lag behind the raw ratio.

### 7. Least-privilege networking

- **Isolation:** Ingress and egress isolation are independent. A Pod becomes isolated in a direction only when a policy that selects it lists that direction in `policyTypes`. Policies are additive (a union), so order doesn't matter. A connection needs **both** the source's egress and the destination's ingress to allow it (`concepts/services-networking/network-policies.md:51-81`).
- **Always allowed:** Traffic from the Pod's own node (`network-policies.md:1-44`, `51-81`).
- **Config:** Start with a default deny for all ingress and egress (`network-policies.md:254-262`). Then add allow rules for client → API ingress and for API → DB egress on the DB port. The DB side needs a matching ingress rule.
- **Prereq:** A network plugin that enforces NetworkPolicy. Without one, the policies have no effect (`network-policies.md:45-49`).
- **Not established:** The docs I found contain no DNS-specific guidance; an exact search of `network-policies.md` for "DNS" returned nothing. With egress denied, an explicit allow to the cluster DNS must be added and tested.

### 8. Secrets

- **Base64 is not protection:** It is only an encoding (`tasks/inject-data-application/distribute-credentials-secure.md:17-34`). Secrets are stored **unencrypted in etcd by default**, and anyone with API or etcd access can read them (`concepts/configuration/secret.md:1-53`).
- **Required steps:** Enable encryption at rest, apply least-privilege RBAC, restrict which containers can access Secrets, and consider an external store (`secret.md:1-53`, `tasks/administer-cluster/securing-a-cluster.md:251-265`).
- **After enabling encryption:** Check that every existing Secret is actually encrypted before removing the `identity` provider (`tasks/administer-cluster/encrypt-data.md:617-634`).
- **Why Pod creation matters:** Anyone who can create Pods, or Deployments, can read every Secret in the namespace and act as any ServiceAccount there (`secret.md:1-53`, `concepts/security/rbac-good-practices.md:100-120`). Treat namespace boundaries as the trust boundary.
- **Decision:** Remove the Secrets from Git.

### 9. Storage reclaim policy

- **Defaults:** Dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which **defaults to `Delete`** (`concepts/storage/storage-classes.md:126-135`, `reference/kubernetes-api/config-and-storage-resources/storage-class-v1.md:83-99`).
- **`Delete`:** Removes both the PV and the backing storage asset (`concepts/storage/persistent-volumes.md:201-210`).
- **`Retain`:** After the PVC is deleted, the PV becomes "Released". Cleanup and asset deletion are manual (`persistent-volumes.md:185-199`).
- **Existing PVs:** The docs say a PV "must be edited or patched after it is created" if the class didn't match expectations (`persistent-volumes.md:201-210`). From that I infer that changing the policy does not rewrite existing PVs; patch each PV directly. The docs don't explicitly state what happens if the StorageClass itself is changed.
- **PVC deletion vs StatefulSet deletion or scale-down:** Deleting a PVC triggers the reclaim policy. By default, deleting or scaling down a StatefulSet does *not* delete its volumes (`concepts/workloads/controllers/statefulset.md:47-64`). `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, both defaulting to `Retain`) changes this and needs the `StatefulSetAutoDeletePVC` feature gate. These policies don't apply when a Pod is replaced after a node failure (`statefulset.md:387-436`, `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`).
- **Recommendation:** Use `Retain` for database data.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** Purge Secrets from Git and rotate them. Enable encryption at rest and verify every Secret is encrypted. Tighten RBAC, including who can create Pods.
2. **Storage:** Set DB PVs to `Retain` (patch the existing ones). Confirm the StatefulSet PVC retention policy.
3. **Rollout and PDB:** Set `maxUnavailable: 0` and `maxSurge: 1`, with an HPA minimum of at least 6. Use `unhealthyPodEvictionPolicy: AlwaysAllow`.
4. **Probes:** Add a startup probe sized to the measured worst-case startup, plus readiness and conservative liveness probes.
5. **Termination:** Add a `preStop` hook, and set the grace period to at least the `preStop` time plus the longest request.
6. **Resources:** Set CPU and memory requests on every container, and decide on a CPU limit to avoid throttling. Deploy Metrics Server, then tune the HPA.
7. **Spread:** Add zone and hostname spread constraints.
8. **Networking:** Confirm the CNI enforces policy. Apply default deny, then add allows for clients, the DB and DNS.
9. **Validate in staging:** Drain a node, simulate a zone outage, run a rollout under load, and run a load test while watching HPA lag.

**Limits that still need application or cluster validation:**

- **Long requests:** Whether they finish within the grace period is not guaranteed (`pod-lifecycle.md:584-610`).
- **Node or zone failure:** Availability during these events is not protected by the PDB (`disruptions.md:92-131`).
- **Pending Pods:** With `DoNotSchedule`, replacement Pods may stay pending after a zone loss (`topology-spread-constraints.md:262-333`, `605-623`).
- **NetworkPolicy:** Enforcement and the DNS rules depend on the plugin and cluster (`network-policies.md:45-49`).
- **Surge capacity:** Whether there is room for surge Pods during a rollout (`deployment.md:327-332`).
- **Database:** DB connection limits and failover behaviour are not covered by these docs.