# Decision memo: production review of the six-replica API Deployment (Kubernetes v1.32 docs only)

**Verdict:** Do not approve the design as proposed. Three parts conflict with what the docs state: the PDB and rollout settings work against each other, base64 Secrets are not protected, and default-allow networking gives no isolation. Several other limits must be tested on the real cluster. Below, each answer is labelled as one of four kinds: **[G]** the docs guarantee it, **[C]** it is a configuration choice, **[P]** it depends on a prerequisite, **[N]** the docs do not establish it. All paths are relative to `docs/`.

---

### 1. Does the PDB guarantee five available replicas?

No, not in any of the three cases.

- **Node failure:** **[G]** The docs say "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:132-133`). Losing a node, or a whole zone holding two Pods, can take the service below 5.
- **Node drain:** **[P]** The PDB only limits voluntary disruptions that go through the Eviction API. `kubectl drain` uses that API and retries rejected evictions until it succeeds or times out (`disruptions.md:100-117`). Tools that delete Pods directly bypass the PDB. With 6 replicas and `minAvailable: 5`, one eviction is allowed at a time (`disruptions.md:119-122`). By default, a drain waits for unhealthy Pods to become healthy. The docs recommend the `AlwaysAllow` unhealthy-pod eviction policy (`disruptions.md:139-142`).
- **Rolling update:** **[G]** Deployments "are not limited by PDBs when doing rolling upgrades", although Pods made unavailable by the update still count against the budget (`disruptions.md:135-138`). `maxUnavailable: 2` allows the update to drop to 4 available Pods (`concepts/workloads/controllers/deployment.md:1191-1199`). That breaks the five-replica target. It also uses up the budget, so drains started during the rollout are blocked.

**Recommendation [C]:** set `maxUnavailable: 0` and `maxSurge: 1`. `maxUnavailable` may be 0 only when `maxSurge` is not 0 (`deployment.md:1194-1195`). This needs spare capacity for one extra Pod. Also review `minAvailable` when the HPA changes the replica count. The "intended" count comes from `.spec.replicas` (`disruptions.md:127-129`).

### 2. Zone spreading

- `topologyKey` names a node label. Nodes with the same value for that label form one domain. `maxSkew` must be greater than 0 (`concepts/scheduling-eviction/topology-spread-constraints.md:83-90, 115-119`).
- `DoNotSchedule` is the default. With it, `maxSkew` is a hard limit on the difference from the global minimum, and a Pod that would break it stays unscheduled. `ScheduleAnyway` only prefers domains that reduce skew (`topology-spread-constraints.md:85-95, 123-126`), and that preference is weighed together with other scoring (`:349-354`).
- **Recommendation [C]:** use `topology.kubernetes.io/zone` with `maxSkew: 1` and `DoNotSchedule` (with `minDomains: 3` if you want it). Optionally add a node-level `ScheduleAnyway` constraint. Constraints are ANDed (`topology-spread-constraints.md:382-388`).
- **When a zone is unavailable [N]:** constraints are not guaranteed to hold after Pods are removed. The scheduler only knows about zones that currently have nodes, so a zone scaled to zero nodes is ignored until it has a node again (`topology-spread-constraints.md:605-623`). The docs do not establish that `DoNotSchedule` will place replacement Pods while a zone is down. Test this case.

### 3. Probes for slow startup

- **[G]** When a startup probe is defined, all other probes are disabled until it succeeds. If it fails, the kubelet kills the container, which then follows the restart policy (`concepts/workloads/pods/pod-lifecycle.md:494-499`).
- **[G]** A failing readiness probe removes the Pod's IP from the endpoints of matching Services. Before the initial delay, readiness defaults to `Failure` (`pod-lifecycle.md:486-491`). A failing liveness probe kills and restarts the container (`pod-lifecycle.md:480-484`).
- **[C]** Set the startup probe to check the same endpoint as liveness, with `failureThreshold × periodSeconds` covering the worst-case startup time. The docs' example gives 30 × 10 s = 300 s. After that, liveness takes over (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `pod-lifecycle.md:544-557`).
- Add a separate readiness probe for whether the Pod should receive traffic. **[N]** The right thresholds for this application are not in the docs.

### 4. Termination order and the 30-second grace period

1. The Pod is marked Terminating. The kubelet runs `preStop`, and that time is counted inside `terminationGracePeriodSeconds` (default 30 s). If the hook is still running when the period ends, the kubelet adds one extra 2 s. If the hook needs longer, you must raise the grace period (`pod-lifecycle.md:584-602`).
2. SIGTERM is sent to PID 1 in each container, in arbitrary order unless sidecars are used (`pod-lifecycle.md:604-610`).
3. In parallel, the endpoints stay in the EndpointSlice with `ready: false` and a terminating status. Load balancers stop sending regular traffic, and the `serving` condition exposes actual readiness for draining (`pod-lifecycle.md:612-631`).
4. When the period expires, SIGKILL goes to any process still running (`pod-lifecycle.md:635-640`).

**[N]** 30 s is not guaranteed to finish long requests. Size the period to the longest request plus `preStop` time, and verify it. Eviction during a drain respects this period (`disruptions.md:143-145`).

### 5. Resources

- **[G]** Containers may use more than their request when the node has spare capacity. CPU limits are enforced by throttling and are a hard ceiling. Memory limits are enforced reactively by OOM kills under memory pressure (`concepts/configuration/manage-resources-containers.md:27-54`). If only a limit is set, it is copied into the request (`:62-66`).
- **[G]** CPU limits throttle usage and "can have unintended effects on auto-scaling". A memory limit above the request can expose the whole node to OOM (`concepts/security/security-checklist.md:142-152`).
- **[G]** If any container lacks a CPU request, CPU utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:99-102`).
- **[C]** Set CPU requests on every container, and set memory request equal to the memory limit. Whether to set a CPU limit is a choice, made with the throttling effect on scaling in mind.

### 6. HPA behavior

- **[G]** Pods being deleted are ignored, and failed Pods are discarded. Pods with missing metrics, and not-yet-ready Pods when scaling on CPU, are set aside (`horizontal-pod-autoscale.md:153-165`). The ready-time detection uses a 30 s initial-readiness delay and a 5-minute CPU initialization period (`:167-178`).
- **[G]** For missing metrics, the HPA assumes 100% of target when scaling down and 0% when scaling up. Not-yet-ready Pods are assumed to use 0%, which dampens scale-up. If the recomputed ratio reverses direction or falls within the tolerance (0.1 by default), nothing happens (`:146-148, 183-198`).
- **[G]** The default downscale stabilization window is 300 s. Scale-up has no window and is limited to 4 Pods or 100% every 15 s (`:455-485`).
- Slow startup therefore makes scale-up conservative and delayed. **[N]** Whether reaction time is adequate is not established.

### 7. Least-privilege networking

- **[G]** By default a Pod is non-isolated in both directions. A Pod becomes isolated for a direction once any policy that selects it lists that direction in `policyTypes`. Allow lists combine additively, and reply traffic is implicitly allowed (`concepts/services-networking/network-policies.md:51-73`).
- **[G]** Policies do not conflict; the result is their union. A connection needs both the source Pod's egress and the destination Pod's ingress to allow it (`:75-81`). An allow-all policy cannot be narrowed by adding other policies (`:224-232, 244-252`).
- **[P]** Policies need a network plugin that supports NetworkPolicy. Without one, they have no effect (`:45-49`).
- **[C]** Start with default-deny for ingress and egress. Then allow Service clients to reach the API, the API to reach the database (egress on the API, ingress on the database), and DNS egress.
- **[N]** I found no DNS example in the policy page. The need to allow DNS follows from egress isolation and must be tested.

### 8. Secrets

- **[G]** base64 is not protection. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them. Anyone who can create a Pod, or indirectly a Deployment, in a namespace can read every Secret in that namespace (`concepts/configuration/secret.md:36-41`).
- The docs' minimum steps are encryption at rest, least-privilege RBAC, restricting access to specific containers, and considering an external store (`secret.md:43-49`).
- **[G]** Permission to create workloads also implicitly grants every ServiceAccount's API access in that namespace (`concepts/security/rbac-good-practices.md:100-108`).
- **[C]** Do not keep plaintext-equivalent base64 Secrets in Git.

### 9. Storage reclaim policy

- **[G]** Dynamically provisioned PVs take the StorageClass `reclaimPolicy` (default `Delete`) at creation (`concepts/storage/storage-classes.md:126-135`). The docs say that otherwise "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`).
- **[N]** By implication, changing the class does not change existing PVs; patch those PVs individually. I found no explicit statement either way.
- **[G]** `Delete` removes both the PV and the external storage asset. `Retain` keeps a "released" PV and requires manual cleanup (`persistent-volumes.md:185-210`).
- **[G]** Deleting a PVC triggers the PV's reclaim policy. For StatefulSets, `persistentVolumeClaimRetentionPolicy` (default `Retain`) controls PVC deletion only on StatefulSet deletion or scale-down, not on Pod replacement after node failure (`concepts/workloads/controllers/statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-143`).
- **[C]** Use `Retain` for database data.

### 10. Prioritized checklist

1. Enable Secret encryption at rest, tighten RBAC (including who can create workloads), and remove Secrets from Git (Q8).
2. Confirm the CNI enforces NetworkPolicy, apply default-deny, then add allows for clients, the database and DNS (Q7).
3. Set `maxUnavailable: 0` and `maxSurge: 1`, and set the PDB unhealthy-pod eviction policy to `AlwaysAllow` (Q1).
4. Add a zone spread constraint with `DoNotSchedule` (Q2).
5. Add startup, readiness and liveness probes; size `preStop` and the grace period to the longest request (Q3–4).
6. Set CPU and memory requests; review the CPU limit (Q5).
7. Patch existing PVs to `Retain` and verify (Q9).
8. Test a drain, a rolling update, a simulated zone loss and an HPA load test.

**Limits that still need application or cluster validation [N]:**
- The service can stay above five available replicas through a zone or node failure (Q1).
- Replacement Pods can be scheduled with `DoNotSchedule` while a zone is down, and an autoscaled zone with zero nodes is handled (Q2).
- Long requests finish within the grace period, including how the load balancer handles terminating endpoints (Q4).
- The HPA reacts fast enough given slow startup and the stabilization window (Q6).
- The CNI enforces NetworkPolicy, and DNS works after default-deny (Q7).
- Cluster capacity is enough for surge Pods (Q1).