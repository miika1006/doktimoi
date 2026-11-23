# Decision memo: production readiness review of the API Deployment (Kubernetes v1.32)

**Scope.** This review uses only the supplied documentation. Paths are relative to `docs/`. Each point is labelled as one of four kinds: **[G]** a documented guarantee, **[C]** a configuration choice, **[P]** a prerequisite, or **[U]** something the docs do not establish.

**Verdict.** Do not approve the design as proposed. Three parts conflict with what the docs say:
- `maxUnavailable: 2` conflicts with the goal of keeping five Pods available.
- The 30-second grace period is not shown to cover long requests.
- base64 Secrets in Git, with default-allow networking, are not least privilege.

---

### 1. Does the PDB guarantee five available replicas?

**No, not in all three cases.**

- **Node failure.** A node failure is an involuntary disruption. **[G]** "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:21-65`, `:92-131`).
- **Node drain.** `kubectl drain` uses the Eviction API, and evictions that would break the budget are "temporarily rejected" and retried (`disruptions.md:92-131`). **[G]** With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time. The default policy waits for Pods to become healthy, so a drain can stall. The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy (`disruptions.md:133-145`). Deleting a Pod or Deployment directly bypasses the PDB (`disruptions.md:21-65`).
- **Rolling update.** **[G]** Workload resources "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-145`). With `maxUnavailable: 2`, only 4 of the 6 replicas are guaranteed available (`concepts/workloads/controllers/deployment.md:1189-1310`).

**Recommendation [C]:** use `maxUnavailable: 0` and `maxSurge: 1`. `maxUnavailable` may be 0 only when `maxSurge` is not 0 (`deployment.md:1189-1310`). The PDB's "intended" count comes from `.spec.replicas` (`disruptions.md:92-131`), so autoscaling changes what the budget allows.

### 2. Zone spreading

Use a constraint with `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1` and `whenUnsatisfiable: DoNotSchedule`. That keeps the Pods at 2/2/2. Add a softer constraint on `kubernetes.io/hostname`.

- **How the fields work [G]** (`concepts/scheduling-eviction/topology-spread-constraints.md:76-126`):
  - `maxSkew` is the maximum difference between a domain's count of matching Pods and the global minimum.
  - `topologyKey` names the node label that defines a domain.
  - `DoNotSchedule` (the default) leaves a Pod unscheduled if placing it would break the constraint.
  - `ScheduleAnyway` schedules the Pod anyway and only prefers nodes that reduce skew.
- **Built-in defaults are weak.** Without your own constraints, the scheduler uses soft defaults: zone `maxSkew: 5` and hostname `maxSkew: 3`, both `ScheduleAnyway` (`:532-578`).
- **When a zone is unavailable [G]:**
  - The scheduler only knows the zones that currently have nodes. A zone with zero nodes is not considered until it has a node again (`:605-625`).
  - Constraints are not kept after Pods are removed, and Pods are not rebalanced automatically. The docs suggest the Descheduler (`:605-625`).
- **Trade-off [U]:** whether `DoNotSchedule` leaves replacement Pods Pending during a partial zone outage depends on the real node state. Test it.

### 3. Probes for slow startup

- **Startup probe.** All other probes are disabled until the startup probe succeeds. If it fails, the container is killed and restarted (`concepts/workloads/pods/pod-lifecycle.md:474-500`). **[C]** Size `failureThreshold × periodSeconds` to cover the worst-case startup time. The docs' example is 30 × 10 s = 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **Readiness probe.** When it fails, the Pod's IP is removed from all matching Services, so **traffic stops** but the container keeps running (`pod-lifecycle.md:474-500`).
- **Liveness probe.** When it fails, the container is **restarted** (`pod-lifecycle.md:474-500`). The docs warn to use it only for unrecoverable failures, and suggest the same endpoint as readiness with a higher `failureThreshold` (`configure-liveness-readiness-startup-probes.md:1-41`).
- **[U]** Whether a check that depends on the database belongs in readiness is not covered by these docs.

### 4. Termination order

1. The Pod is marked Terminating. **[G]** The grace-period countdown starts *before* the preStop hook runs (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`).
2. The preStop hook runs. If it is still running when the grace period ends, the kubelet adds one 2-second extension (`pod-lifecycle.md:584-610`).
3. TERM is sent to each container's main process. Containers receive it in arbitrary order (`:584-610`).
4. When the grace period expires, KILL is sent to any remaining processes (`:559-582`).
5. At the same time as step 1, the Pod's endpoints stay in the EndpointSlice with `ready: false`. Clients that drain connections can check the `serving` condition instead (`:612-634`; `concepts/services-networking/endpoint-slices.md:100-117`).

**Is 30 seconds enough? No guarantee.** 30 s is only the default (`pod-lifecycle.md:584-610`), and the preStop hook uses up part of it. **[C/U]** Set `terminationGracePeriodSeconds` above preStop time plus the longest request, measured from real traffic. Eviction honours this setting (`disruptions.md:133-145`).

### 5. Resources

- **CPU [G]:** a CPU limit is enforced by throttling.
- **Memory [G]:** a memory limit is enforced reactively by OOM kills, and only when the kernel detects memory pressure (`concepts/configuration/manage-resources-containers.md:27-67`).
- **Missing request [G]:** if a limit is set without a request, the limit is copied in as the request (`:27-67`).
- **Side effects:** CPU limits "can have unintended effects on auto-scaling," and a memory limit above the request can expose the whole node to OOM (`concepts/security/security-checklist.md:138-152`).
- **HPA [G]:** utilization is computed as a percentage of the request. If any container in the Pod lacks a CPU request, CPU utilization is undefined and the HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-121`).

**[C]** Set a CPU request on every container.

### 6. How the HPA behaves

- **Missing metrics [G]:** the average is recomputed conservatively. Pods without metrics count as 100% of target when scaling down and 0% when scaling up (`horizontal-pod-autoscale.md:167-202`).
- **Not-yet-ready Pods [G]:** they count as 0% when scaling up, and their CPU samples may be set aside. The relevant defaults are a 30-second initial-readiness delay and a 5-minute CPU initialization period (`:167-202`).
- **Why scaling can differ from the raw ratio [G]:** if the recomputed ratio reverses direction or falls inside the tolerance, nothing happens. HPA status still shows the original average (`:167-202`).
- **Defaults [G]:** scale-down has a 300-second stabilization window. Scale-up has none and can add up to 100% or 4 Pods every 15 s (`:455-497`).
- **Prerequisite [P]:** the metrics API is usually provided by Metrics Server, which has to be launched separately (`:89-121`).
- **[C]** Set `minReplicas` to at least 6 so that scaling down does not undercut the PDB.

### 7. Least-privilege networking

- **Isolation [G]:** by default, Pods are not isolated in either direction. A Pod becomes isolated for ingress or egress once any policy selects it with that type in `policyTypes`.
- **Additive policies [G]:** allowed connections are the union of all applicable policies.
- **Both ends [G]:** a connection needs egress allowed on the source *and* ingress allowed on the destination (`concepts/services-networking/network-policies.md:51-81`).
- **[C]** Start with default-deny for both ingress and egress (`:209-232`, `:234-242`). Then allow:
  - ingress to the API only from its clients
  - egress from the API to the database port
  - ingress on the database side
- **DNS:** default-deny egress blocks everything, including DNS lookups. **[U]** The page gives no DNS-specific guidance, so the DNS egress rule has to be designed and tested.
- **CNI support [P]:** without a network plugin that implements NetworkPolicy, the objects "will have no effect" (`:45-49`).
- **Existing connections [U]:** whether a policy change affects connections already open depends on the implementation (`:464-472`).

### 8. Secrets

**base64 is not enough.**
- **[G]** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them. Anyone who can create Pods in the namespace, even indirectly through a Deployment, can read any Secret in it (`concepts/configuration/secret.md:1-53`).
- **Required steps [C]:**
  - Enable encryption at rest. It is optional and has to be configured (`tasks/administer-cluster/securing-a-cluster.md:251-265`).
  - Apply least-privilege RBAC.
  - Restrict which containers can access each Secret.
  - Consider an external secret store (`secret.md:1-53`).
- **Pod creation is sensitive.** The `edit` role allows reading Secrets and running Pods as any ServiceAccount in the namespace (`reference/access-authn-authz/rbac.md:667-686`).
- **[U]** The docs do not cover Git; remove the plaintext-equivalent values from the repository.

### 9. Storage and reclaim policy

- **Dynamically provisioned volumes [G]:** they take the StorageClass `reclaimPolicy`, which defaults to `Delete`. Manually created PVs keep the policy they were given at creation (`concepts/storage/storage-classes.md:126-135`).
- **Changing the StorageClass later [U, inferred]:** the docs say to edit or patch PVs that already exist (`concepts/storage/persistent-volumes.md:201-210`). That implies changing the class does not update existing PVs.
- **Delete [G]:** removes both the PV and the backing storage asset (`:201-210`).
- **Retain [G]:** keeps the PV in the "released" state for manual reclamation (`:185-199`).
- **Protection [G]:** a PVC that a Pod is using is not removed until that Pod stops using it (`:123-176`).
- **StatefulSet [G]:** deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:47-64`). `persistentVolumeClaimRetentionPolicy` defaults to `Retain`. It applies only when the StatefulSet is deleted or scaled down, not when a node fails (`:387-436`). Deleting a PVC directly then follows the PV's reclaim policy.
- **[C]** Use `Retain` for database data.

### 10. Prioritized rollout and validation checklist

1. Remove Secrets from Git. Enable encryption at rest. Tighten RBAC, including who can create Pods.
2. Confirm the CNI enforces NetworkPolicy. Apply default-deny plus explicit allows, including DNS.
3. Set `maxUnavailable: 0`, `maxSurge: 1`, PDB `minAvailable: 5`, the `AlwaysAllow` unhealthy-Pod policy and HPA `minReplicas ≥ 6`.
4. Add zone spreading with `DoNotSchedule` and a hostname constraint with `ScheduleAnyway`.
5. Add startup, readiness and liveness probes sized to measured startup time.
6. Set CPU requests on all containers and review CPU limits. Install Metrics Server.
7. Set the grace period and preStop hook from measured request duration.
8. Use a `Retain` StorageClass for the database, and patch existing PVs.
9. Run game days: drain a node, roll out a release, kill a zone and scale under load.

**Limits that still need cluster or application validation:**
- **Request length:** whether in-flight requests actually finish within the grace period, and whether the proxy and clients honour `serving`.
- **Node failure:** five-replica availability during a node or zone loss. The PDB cannot prevent that.
- **Zone loss:** scheduling and rebalancing behaviour with `DoNotSchedule` while a zone is degraded.
- **Policy changes:** how the CNI handles existing connections when policies change.
- **Startup time:** the worst case under load and with a cold database.
- **Database side:** the database's own high availability and connection limits. These docs do not cover them.