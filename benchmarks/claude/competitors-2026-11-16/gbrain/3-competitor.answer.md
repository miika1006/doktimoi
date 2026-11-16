# Decision memo: production review of the API Deployment (Kubernetes v1.32 docs)

**Verdict: do not approve as proposed.** Five parts of the design rest on things the docs do not promise: `minAvailable: 5` together with `maxUnavailable: 2`, a fixed 30-second grace period for long requests, default-allow networking, base64 Secrets in Git, and the default `Delete` reclaim policy. All paths below are relative to `docs/`.

Labels: **[G]** documented guarantee · **[C]** configuration choice · **[P]** prerequisite · **[N]** not established by these docs.

---

### 1. Does the PDB keep five replicas available?
With 6 healthy replicas and `minAvailable: 5`, exactly one voluntary disruption is allowed at a time (`concepts/workloads/pods/disruptions.md:118-121`).

- **Node failure:** not protected. **[G]** "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`disruptions.md:26-34`, `130-131`). Losing a zone loses about two Pods, which takes you below 5.
- **Node drain:** protected, as long as the drain uses the Eviction API. `kubectl drain` retries rejected evictions (`disruptions.md:107-116`). Because startup is slow, each drain blocks until the replacement Pod is Ready (`disruptions.md:195-197`). A Pod counts as healthy only when it is `Ready` (`tasks/run-application/configure-pdb.md:236-240`). The default `IfHealthyBudget` policy can stall a drain behind Pods that never become Ready; `AlwaysAllow` is the documented recommendation (`configure-pdb.md:242-274`, `disruptions.md:138-141`). Directly deleting Pods or Deployments bypasses the PDB (`disruptions.md:62-65`).
- **Rolling update:** not protected. **[G]** Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can drop to 4 (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommendation [C]:** set `maxUnavailable: 0` and `maxSurge: 1`. The two fields cannot both be 0 (`deployment.md:1194`, `1201-1206`). Add `unhealthyPodEvictionPolicy: AlwaysAllow`. Under HPA the replica count changes, so check that `minAvailable` still leaves room for at least one disruption at `minReplicas` (`disruptions.md:126-128`).

### 2. Spreading across zones
Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1` (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`, `117-122`, `206-209`). Add `matchLabelKeys: [pod-template-hash]` so that each rollout revision is counted on its own (`:134-160`).

- `DoNotSchedule` is the default. It leaves a Pod Pending rather than exceed the skew. `ScheduleAnyway` schedules the Pod anyway and only prefers placements that reduce skew (`:124-126`).
- `minDomains` only works with `DoNotSchedule` (`:95-115`).
- **[N]** The docs give no guarantee that the spread survives losing a zone. The constraints may not stay satisfied after Pods are removed. Zones are discovered only from nodes that exist, so a zone scaled to zero nodes is invisible to the scheduler (`:605-619`).
- **Trade-off:** if a zone is down, `DoNotSchedule` with `maxSkew: 1` can leave replacement Pods Pending, while `ScheduleAnyway` restores capacity at the cost of skew. Pick deliberately; I'd choose `ScheduleAnyway`, or `DoNotSchedule` with spare capacity in each zone.

### 3. Probes for slow startup
- **[G]** If a startup probe is set, it disables the other probes until it succeeds. If it fails, the container is killed (`concepts/workloads/pods/pod-lifecycle.md:492-497`; `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:31-35`).
- **Startup probe [C]:** check the same endpoint as the liveness probe. Set `failureThreshold × periodSeconds` above the worst-case startup time. `periodSeconds` defaults to 10s. Leave the liveness defaults unchanged (`pod-lifecycle.md:544-557`).
- **Readiness probe:** traffic stops when it fails, because the Pod's IP is removed from Service endpoints (`:485-490`, `probes.md:23-29`). Let readiness check database reachability, but not liveness (`pod-lifecycle.md:524-528`).
- **Liveness probe:** the container restarts when it fails (`:479-483`). It should detect only unrecoverable states such as a deadlock; otherwise it can cause cascading restarts under load (`probes.md:37-45`).

### 4. Termination order
1. The Pod is marked as terminating. If a `preStop` hook exists, it runs first.
2. **[G]** The grace-period clock (default 30s) includes `preStop`. If `preStop` overruns, the kubelet grants a one-off 2-second extension (`pod-lifecycle.md:584-601`).
3. Then SIGTERM is sent (or the image's STOPSIGNAL). The order across containers is arbitrary (`:572`, `603-610`).
4. When the grace period expires, remaining processes get SIGKILL (`:636-645`).
5. In parallel, the endpoint stays in its EndpointSlice with `ready=false`, `serving` showing actual readiness, and `terminating` set (`:612-632`; `concepts/services-networking/endpoint-slices.md:91-124`).

**30 seconds is not guaranteed to finish long requests. [C]** Set `terminationGracePeriodSeconds` to at least the `preStop` time plus the longest request you allow. **[N]** How quickly each proxy or load balancer stops sending new traffic is not quantified in these docs.

### 5. Resources
- **[G]** CPU limits are enforced by throttling, and the container is not killed. Memory limits are enforced by OOM kills, reactively: memory may briefly exceed the limit before the kill (`concepts/configuration/manage-resources-containers.md:36-53`, `252-276`).
- CPU requests set the CPU weighting under contention (`:255-257`). If you set only a limit, the request defaults to the limit (`:63-67`).
- **[G]** If any container lacks a CPU request, utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`, `257-274`).
- **Recommendation [C]:** set CPU and memory requests on every container, and set a memory limit. Treat a CPU limit as optional, since throttling slows long requests.

### 6. HPA behaviour
- **[G]** Pods with missing metrics are set aside. They are then assumed to use 100% of target on a scale-down and 0% on a scale-up (`horizontal-pod-autoscale.md:160-161`, `183-186`).
- Not-yet-ready Pods are set aside for CPU and assumed to use 0% on a scale-up. "Not yet ready" is judged using `initial-readiness-delay` (default 30s) and `cpu-initialization-period` (default 5 minutes) (`:163-178`, `188-191`).
- Pods being deleted are ignored, and failed Pods are discarded (`:156-158`).
- No scaling happens if the result is within the 0.1 tolerance or the direction reverses (`:145-147`, `193-197`).
- The default downscale stabilization window is 5 minutes: the highest recommendation in that window wins (`:213-218`).
- Scaling therefore differs from the raw ratio. The reported status shows the raw average (`:199-202`).
- The Metrics Server is a separate add-on **[P]** (`:113-118`).
- Do not set `.spec.replicas` in the manifest while the HPA manages it (`deployment.md:1135-1140`).

### 7. Least-privilege networking
- **[G]** Pods are non-isolated by default. Any policy that selects a Pod with `Ingress` or `Egress` in its `policyTypes` isolates it in that direction. Allowed connections are the union of all applicable policies, which are additive and never conflict (`concepts/services-networking/network-policies.md:51-77`).
- Both ends must allow a connection: egress on the source and ingress on the destination (`:79-81`).
- **Plan [C]:** apply a namespace-wide default deny for ingress and egress (`:254-262`). Then allow ingress from the client namespace or ingress controller, and egress to the database Pods or CIDR on the database port.
- **DNS:** once egress is isolated, DNS lookups are blocked unless allowed (follows from `:59-65`). Add an explicit egress rule to cluster DNS. **[N]** The page I read gives no ready-made DNS rule.
- **[P]** Policies need a CNI plugin that enforces them; without one they have no effect (`:45-49`, `92-95`). Only TCP, UDP and SCTP are guaranteed (`:275-279`). Node traffic is always allowed (`:35-36`).

### 8. Secrets
- **Base64 is not protection.** **[G]** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them (`concepts/configuration/secret.md:35-37`).
- The docs require: encryption at rest, least-privilege RBAC on Secrets, restricting Secret access to specific containers, and considering external stores (`secret.md:42-48`).
- Encryption at rest covers API data only; it does not cover mounted volumes (`tasks/administer-cluster/encrypt-data.md:14-32`).
- **Pod creation matters [G]:** anyone who may create a Pod, or a Deployment, in the namespace can read every Secret in that namespace (`secret.md:38-40`). Restrict `create` on workloads as tightly as `get` on Secrets.
- Remove plaintext/base64 Secrets from Git. **[N]** Which external tool to use instead is outside these docs.

### 9. Storage reclaim policy
- **[G]** Dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:201-210`).
- **Changing the StorageClass later does not change existing PVs.** They must be patched one by one (`persistent-volumes.md:207-210`).
- `Retain`: after the PVC is deleted, the PV becomes "Released" and needs manual cleanup; the storage asset survives (`:185-199`). `Delete`: deletes both the PV and the backing storage (`:203-205`).
- **StatefulSet:** deleting or scaling down a StatefulSet does not delete its PVCs by default (`concepts/workloads/controllers/statefulset.md:52-54`). Its `whenDeleted`/`whenScaled` retention policies default to `Retain`, and apply only to deletion or scale-down, not to node failure (`:395-423`). When a PVC is garbage-collected, the PV's reclaim policy then decides the data's fate (`:438-445`).
- **Recommendation [C]:** use `Retain` for database data, and patch any existing PVs.

### 10. Prioritized rollout and validation checklist
1. **[P]** Confirm the CNI enforces NetworkPolicy, encryption at rest is enabled, and the Metrics Server is running.
2. Move Secrets out of Git. Tighten RBAC on Secret reads and on Pod/Deployment creation.
3. Use `Retain` storage and patch existing PVs.
4. Set requests on all containers and a memory limit.
5. Add startup, readiness and liveness probes. Set `terminationGracePeriodSeconds` to at least `preStop` plus the longest request.
6. Rollout: `maxUnavailable: 0`, `maxSurge: 1`. PDB: `minAvailable: 5` (or `maxUnavailable: 1`) with `AlwaysAllow`.
7. Add the zone spread constraint and the default-deny policy with allow-list rules, including DNS and the database.
8. Test: drain a node, run a rollout, and simulate losing a zone while load is applied.

**Limits that still need validation (not guaranteed by these docs):**
- Real startup time and longest request time. These set the probe thresholds and the grace period.
- Endpoint and load-balancer propagation delay during termination (`pod-lifecycle.md:612-632` gives no timing).
- Whether there is enough capacity in each zone for surge Pods and zone-failure replacements (`topology-spread-constraints.md:605-619`).
- Any disruption automation your provider runs (`disruptions.md:81-89`).
- The database's own connection limits and failover behaviour. These docs say nothing about them.
- CNI behaviour for non-TCP/UDP/SCTP traffic (`network-policies.md:275-279`).

---
*Evidence note:* the search index ran keyword-only. Every citation above comes from a direct, line-numbered read of the cited file.