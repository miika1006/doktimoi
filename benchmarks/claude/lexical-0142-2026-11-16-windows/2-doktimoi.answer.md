# Decision memo: production readiness of the API Deployment (Kubernetes v1.32)

**Recommendation: the design is not ready to approve as proposed.** Three parts conflict with the documentation: the PDB and rollout settings, the default-allow networking, and the base64-only Secrets in Git. The other parts are reasonable, but they still need settings tuned to measured behavior. All paths below are relative to `docs/`. Each point is labeled as a **[Guarantee]** (documented behavior), a **[Config]** (a choice the team makes), a **[Prereq]** (something that must already be in place) or a **[Not established]** (the docs don't say).

## 1. PDB `minAvailable: 5`

- **Node failure:** **[Guarantee]** A node failure is an involuntary disruption. "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:21-65`, `:92-131`). If you lose one node, you can drop below five, and further evictions are then blocked.
- **Node drain:** **[Guarantee]** `kubectl drain` goes through the Eviction API, which respects the PDB. Evictions that would breach it are rejected and retried until a timeout (`disruptions.md:92-131`). With 6 replicas and minAvailable 5, only one Pod can be evicted at a time. **[Prereq]** This only holds if every tool that removes Pods uses eviction. Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:21-65`).
- **Rolling update:** **[Guarantee]** Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-145`). With `maxUnavailable: 2`, availability can fall to 4 of 6 (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommended rollout:** `maxUnavailable: 0` and `maxSurge: 1` (or 2). `maxSurge` can't be 0 when `maxUnavailable` is 0 (`deployment.md:1201-1310`). Also set a `minReadySeconds` so a new Pod has to stay ready for a while before it counts as available (`deployment.md:1323-1328`). Add `unhealthyPodEvictionPolicy: AlwaysAllow`, which the docs recommend so that misbehaving Pods don't block drains (`disruptions.md:133-145`).

## 2. Spreading replicas across zones

**[Config]** Set `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1`.

- `maxSkew` is the largest allowed difference between a zone's matching Pod count and the global minimum (`concepts/scheduling-eviction/topology-spread-constraints.md:76-126`).
- `DoNotSchedule`, the default, leaves the Pod Pending if the constraint can't be met. `ScheduleAnyway` still schedules it but prefers zones with lower skew (`:76-126`, `:262-354`).
- If you set `minDomains` and fewer eligible zones exist, the global minimum is treated as 0 (`:76-126`). That can keep replacement Pods Pending during a zone outage.
- **[Guarantee]** Zones are known only from nodes that currently exist. The constraint isn't re-enforced when Pods are removed, so a scale-down can leave zones unbalanced (`:605-623`).
- Without explicit constraints, the built-in default is a soft zone skew of 5 (`:532-578`). For this design that is too loose.

**Recommendation:** Use `ScheduleAnyway` at zone level, so a zone outage reduces balance rather than capacity. Use `DoNotSchedule` only if each zone has spare capacity. **[Not established]** How Pods redistribute during an actual zone outage has to be tested with a drill.

## 3. Probes for slow startup

**[Guarantee]** While a startup probe is configured, all other probes are disabled until it succeeds. A failed startup probe kills the container under its restart policy. A failed liveness probe also restarts the container. A failed readiness probe removes the Pod from all matching Service endpoints, so traffic stops but the container is not restarted. Readiness defaults to `Failure` before its initial delay (`concepts/workloads/pods/pod-lifecycle.md:474-500`; `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:2-41`).

**[Config]**
- **Startup probe:** give it a failure budget longer than the worst measured startup time.
- **Readiness probe:** have it check whether the Pod can serve, including whether it can reach the database.
- **Liveness probe:** make it a cheap check with a higher `failureThreshold`, limited to truly unrecoverable states such as a deadlock (`configure-...probes.md:2-41`). Don't make liveness depend on the database, or one database outage will restart every replica.

## 4. Termination and the 30-second grace period

**[Guarantee]** The order is:

1. The Pod is marked Terminating.
2. The `preStop` hook runs. The grace-period clock is already running: it starts before the hook executes (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`).
3. If `preStop` is still running when the period ends, the kubelet grants a one-off 2-second extension.
4. TERM is sent to each container, in arbitrary order (`pod-lifecycle.md:584-610`).
5. When the period expires, SIGKILL goes to any process still running (`pod-lifecycle.md:636-645`, `:559-582`).

While this happens, the Pod's endpoints stay in EndpointSlices, but with `ready: false` and a `serving` condition, so they get no new regular traffic (`pod-lifecycle.md:612-634`). With `externalTrafficPolicy: Local`, kube-proxy only sends traffic to terminating endpoints when all of a node's local endpoints are terminating (`reference/networking/virtual-ips.md:619-642`).

**30 seconds is not guaranteed to finish requests.** It is only the default (`pod-lifecycle.md:584-610`), and `preStop` time counts against it. **[Config]** Set `terminationGracePeriodSeconds` to at least the `preStop` delay plus the longest request plus a safety margin.

## 5. Requests, limits and HPA

**[Guarantee]**
- A CPU limit is enforced by throttling. A memory limit is enforced reactively by OOM kill, and only when the kernel detects memory pressure (`concepts/configuration/manage-resources-containers.md:27-67`).
- If you set a limit but no request, the request is copied from the limit (`:27-67`).
- CPU limits "can have unintended effects on auto-scaling" (`concepts/security/security-checklist.md:138-152`).
- If any container lacks a CPU request, the Pod's CPU utilization is undefined and **the HPA takes no action** for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-121`).

**[Config]** Set a CPU request on every container, including sidecars. Set a memory limit based on measured usage, and be cautious with CPU limits.

## 6. HPA behavior

**[Guarantee]**
- Pods that are being deleted are ignored and failed Pods are discarded.
- Pods with missing metrics, and Pods that aren't yet ready, are set aside first (`horizontal-pod-autoscale.md:129-165`).
- Missing metrics are then counted as 100% of target when scaling down and 0% when scaling up. Not-yet-ready Pods count as 0% on a scale-up.
- If this adjustment reverses the scaling direction or lands within the tolerance, no scaling happens. The status still reports the raw average (`:165-215`).
- The tolerance is 0.1 (`:129-165`; `reference/command-line-tools-reference/kube-controller-manager.md:508-562`).
- Default scale-down stabilization is 300 seconds, using the highest recommendation in that window. Scale-up has no stabilization window but is rate-limited by its policies (`horizontal-pod-autoscale.md:455-486`).

So the actual replica count can differ from the raw ratio. **[Note]** The 5-minute CPU initialization period interacts with slow startup (`kube-controller-manager.md:508-562`). **[Prereq]** A metrics API is needed, usually Metrics Server (`horizontal-pod-autoscale.md:89-121`).

## 7. Least-privilege networking

**[Guarantee]**
- Ingress isolation and egress isolation are separate. A Pod is isolated in a direction only when a policy that selects it lists that direction in `policyTypes`.
- Policies are additive: what's allowed is the union of all policies that apply.
- A connection needs both the source's egress and the destination's ingress to allow it (`concepts/services-networking/network-policies.md:51-81`).

**[Prereq]** NetworkPolicy needs a CNI plugin that supports it. Without one, the policy objects have no effect (`:45-49`).

**[Config]** Apply default-deny for both ingress and egress (`:214-262`), then add allow rules:
- from the ingress or client namespace to the API port
- from the API to the database port
- matching ingress on the database side

**DNS:** **[Not established]** The pages I retrieved don't describe DNS-specific rules. Inferred from `:214-262`: deny-all egress blocks all outbound connections, so name resolution needs an explicit egress allow, and this has to be tested.

## 8. Secrets

**base64 is not protection.** **[Guarantee]**
- Secrets are stored unencrypted in etcd by default.
- Anyone with API or etcd access can read them.
- Anyone who can create Pods, or indirectly Deployments, in a namespace can read every Secret in it (`concepts/configuration/secret.md:1-53`).
- base64-encoded values are "obscured but not secret" (`secret.md:240-307`).

**[Config]**
- Turn on encryption at rest and lock down the encryption config file (`tasks/administer-cluster/encrypt-data.md:415-446`; `tasks/administer-cluster/securing-a-cluster.md:251-265`).
- Use least-privilege RBAC.
- Treat permission to create workloads as Secret access, since it also grants the access of any ServiceAccount in the namespace (`concepts/security/rbac-good-practices.md:100-120`).
- Remove plaintext Secrets from Git, for example by using an external store (`secret.md:1-53`).

## 9. Storage reclaim policy

**[Guarantee]**
- Dynamically provisioned PVs take the StorageClass `reclaimPolicy` when they're created, and it defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
- To change an existing PV, you edit or patch the PV itself (`concepts/storage/persistent-volumes.md:201-210`). **[Inferred, not stated explicitly]** So changing the StorageClass doesn't change existing PVs.
- `Delete` removes both the PV and the backing storage asset (`:201-210`).
- `Retain` leaves the PV "Released" after the PVC is deleted, and the data has to be reclaimed manually (`:185-199`).
- A PVC that a Pod is still using isn't removed until it's no longer in use (`:123-176`).

**StatefulSet deletion and scaling are separate from PVC deletion:**
- By default, PVCs are kept when a StatefulSet is deleted or scaled down.
- `persistentVolumeClaimRetentionPolicy` can switch either case to `Delete`, behind the `StatefulSetAutoDeletePVC` feature gate.
- When a node fails and the Pod is replaced, the PVC is kept (`concepts/workloads/controllers/statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`).

**[Config]** Use `Retain` for database volumes, and patch the PVs that already exist.

## 10. Prioritized checklist

1. Move Secrets out of Git, enable encryption at rest, and tighten RBAC, including who can create workloads.
2. Confirm the CNI supports NetworkPolicy, apply default-deny, and add the allow rules, including database and DNS egress.
3. Set `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds`, and `AlwaysAllow` for unhealthy Pod eviction.
4. Set the reclaim policy to `Retain` on the StorageClass and patch existing PVs.
5. Add CPU requests to all containers and confirm Metrics Server is running.
6. Add the startup, readiness and liveness probes, the `preStop` hook, and a longer grace period.
7. Add zone topology spread constraints.
8. Validate:
   - a drain while a rollout is running
   - a zone-loss drill
   - load-driven HPA scaling, checking both scale-up and the 300-second scale-down
   - a long request during termination

**Not guaranteed by these docs, so it still needs validation:**
- **(a)** Whether the longest request finishes within the chosen grace period, and whether clients or load balancers stop sending traffic in time.
- **(b)** The real startup duration, and whether readiness reflects database health without causing cascading failures.
- **(c)** Whether there's enough capacity per zone for surge Pods and for failover.
- **(d)** Whether all disruption tools in the cluster use the Eviction API.
- **(e)** CNI enforcement and the DNS egress rules.
- **(f)** The database's own durability and failover. The docs only cover what happens to the PV object.