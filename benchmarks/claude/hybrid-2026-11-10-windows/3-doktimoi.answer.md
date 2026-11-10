# Decision memo: six-replica API on Kubernetes v1.32

**Verdict: do not approve as proposed.** The PDB, rollout settings, networking and Secret handling don't give the protection the team expects. Paths below are relative to `docs/`. Each point is labelled as one of: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

### 1. Does `minAvailable: 5` guarantee five available replicas?
No. It holds in only one of the three cases.
- **Node failure:** this is an involuntary disruption (`concepts/workloads/pods/disruptions.md:21-35`). **[G]** PDBs "cannot prevent" involuntary disruptions, though those disruptions do count against the budget (`disruptions.md:130-131`).
- **Node drain:** `kubectl drain` goes through the Eviction API. Evictions can be rejected for a while and are retried until a timeout (`disruptions.md:107-116`). **[G]** With 6 replicas and minAvailable 5, only one Pod can be evicted at a time (`disruptions.md:118-121`). **[C]** The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy; by default a drain waits for Pods to become healthy (`disruptions.md:138-141`). **[N]** Deleting Pods or Deployments directly skips the PDB (`disruptions.md:62-65`).
- **Rolling update:** **[G]** Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). `maxUnavailable: 2` therefore allows 4 available Pods, which contradicts the PDB. The minimum available during an update is `replicas − maxUnavailable` (`concepts/workloads/controllers/deployment.md:1190-1199`).

**Recommendation [C]:** `maxUnavailable: 0, maxSurge: 1`. maxSurge rounds up and can't be 0 when maxUnavailable is 0 (`deployment.md:1201-1211`). Terminating Pods don't count as available, so a rollout can briefly use more resources than `replicas + maxSurge` (`deployment.md:327-332`). Plan cluster capacity for that.

### 2. How should replicas be spread across zones?
Use `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1`, and a `labelSelector` that matches the Deployment.
- **topologyKey:** each value of this node label is one domain (`reference/kubernetes-api/workload-resources/pod-v1.md:226-228`).
- **maxSkew with `DoNotSchedule` (the default):** the largest allowed difference from the global minimum across eligible domains (`concepts/scheduling-eviction/topology-spread-constraints.md:83-93`; `pod-v1.md:230-232`).
- **`ScheduleAnyway`:** the Pod always gets scheduled, with a preference for less-loaded domains. That preference is weighed together with other scoring (`topology-spread-constraints.md:350-354`).
- **[N] Zone unavailable:** the docs don't describe this case directly. Under `DoNotSchedule`, a Pod that would break the skew is not scheduled. Domains are found from existing nodes only, so a zone with no nodes isn't counted (`topology-spread-constraints.md:613-619`).
- **[G] Removals:** constraints aren't re-checked when Pods are removed, so a scale-down can leave zones uneven (`topology-spread-constraints.md:607-608`).

**Recommendation:** use `DoNotSchedule` for zones, plus a `ScheduleAnyway` constraint on hostname.

### 3. Which probes fit a slow startup?
- **Startup probe:** set `failureThreshold × periodSeconds` to cover the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `concepts/workloads/pods/pod-lifecycle.md:544-557`). **[G]** All other probes are disabled until the startup probe succeeds. If it fails, the container is killed and its restart policy applies (`pod-lifecycle.md:494-498`).
- **Readiness probe:** **[G]** a failure removes the Pod IP from Service endpoints. This is when traffic stops; the container is not restarted (`pod-lifecycle.md:486-491`).
- **Liveness probe:** **[G]** a failure kills the container and restarts it (`pod-lifecycle.md:480-484`).
- **[C]** Keep liveness checks local to the container. **[N]** The docs don't say whether a readiness check should depend on the database.

### 4. What happens during termination, and is 30 seconds enough?
The order is:
1. The Pod is marked Terminating and the grace-period clock starts (`pod-lifecycle.md:584-590`).
2. `preStop` runs. If it is still running when the grace period ends, the kubelet adds a single 2-second extension (`pod-lifecycle.md:592-602`).
3. SIGTERM is sent, in arbitrary order across containers (`pod-lifecycle.md:604-610`).
4. SIGKILL is sent when the grace period expires (`pod-lifecycle.md:572-578`).

**[G]** `preStop` time counts against the same grace period.

**Endpoints:** in parallel, endpoints are marked terminating with `ready=false`, so load balancers stop sending regular traffic. The `serving` condition is there for draining (`pod-lifecycle.md:612-634`).

**[N]** 30 seconds is only the default (`pod-lifecycle.md:597`). Nothing guarantees long requests finish in that time. Set `terminationGracePeriodSeconds` to at least preStop time plus the longest request plus a margin. Also bound request duration in the application.

### 5. How do CPU and memory requests and limits interact with the HPA?
- **[G] CPU limits** are enforced by throttling (`concepts/configuration/manage-resources-containers.md:43-47`).
- **[G] Memory limits** are enforced by OOM kills, reactively and under memory pressure (`manage-resources-containers.md:49-55`).
- **[G] Limit without a request:** the request is set equal to the limit (`manage-resources-containers.md:63-67`).
- **[G] No memory limit:** the container can use all node memory, and is more likely to be killed in an OOM (`tasks/configure-pod-container/assign-memory-resource.md:304-310`).
- **[G] HPA:** utilization is measured against requests. If any container lacks a CPU request, utilization is undefined and the HPA takes no action (`tasks/run-application/horizontal-pod-autoscale.md:89-102`).

**[C]** Set CPU requests on every container. Size memory limits from measured usage.

### 6. How does the HPA handle missing metrics and Pods that aren't ready?
- **Missing metrics:** for a scale-down they are treated as 100% of target, and for a scale-up as 0% (`horizontal-pod-autoscale.md:183-186`).
- **Not-yet-ready Pods:** treated as 0% on scale-up. If the adjusted ratio reverses direction or falls within tolerance, the HPA doesn't scale (`horizontal-pod-autoscale.md:188-197`).
- **Readiness windows:** the defaults are 30 seconds (initial readiness delay) and 5 minutes (CPU initialization period) (`horizontal-pod-autoscale.md:167-178`). These matter for a slow-starting app.
- **Stabilization:** **[G]** the downscale window defaults to 300 seconds; scale-up has no window. Rate policies cap changes per 15 seconds (`horizontal-pod-autoscale.md:455-487`).

Actual scaling can therefore differ from the raw ratio. **[P]** A metrics API, usually Metrics Server, has to be deployed (`horizontal-pod-autoscale.md:114-117`). **[C]** Set `minReplicas ≥ 6` so the HPA doesn't undercut the PDB and zone-spread intent.

### 7. How do we replace default-allow networking with least privilege?
- **[G] Isolation:** Pods are non-isolated in both directions by default. A policy whose `policyTypes` lists Ingress or Egress isolates the selected Pods in that direction. Policies are additive, and reply traffic is allowed (`concepts/services-networking/network-policies.md:51-77`).
- **[G] Both ends:** a connection needs egress allowed at the source and ingress allowed at the destination (`network-policies.md:79-81`).
- **Plan:** a namespace default-deny for ingress and egress (`network-policies.md:254-262`), then allow-lists for ingress from the Service's clients and egress to the database port.
- **[P] CNI support:** policies need a network plugin that supports them. Without one, a NetworkPolicy "will have no effect" (`network-policies.md:45-49`). Only TCP, UDP and SCTP are guaranteed to be filtered (`network-policies.md:264-279`).
- **[N] DNS:** the network-policy page doesn't describe DNS egress (an exact search found no match). Once egress is denied, add an explicit DNS egress rule and test it. DNS lookups work across all namespaces by default (`concepts/security/multi-tenancy.md:376-388`).

### 8. Is base64 encoding enough protection for Secrets?
No. **[G]** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read or change them. Anyone who can create Pods, or Deployments, in a namespace can read every Secret in it (`concepts/configuration/secret.md:35-40`).

Required steps (`secret.md:42-48`):
- Enable encryption at rest.
- Give least-privilege RBAC on Secrets, including on Pod and workload creation.
- Limit Secret access to the specific containers that need it.
- Consider an external secret store.

Etcd client certificates grant full access (`concepts/security/api-server-bypass-risks.md:93-116`). **[C]** Remove plaintext-equivalent Secrets from Git.

### 9. What does changing the StorageClass reclaim policy do to existing PVs?
- **[G]** Dynamically provisioned PVs take the class's `reclaimPolicy` when they are created. The default is `Delete` (`concepts/storage/storage-classes.md:126-135`). After creation, a PV has to be edited or patched (`concepts/storage/persistent-volumes.md:201-210`). Changing the class therefore doesn't change existing PVs. **[N]** The linked task page for changing a PV's policy isn't in this corpus.
- **Delete:** removes both the PV and the external storage asset (`persistent-volumes.md:201-205`).
- **Retain:** the PV becomes "released" and needs manual cleanup (`persistent-volumes.md:185-199`).
- **PVC deletion vs. StatefulSet deletion or scaling:** reclaim applies when a PVC is deleted. **[G]** Deleting or scaling down a StatefulSet doesn't delete its volumes by default (`concepts/workloads/controllers/statefulset.md:47-64`). The opt-in `persistentVolumeClaimRetentionPolicy` controls this; it defaults to `Retain` for both `whenDeleted` and `whenScaled` and needs a feature gate (`statefulset.md:387-430`). Even then, deleting a PVC triggers the PV's reclaim policy.

**[C]** Use Retain for database volumes.

### 10. Prioritized rollout and validation checklist
1. Fix the rollout: `maxSurge: 1, maxUnavailable: 0`. Keep the PDB, add `AlwaysAllow`, and test a drain.
2. Add CPU requests and measured memory limits. Check that HPA status shows utilization and that `minReplicas ≥ 6`.
3. Add startup, readiness and liveness probes. Measure worst-case startup.
4. Size the grace period and preStop. Load-test long requests during a rollout and watch for dropped requests.
5. Add zone spread. Test a drain and a node pool scaled to zero.
6. Confirm the CNI enforces NetworkPolicy. Apply default-deny plus allow-lists including DNS, and test both directions.
7. Enable encryption at rest, tighten RBAC and remove Secrets from Git.
8. Patch existing PVs to Retain and back up the database.

**Limits these docs don't guarantee:**
- Zone-outage capacity, since involuntary loss bypasses the PDB.
- Whether long requests finish within the grace period.
- That the CNI actually enforces policies and DNS egress.
- How the database behaves on reconnects and failover.
- Metrics Server availability.
- Whether the provisioner supports Delete or Retain.