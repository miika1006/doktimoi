# Decision memo: production readiness review of the zonal API Deployment

**Basis:** Kubernetes v1.32 docs in `docs/` only. Line ranges point to those files. Labels: **[G]** documented guarantee/behaviour, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

**Verdict: not ready as proposed.** The PDB clashes with `maxUnavailable: 2`. Networking is default-allow. Secrets in Git are only base64-encoded. The termination and storage retention settings have not been checked against the workload.

---

### 1. PDB `minAvailable: 5`

- **Node failure:** not protected. [G] Involuntary disruptions "cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:130-131`; examples at 21-30).
- **Node drain:** protected, but only through the Eviction API. [G] `kubectl drain` evicts pods and retries when an eviction is rejected (`disruptions.md:107-117`). With 6 replicas and minAvailable 5, only one pod can be evicted at a time (same mechanism as 118-121). [C] By default a drain waits for unhealthy pods to become healthy. `AlwaysAllow` is recommended (138-141). [P] Tools that delete pods directly skip the PDB (106-109).
- **Rolling update:** not protected. [G] Rollout pods "count against the disruption budget, but … Deployment … [is] not limited by PDBs" (133-136). `maxUnavailable: 2` permits 6−2 = 4 available pods (`concepts/workloads/controllers/deployment.md:1191-1199`). That breaks the intent of minAvailable 5, and while the rollout runs, drains will block.
- **Recommendation [C]:** `maxUnavailable: 0`, `maxSurge: 1` (both fields are legal, but they cannot both be 0: `deployment.md:1194,1205`). Add `minReadySeconds` and `progressDeadlineSeconds` (1314-1325). Add `unhealthyPodEvictionPolicy: AlwaysAllow`.

### 2. Zone spreading

- [G] `topologyKey` is a node-label key. Each key/value pair is a domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- [G] With `DoNotSchedule`, `maxSkew` is the largest allowed gap from the global minimum (82-91). `ScheduleAnyway` only prefers lower skew (92-93, 125-126). `DoNotSchedule` is the default and leaves the pod Pending when the constraint can't be met (125, 294-295).
- **Recommendation [C]:** `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1`, `DoNotSchedule`, with a `labelSelector` that matches the pod template (493-499). Add a second constraint on hostname with `ScheduleAnyway`.
- **Zone loss [G]:**
  - Domains are discovered only from existing nodes. A zone with no nodes is not counted (614-619).
  - Nodes without the key are bypassed (480-486).
  - Pods on tainted nodes still count (612). With `DoNotSchedule`, replacements can therefore stay Pending.
  - Spread is not maintained when pods are removed or the Deployment scales down (607-608).
- [N] How a partly failed zone behaves in practice has to be tested.

### 3. Probes for slow startup

- [G] While a startup probe is defined, liveness and readiness are disabled until it succeeds. If it fails, the container is killed (`concepts/workloads/pods/pod-lifecycle.md:492-497`; `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:31-35, 398-401`).
- [C] Point the startup probe at the liveness endpoint. Set `failureThreshold × periodSeconds` to cover the worst observed startup time, and keep the liveness defaults (`pod-lifecycle.md:544-557`).
- **Traffic stops** when readiness fails: the Pod is removed from the Service endpoints and the container keeps running (`pod-lifecycle.md:485-490`; task doc 419-422). Readiness runs for the whole container lifetime (task doc 358-360).
- **Restart** happens after `failureThreshold` consecutive liveness or startup failures (task doc 413-418).
- Pattern [C]: use the same cheap endpoint for liveness as readiness, with a higher threshold (task doc 19-21). Readiness may also check the database (`pod-lifecycle.md:523-528`).

### 4. Termination

- [G] Deletion records the grace period (default 30s). The kubelet runs `preStop`, then sends TERM. If `preStop` is still running when the grace period ends, the kubelet adds one 2-second extension (`pod-lifecycle.md:567-574, 581-600`).
- [G] TERM is sent to containers in arbitrary order (605-610). When the grace period expires, KILL is sent (637-639).
- [G] Endpoint removal starts at the same time as shutdown. Terminating endpoints stay listed with `ready=false`, so load balancers stop sending them regular traffic. A `serving` condition is available for draining (614-632).
- The steps are documented as running at the same time, but the docs give no figure for how quickly every load balancer stops sending traffic.
- **Is 30s enough?** Not guaranteed. `preStop` uses up the same grace period, and the docs say to raise `terminationGracePeriodSeconds` if it needs longer (599-600). [N] Whether long requests finish depends on the application.

### 5. Resources

- [G] Requests are used for scheduling and set CPU weighting (`concepts/configuration/manage-resources-containers.md:18-23, 255-257`).
- [G] A CPU limit is a hard limit enforced by throttling (43-45, 251-254).
- [G] A memory limit is enforced by the OOM killer. Enforcement is reactive, under memory pressure (48-52, 261-265).
- [G] For HPA, if a container has no CPU request, "CPU utilization for the Pod will not be defined and the autoscaler will not take any action" (`tasks/run-application/horizontal-pod-autoscale.md:99-101`; 258).
- [C] Set CPU and memory requests on every container, and a memory limit. Treat a CPU limit with care: throttling slows long requests.

### 6. HPA behaviour

- [G] Pods being deleted are ignored and failed Pods are discarded (`horizontal-pod-autoscale.md:153-158`).
- [G] Pods without metrics are set aside. When computing a scale-down they are assumed to use 100% of target; for a scale-up, 0% (160-161, 183-186).
- [G] For CPU, Pods that are not yet ready are set aside and assumed to use 0% (163-182, 188-191). Defaults: 30s initial readiness delay and a 5-minute CPU initialization period.
- [G] Changes inside the tolerance (0.1) or that reverse direction are skipped (145-147, 193-197). The status shows the raw average (199-202).
- [G] Downscale stabilization defaults to 300s and takes the highest recommendation in the window (213-218, 480-486). There is no scale-up window.
- Slow-starting pods therefore make scale-up more cautious, and scale-down is delayed. The actual result can differ from `ceil(current × ratio)` (137).

### 7. Network least privilege

- [P] Requires a network plugin that enforces NetworkPolicy. Without one, the objects "have no effect" (`concepts/services-networking/network-policies.md:16, 46-49`).
- [G] Pods are non-isolated by default. Any policy that selects a pod for a direction isolates it in that direction (55-73).
- [G] Policies are additive: the result is the union, and order does not matter (75-77). Both the source's egress and the destination's ingress must allow a connection (79-81).
- [C] Plan:
  1. Default-deny both ingress and egress (214-262).
  2. Allow ingress to the API from the ingress or load-balancer pods.
  3. Allow egress from the API to the database, and ingress at the database from the API.
- [N] The NetworkPolicy page gives no DNS guidance. The team must add explicit egress to cluster DNS and test it.
- [G] Enforcement is eventual. New pods may start with no network connectivity (362-384).

### 8. Secrets

- Base64 is not protection. The docs call it "obscured but not secret" (`concepts/configuration/secret.md:306`).
- [G] By default Secrets are stored unencrypted in etcd. Anyone who can create Pods or Deployments in a namespace can read every Secret there (34-39).
- [C] Required steps (41-47):
  - encryption at rest
  - least-privilege RBAC
  - limiting Secret access to the containers that need it
  - an external secret store
- The `identity` provider "does not provide any confidentiality protection" (`tasks/administer-cluster/encrypt-data.md:64-66`).
- Permission to create workloads implicitly grants access to Secrets and PersistentVolumes, and to the permissions of any ServiceAccount in the namespace (`concepts/security/rbac-good-practices.md:100-108`). Containers with `privileged: true` can read every Secret used on their node (`secret.md:671-674`).
- **Remove plaintext Secrets from Git.**

### 9. Storage reclaim

- [G] Dynamically provisioned PVs take the reclaim policy of their StorageClass when created. The default is `Delete` (`concepts/storage/storage-classes.md:126-132`; `concepts/storage/persistent-volumes.md:205-210`). The docs say to configure the class up front, "otherwise, the PV must be edited or patched after it is created" (206-210).
- Changing the class therefore does not change existing PVs. That is an inference from these lines; no line states it directly.
- **Retain:** after PVC deletion the PV is "Released". The data stays, and cleanup and deletion of the storage asset are manual (185-198).
- **Delete:** removes both the PV and the external storage asset (203-205).
- **StatefulSet:** deleting or scaling down a StatefulSet does not delete its volumes (`concepts/workloads/controllers/statefulset.md:52-54`). `persistentVolumeClaimRetentionPolicy` sets `whenDeleted` and `whenScaled`, both defaulting to `Retain` (391-416). Deleting a PVC triggers the PV's reclaim policy.

### 10. Prioritized checklist

1. **Secrets:** remove them from Git, enable encryption at rest (not `identity`), and scope RBAC for Secrets and workload creation (§8).
2. **Rollout:** `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds`, progress deadline. Set the PDB to `AlwaysAllow` and test a drain (§1).
3. **Probes:** startup probe sized from measured worst-case startup, readiness probe, conservative liveness probe (§3).
4. **Termination:** grace period of at least preStop time + longest request + margin, a SIGTERM handler, and a load test during rollout (§4).
5. **Resources:** requests on every container, memory limit, a deliberate CPU-limit decision. Check HPA status and a 5-minute scale-down (§5–6).
6. **Network:** confirm the CNI enforces policy, apply default-deny with explicit allows (including DNS), and test both ends (§7).
7. **Spreading:** zone and hostname constraints. Test the loss of a zone (§2).
8. **Database storage:** set the reclaim policy in the class, patch existing PVs explicitly, and check StatefulSet PVC retention (§9).

**Limits the docs do not guarantee and that need validation:**
- (a) whether long requests finish within the grace period, and how quickly each load balancer stops routing to terminating endpoints (§4)
- (b) whether pods still schedule when a zone is degraded or tainted, and whether node autoscaling understands the spread constraints (`topology-spread-constraints.md:612-623`)
- (c) when the CNI actually applies NetworkPolicy, and how DNS egress behaves (`network-policies.md:380-384`)
- (d) node failure: PDBs do not apply to involuntary disruption, so capacity with fewer than 5 pods needs testing
- (e) whether the database tolerates restarts, failover and connection draining, which these documents do not cover