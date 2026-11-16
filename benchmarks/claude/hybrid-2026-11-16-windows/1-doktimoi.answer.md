# Decision memo: production API on Kubernetes v1.32

**Status:** Not approved as proposed. Five parts of the design are unsafe as written: the rollout settings, the 30-second grace period, default-allow networking, Secrets in Git, and storage that may default to `Delete`. All paths below are relative to `docs/`.

---

**1. Does the PDB keep five replicas available?**

No. The PDB only partly protects the API, and the rollout settings conflict with it.

- **Node failure.** This is an involuntary disruption. "Involuntary disruptions … cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:92-145`). If a node or zone holding two Pods fails, the API drops to four replicas.
- **Node drain.** A drain uses the Eviction API, which respects the PDB. Evictions may be temporarily rejected and are retried (`disruptions.md:92-145`). With six replicas and `minAvailable: 5`, only one Pod can be evicted at a time. The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy; by default a drain waits for Pods to become healthy (`disruptions.md:133-145`). A PDB is also only best effort during scheduler preemption (`concepts/scheduling-eviction/pod-priority-preemption.md:230-238`).
- **Rolling update.** A Deployment's rolling update is not limited by the PDB, although the Pods it takes down do count against the budget (`disruptions.md:133-145`). With `maxUnavailable: 2`, the rollout can go down to four available Pods and block drains while it runs (`concepts/workloads/controllers/deployment.md:1183-1199`).

**Recommendation:** use `maxUnavailable: 0` and `maxSurge: 1`. This is allowed because only one of the two fields is zero (`deployment.md:1183-1199`, `1201-1310`). It keeps all six old Pods until each new Pod is Ready. The cluster needs spare capacity for one extra Pod.

**2. How should replicas be spread across zones?**

Use a `topologySpreadConstraints` entry with `topologyKey` set to the node label that identifies the zone, and `maxSkew: 1`.

- With `DoNotSchedule`, `maxSkew` is the largest allowed difference between a zone's Pod count and the global minimum.
- With `ScheduleAnyway`, the scheduler only prefers zones that reduce the skew (`concepts/scheduling-eviction/topology-spread-constraints.md:76-93`). That preference is weighed together with other scoring, and the Pod can always be scheduled (`:335-354`).
- **Trade-off:** `DoNotSchedule` keeps the spread strict but can leave Pods Pending. `ScheduleAnyway` keeps capacity but may concentrate Pods in fewer zones.

What happens when a zone is unavailable is only partly documented:

- The constraint is not guaranteed after Pods are removed, so the spread can become uneven.
- The scheduler learns which zones exist only from existing nodes, so a zone with zero nodes is not considered (`:605-630`).
- The docs do not say exactly how replacement Pods are placed during a zone outage. Test this.

**3. Which probes fit slow startup?**

Use a **startupProbe** on the same endpoint as liveness, with `failureThreshold × periodSeconds` longer than the worst-case startup time (`concepts/workloads/pods/pod-lifecycle.md:544-557`).

- **When the other probes begin:** liveness and readiness are disabled until the startup probe succeeds (`pod-lifecycle.md:474-500`; `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:2-41`).
- **When traffic stops:** whenever readiness fails, the Pod is removed from Service endpoints. Readiness runs for the container's whole lifecycle (`…probes.md:349-388`).
- **When the container restarts:** when liveness fails, or when the startup probe fails, the kubelet kills the container (`pod-lifecycle.md:474-500`).
- Use the same cheap endpoint for liveness and readiness, but give liveness a higher `failureThreshold`, so a Pod is not-ready for a while before it is killed (`…probes.md:2-41`).

**4. Does a 30-second grace period finish long requests?**

No, nothing in the docs guarantees that. The termination order is:

1. The Pod is marked Terminating and the grace-period clock is recorded.
2. The kubelet runs `preStop`. The grace period is 30 seconds by default and already covers `preStop`. If `preStop` is still running when it expires, the kubelet adds a one-time 2-second extension.
3. The kubelet sends TERM. The containers receive it in no guaranteed order.
4. When the grace period expires, the kubelet sends KILL (`pod-lifecycle.md:559-610`).

In parallel, the Pod's endpoints stay in EndpointSlices but are marked terminating with `ready=false`, while the `serving` condition still shows actual readiness (`pod-lifecycle.md:612-634`). Evictions honor `terminationGracePeriodSeconds` (`disruptions.md:133-145`). **Recommendation:** set the grace period to the longest request time plus the `preStop` time, and measure draining under load.

**5. CPU requests, limits, and HPA**

- A CPU limit is enforced by throttling.
- A memory limit is enforced by reactive OOM kills, so a container can briefly exceed it before being killed (`concepts/configuration/manage-resources-containers.md:27-67`).
- If a limit is set but no request, the limit is copied as the request (`:27-67`).
- Without a memory limit a container can use all node memory, and it is more likely to be OOM-killed (`tasks/configure-pod-container/assign-memory-resource.md:304-314`).
- **Effect on HPA:** if any container lacks a CPU request, Pod utilization is undefined and the HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:96-102`). Utilization means usage divided by the request, summed across containers (`:255-281`).

**6. HPA behavior**

- Pods with missing metrics are set aside, and so are CPU Pods that are not yet ready.
- The average is then recomputed conservatively: missing Pods count as 100% of the target on scale-down and 0% on scale-up. Not-yet-ready Pods count as 0% on scale-up.
- No scaling happens if the result is within the 0.1 tolerance or reverses direction. Pods being deleted are ignored.
- A Pod counts as not yet ready using a 30-second readiness delay and a 5-minute CPU initialization period. HPA status reports the original, unadjusted value (`horizontal-pod-autoscale.md:130-202`).
- The default scale-down stabilization window is 300 seconds. Scale-up has no window but is capped at 4 Pods or 100% per 15 seconds (`:455-497`).
- **Why scaling differs from the raw ratio:** these adjustments, plus slow startup that keeps new Pods not-ready longer.

**7. Least-privilege networking**

- **Ingress and egress isolation** are declared separately. A Pod becomes isolated once any policy that selects it lists that direction.
- **Policies are additive:** the allowed traffic is the union of all applicable policies.
- **Both ends of a connection** must allow it: egress on the source and ingress on the destination (`concepts/services-networking/network-policies.md:51-81`).
- **Plan:** a default-deny policy for each direction (`:214-222`), then explicit rules for traffic in from the Service's clients and out to the database.
- **DNS:** the retrieved docs do not say anything about DNS. My inference is that egress isolation would also block DNS lookups unless they are explicitly allowed; validate this.
- **CNI support:** policies have no effect without a network plugin that implements them (`:45-49`). Only TCP, UDP and SCTP are guaranteed (`:264-279`).

**8. Is base64 enough for Secrets?**

No. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and anyone who can create a Pod, or indirectly a Deployment, can read every Secret in that namespace. The required steps are encryption at rest, least-privilege RBAC, limiting Secret access to specific containers, and considering an external Secret store (`concepts/configuration/secret.md:34-55`; `concepts/security/security-checklist.md:245-275`).

Mounting Secrets as volumes is preferred over environment variables (`security-checklist.md:245-275`). The base64 step is only an encoding convenience (`tasks/inject-data-application/distribute-credentials-secure.md:84-94`). Remove the Secrets from Git.

**9. Storage reclaim policy**

- **Changing a StorageClass reclaim policy:** a dynamically provisioned PV takes the policy of its StorageClass, which defaults to `Delete`. To change an existing PV you must edit or patch it after creation (`concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:180-215`). This implies, but no passage states directly, that changing the class does not rewrite existing PVs.
- **Retain:** when the PVC is deleted, the PV becomes "Released" and its data remains, waiting for manual cleanup.
- **Delete:** deleting the PVC removes both the PV and the backing storage asset (`persistent-volumes.md:180-215`).
- **StatefulSet deletion or scaling:** this does not delete volumes by default. The optional `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`) needs the `StatefulSetAutoDeletePVC` feature gate. It does not apply to Pod replacement after node failure (`concepts/workloads/controllers/statefulset.md:387-463`).
- **PVC deletion:** depending on the reclaim policy, it can destroy the data (`tutorials/stateful-application/cassandra.md:240-250`). Use `Retain` for the database.

**10. Prioritized checklist**

1. Remove Secrets from Git. Enable encryption at rest and RBAC, including limits on who can create Pods (Q8).
2. Set the database PVs to `Retain` and patch existing PVs. Check any StatefulSet retention policy (Q9).
3. Confirm the CNI supports NetworkPolicy. Apply default-deny, then the allow rules, including DNS (Q7).
4. Set the rollout to `maxSurge: 1` / `maxUnavailable: 0`. Add `AlwaysAllow` to the PDB (Q1).
5. Add startup, readiness and liveness probes (Q3), then set `preStop` and a measured grace period (Q4).
6. Set CPU and memory requests on every container, plus a memory limit (Q5). Tune the HPA (Q6).
7. Add the zone spread constraint (Q2).
8. Test: drain a node, fail a zone, roll out under load, and verify the HPA scales.

**Limits that still need validation rather than being guaranteed by these documents:**
- Whether the 30-second grace period, or any chosen value, drains real long requests and load-balancer connections (Q4).
- Behavior during a zone outage, and spare capacity for surge and rescheduling (Q2).
- Whether the CNI enforces policies, and whether DNS egress works (Q7).
- Startup-time percentiles that the probe thresholds depend on (Q3).
- The database's own failover and consistency, which these docs do not cover.
- That five replicas survive involuntary failures, which no PDB can guarantee (Q1).