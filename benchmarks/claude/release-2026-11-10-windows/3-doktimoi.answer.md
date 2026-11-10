# Decision memo: API Deployment design review (Kubernetes v1.32 docs)

**Verdict: do not approve the design as written.** Three parts conflict with what the docs say: `minAvailable: 5` combined with `maxUnavailable: 2`, base64 Secrets kept in Git, and default-allow networking. Other parts, such as the 30-second grace period and the storage reclaim policy, depend on settings or on validation the docs don't cover.

All paths are relative to the `docs/` folder. Labels used below: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by the docs.

---

**1. Does the PDB guarantee five available replicas?** No, in none of the three cases.
- **Node failure:** PDBs cannot prevent involuntary disruptions, though those disruptions still count against the budget [G] (`concepts/workloads/pods/disruptions.md:136-138`). If a node fails while the app is at its minimum, availability can drop below the budget (`tasks/run-application/configure-pdb.md:150-157`).
- **Drain:** Drain uses the Eviction API, which respects the PDB. With 6 replicas and minAvailable 5, it allows one eviction at a time, and `kubectl drain` retries rejected evictions [G] (`disruptions.md:108-125`). Setting minAvailable equal to the replica count would block drain forever (`configure-pdb.md:159-163`). The docs recommend the `AlwaysAllow` unhealthy-pod eviction policy [C] (`disruptions.md:140-143`).
- **Rolling update:** Deployments "are not limited by PDBs when doing rolling upgrades" [G] (`disruptions.md:140-143`). So `maxUnavailable: 2` takes the Deployment down to 4 available Pods.
- **Recommendation:** use `maxUnavailable: 0` with `maxSurge: 1` (or 25%). Both fields cannot be 0 at the same time (`concepts/workloads/controllers/deployment.md:1191-1205`). Prefer a PDB `maxUnavailable: 1`, because it adjusts automatically when the replica count changes (`configure-pdb.md:174-176`). This matters because HPA changes the replica count.

**2. How should replicas spread across zones?**
- Use `topologyKey: topology.kubernetes.io/zone` and `maxSkew: 1`. `maxSkew` is the largest allowed difference from the global minimum (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`). `topologyKey` names the node label that defines a domain (`:118-122`).
- `DoNotSchedule` (the default) leaves a Pod unscheduled rather than break the skew. `ScheduleAnyway` only prefers placements that reduce skew (`:124-126`), and that preference is weighed together with other scheduling priorities (`:350-354`).
- **If a zone is unavailable [N/limit]:** the docs don't promise rebalancing after Pods are removed (`:607-610`). Domains are discovered from existing nodes, so a zone scaled to zero nodes is not counted (`:613-619`).
  - With `DoNotSchedule`, Pods that would worsen skew may stay Pending.
  - `minDomains` can force the global minimum to 0 when fewer domains exist than required (`:106-114`).
  - Choose based on priority: `DoNotSchedule` for strict spread, `ScheduleAnyway` for capacity during an outage.

**3. Which probes fit slow startup?**
- Add a `startupProbe` whose `failureThreshold × periodSeconds` covers the worst-case startup time. The docs' example of 30 × 10s gives 300s. If the probe never succeeds, the container is killed and its restart policy applies (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- All other probes stay disabled until the startup probe succeeds (`concepts/workloads/pods/pod-lifecycle.md:494-498`). Liveness and readiness `initialDelaySeconds` only start counting after that (`configure-liveness-readiness-startup-probes.md:398-402`).
- **Traffic stops** when readiness fails `failureThreshold` times in a row: the Pod's IP is removed from Service endpoints and the container keeps running (`pod-lifecycle.md:486-490`; `configure-...probes.md:416-423`).
- **A restart happens** when liveness fails (`pod-lifecycle.md:481-484`).
- Keep the liveness check fast. Don't let liveness depend on the database, or a database outage could restart every replica. This last point is design judgment [N].

**4. What is the termination order, and is 30 seconds enough?**
1. The Pod is marked Terminating and the grace-period clock starts (`pod-lifecycle.md:584-589`).
2. `preStop` runs. If it is still running when the grace period ends, the kubelet adds a one-off 2 seconds (`:591-601`).
3. SIGTERM goes to PID 1 of each container (`:603-604`).
4. At the same time, the Pod's EndpointSlice entries show `terminating`, with `ready=false`, while `serving` reflects real readiness (`:612-632`).
5. When the grace period expires, SIGKILL is sent (`:636-640`).

`preStop` runs inside the grace period, not in addition to it (`:598-601`). **30 seconds is not guaranteed to finish requests [N].** The docs only say to raise the value if needed. Set `terminationGracePeriodSeconds` to at least preStop time + longest request + margin, and confirm it under load.

**5. CPU and memory requests and limits**
- **CPU limit:** enforced by throttling, as a hard cap. **Memory limit:** enforced reactively by OOM kills under memory pressure (`concepts/configuration/manage-resources-containers.md:40-55`).
- If only a limit is set, the limit is copied into the request (`:63-67`).
- HPA computes utilization as a percentage of the request. If any container lacks a CPU request, utilization is undefined and **the HPA takes no action** for that metric [G] (`tasks/run-application/horizontal-pod-autoscale.md:89-102`).
- **Recommendation:** set CPU requests on every container. CPU throttling during startup can slow a slow-starting app further, so check this against the startup probe budget [N].

**6. HPA with missing metrics and not-yet-ready Pods**
- **Missing metrics:** HPA assumes 100% of target on scale-down and 0% on scale-up.
- **Not-yet-ready Pods:** treated as 0% on scale-up. The defaults are `initial-readiness-delay` 30s and `cpu-initialization-period` 5 min.
- If the recalculated ratio reverses direction or falls within tolerance, nothing happens. Status still shows the raw average (`horizontal-pod-autoscale.md:167-202`).
- **Default downscale window:** 300s. Scale-up has no stabilization window and is limited to the larger of 100% or 4 Pods per 15s (`:455-486`).
- The Metrics Server must be deployed separately [P] (`:114-118`).

**7. Least-privilege networking**
- **Isolation:** Pods are non-isolated by default. A Pod becomes isolated in a direction once any policy that selects it lists that direction in `policyTypes`. Policies are additive (their union applies), reply traffic is allowed implicitly, and a connection needs both the source's egress and the destination's ingress to allow it (`concepts/services-networking/network-policies.md:51-81`).
- **Plan:**
  1. Default-deny ingress and egress per namespace (`:234-242`).
  2. Allow ingress to the API only from its clients.
  3. Allow egress only to the database port; the database side also needs an ingress allow.
  4. Allow egress to DNS.
- **[N]:** I found no DNS-specific guidance in the policy doc. The need to allow DNS follows from egress isolation, so test name resolution.
- **[P] CNI:** a policy without a controller that implements it has no effect (`:45-49`). Support for `endPort` also varies by plugin (`:302-307`).

**8. Is base64 enough for Secrets?** No.
- Secrets are stored unencrypted in etcd by default, and anyone with API or etcd access can read them.
- Anyone who can create a Pod, or indirectly a Deployment, in the namespace can read every Secret there.
- Required steps: encryption at rest, least-privilege RBAC, limiting Secret access to specific containers, and considering an external secret store (`concepts/configuration/secret.md:35-52`).
- The built-in `edit` role grants Secret access and lets a user run as any ServiceAccount. The `view` role excludes Secrets because of this escalation (`reference/access-authn-authz/rbac.md:667-684`).
- Remove the base64 Secrets from Git. The fact that base64 is encoding and not protection follows from that caution [G]. How to replace them in Git (sealed or external secrets) is a choice the docs don't cover [N].

**9. Reclaim policy and storage**
- Dynamically provisioned PVs take the StorageClass `reclaimPolicy` at creation, and it defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
- If the class isn't set right, each PV "must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). This implies a class change doesn't affect existing PVs. The docs don't state that directly [N]. Audit and patch existing PVs.
- **Delete:** removes the PV and the backing storage asset (`:201-206`).
- **Retain:** the PV becomes Released and needs manual cleanup and reclaim (`:185-199`).
- **PVC deletion vs. StatefulSet deletion/scaling:** deleting a PVC triggers the reclaim policy. Deleting or scaling down a StatefulSet does *not* delete its volumes (`concepts/workloads/controllers/statefulset.md:52`).
- `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`) applies only to StatefulSet deletion and scale-down, not to Pod replacement after node failure (`statefulset.md:387-436`).
- Use `Retain` for the database data.

**10. Prioritized rollout and validation checklist**
1. Rotate the Secrets, remove them from Git, enable encryption at rest, and tighten RBAC for Pod creation (Q8).
2. Set CPU and memory requests and limits, confirm the Metrics Server is running, then enable HPA (Q5, Q6).
3. Add a startup probe sized to p100 startup time, plus readiness and liveness probes (Q3).
4. Set the rollout to `maxUnavailable: 0, maxSurge: 1`, the PDB to `maxUnavailable: 1` with `AlwaysAllow`, and add zone spread constraints (Q1, Q2).
5. Add preStop and a grace period sized to the longest request (Q4).
6. Confirm the CNI enforces NetworkPolicy, then apply default-deny plus allows for clients, the database and DNS (Q7).
7. Set `reclaimPolicy: Retain` and audit existing PVs (Q9).
8. Rehearse a drain, a rollout, a zone-loss game day and a load test.

**Limits that still need validation, not guaranteed by these docs:**
- Request completion within the grace period (Q4).
- Behavior when a zone or capacity is lost: Pending Pods, no rebalancing (`topology-spread-constraints.md:605-619`).
- Whether the CNI actually enforces the policies (`network-policies.md:45-49`).
- HPA reaction time with slow-starting Pods (`horizontal-pod-autoscale.md:167-202`).
- Database connection limits and failover behavior, which no document here covers.