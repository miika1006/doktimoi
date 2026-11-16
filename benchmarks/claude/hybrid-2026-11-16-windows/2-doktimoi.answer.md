# Decision memo: production readiness review of the six-replica API (Kubernetes v1.32 docs)

**Verdict:** The design should not ship as proposed. Three parts conflict with the documentation: the PDB and rollout settings work against each other, the default-allow network gives no isolation, and the Secrets handling assumes base64 is protection. The other parts are either missing configuration or need to be checked on the real cluster. All paths below are under `docs/`.

Each answer separates four kinds of statement:
- **Guarantee:** what the docs say Kubernetes does.
- **Configuration:** a choice the team makes.
- **Prerequisite:** something that must already be in place.
- **Not established:** something these documents do not show.

---

### 1. Does `minAvailable: 5` hold during node failure, drain and rollout?

- **Node failure: no.** Hardware failure, a VM disappearing and similar events are involuntary disruptions (`concepts/workloads/pods/disruptions.md:21-38`). "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`disruptions.md:130-131`).
- **Node drain: yes, within limits.** `kubectl drain` uses the Eviction API. That API respects PDBs, and drain retries rejected evictions until it succeeds or a timeout is reached (`disruptions.md:107-116`). With 6 intended replicas and a minimum of 5, only one Pod can be evicted at a time (`disruptions.md:118-121`). Deleting Pods or Deployments directly skips the PDB entirely (`disruptions.md:62-65`). Evicted Pods still terminate gracefully (`disruptions.md:143-145`).
- **Deployment rolling update: no.** Workload resources "are not limited by PDBs when doing rolling upgrades", although Pods made unavailable by the rollout do count against the budget (`disruptions.md:133-137`). With `maxUnavailable: 2`, availability can drop to 4 of 6 (`concepts/workloads/controllers/deployment.md:1189-1199`). During that window the budget is used up, so any drain running at the same time will stall.
- **Recommendation (configuration):** set `maxUnavailable: 0` with `maxSurge: 1`, or `maxUnavailable: 1`. This keeps the rollout at or above five available Pods. Also set `unhealthyPodEvictionPolicy: AlwaysAllow`, which the docs recommend so that unhealthy Pods do not block drains (`disruptions.md:139-142`).

### 2. Spreading replicas across zones

- **`topologyKey`** names a node label. Nodes with the same value for that label form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:95-126`). Use the zone label here.
- **`maxSkew`** is required and must be greater than 0. With `DoNotSchedule`, it is the largest allowed difference between a domain's Pod count and the global minimum (`topology-spread-constraints.md:76-93`).
- **`DoNotSchedule` vs `ScheduleAnyway`:** `DoNotSchedule` (the default) leaves a Pod Pending if placing it would break the skew. `ScheduleAnyway` always places the Pod and only prefers the domains with fewer Pods, and that preference is weighed together with other scoring factors (`topology-spread-constraints.md:95-126`, `:344-354`).
- **Recommendation:** `maxSkew: 1` on the zone key gives 2/2/2.
- **When a zone is unavailable:** these documents do not describe that case directly. What they do establish:
  - The scheduler only knows about zones that currently have nodes (`topology-spread-constraints.md:605-623`).
  - Spreading is not maintained when Pods are removed; the docs point to the Descheduler for rebalancing (`topology-spread-constraints.md:605-623`).
  - `minDomains` changes how the global minimum is calculated (`topology-spread-constraints.md:95-126`).

  Whether replacement Pods for a lost zone stay Pending (`DoNotSchedule`) or pile into the remaining zones (`ScheduleAnyway`) has to be tested on this cluster.

### 3. Probes for slow startup

- **Startup probe:** while it is defined, all other probes are disabled until it succeeds. If it fails, the kubelet kills the container and the restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:474-500`).
- **Recommended setup:** point the startup probe at the same endpoint as the liveness probe. Give it a `failureThreshold` × `periodSeconds` (default period 10 s) that covers the worst-case startup, and leave the liveness defaults alone (`pod-lifecycle.md:544-557`).
- **When traffic stops:** a failing readiness probe removes the Pod's IP from the Service endpoints. Readiness starts in the `Failure` state (`pod-lifecycle.md:474-500`), and the probe runs for the container's whole lifetime (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:349-388`).
- **When the container restarts:** only when the liveness or startup probe fails.
- **Liveness and readiness are independent of each other.** Use a startup probe or `initialDelaySeconds` to delay them (`configure-liveness-readiness-startup-probes.md:349-388`).
- **Not established:** the actual startup time, which the team must measure.

### 4. Termination order and the 30-second grace period

The sequence the docs describe:
1. The Pod is marked Terminating and the grace-period deadline is recorded (`pod-lifecycle.md:559-610`).
2. The `preStop` hook runs. Its time comes out of the grace period, and the only extension is a one-time 2 seconds (`pod-lifecycle.md:559-610`).
3. SIGTERM (or the image's `STOPSIGNAL`) is sent. Containers receive it in no guaranteed order (`pod-lifecycle.md:559-610`).
4. At the same time, the endpoints stay in EndpointSlices marked terminating with `ready=false`, so load balancers stop sending regular traffic. The `serving` condition still shows actual readiness, for use when draining connections (`pod-lifecycle.md:610-636`; `reference/kubernetes-api/service-resources/endpoint-slice-v1.md:49-121`).
5. When the grace period expires, SIGKILL is sent and the Pod object is removed (`pod-lifecycle.md:636-645`).

- **Is 30 seconds guaranteed to finish requests? No.** 30 s is the default and an upper limit, not a promise that requests complete. If `preStop` needs longer, the docs say you must raise `terminationGracePeriodSeconds` (`pod-lifecycle.md:559-610`).
- **Recommendation (configuration):** set the grace period to at least the `preStop` time plus the longest request time plus a margin.

### 5. Resources

- **Requests vs limits:** a container may use more than its request (`concepts/configuration/manage-resources-containers.md:27-67`).
- **CPU limits** are enforced by throttling and are a hard ceiling.
- **Memory limits** are enforced reactively by OOM kills, which happen only when the kernel detects memory pressure.
- **Limit without request:** if a limit is set without a request, the limit is copied into the request.
- **HPA:** utilization is "the ratio between the current usage of resource to the requested resources", so requests "should be specified" (`tasks/run-application/horizontal-pod-autoscale.md:255-281`).
- **Inference, not an explicit statement found:** without a CPU request, utilization has no denominator, so utilization-based HPA cannot work as intended. The note in the same section also says summing containers can hide one container running hot.
- **Recommendation:** set CPU requests and memory requests and limits. Set CPU limits only if throttling a long request is acceptable.

### 6. HPA behavior

- **Pods excluded from the calculation:** Pods being deleted are ignored and failed Pods are discarded. Pods with missing metrics, and on CPU any Pods that are not yet ready, are set aside (`horizontal-pod-autoscale.md:140-165`).
- **Not-yet-ready timing:** the initial readiness delay defaults to 30 s and the CPU initialization period to 5 minutes (`horizontal-pod-autoscale.md:167-202`).
- **Missing metrics:** these Pods are counted as 100% of target when scaling down and 0% when scaling up. Not-yet-ready Pods are counted as 0% for a scale-up (`horizontal-pod-autoscale.md:167-202`).
- **Why scaling differs from the raw ratio:**
  - The ratio is recalculated after those adjustments.
  - No action is taken if the adjusted ratio is within the tolerance (default 0.1) or reverses direction (`horizontal-pod-autoscale.md:140-165`, `:167-202`).
  - If a metric fails and the rest suggest scaling down, scaling is skipped.
  - The downscale stabilization window defaults to 300 s, and the HPA picks the highest recommendation within it (`horizontal-pod-autoscale.md:204-218`, `:455-486`).
- **Interaction with this design:** with a slow startup, new Pods count as 0% for a while, so scale-ups are dampened.

### 7. Least-privilege networking

- **Isolation:** ingress and egress isolation apply independently. A Pod becomes isolated in a direction once any policy selecting it lists that direction in `policyTypes` (`concepts/services-networking/network-policies.md:51-81`).
- **Additive policies:** allowed traffic is the union of all matching policies. A connection needs the source Pod's egress and the destination Pod's ingress to both allow it (`network-policies.md:51-81`).
- **Plan:**
  1. Add default-deny for ingress (`network-policies.md:214-222`) and add a matching default-deny for egress.
  2. Allow ingress to the API from the ingress or client Pods.
  3. Allow egress from the API to the database, and ingress on the database from the API.
- **DNS:** an exact search of the NetworkPolicy page for "DNS" and "port 53" found nothing. These docs do not establish the DNS allowance. It is a validation item: once egress is denied, DNS egress must be allowed explicitly and tested.
- **Prerequisite:** NetworkPolicy has no effect unless the network plugin implements it (`network-policies.md:45-49`).

### 8. Secrets

- **Base64 is not protection.** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them. Anyone who can create a Pod, or indirectly a Deployment, in the namespace can read every Secret in it (`concepts/configuration/secret.md:1-53`).
- **Required steps from the docs** (`secret.md:1-53`; `concepts/security/security-checklist.md:245-275`):
  - Encryption at rest
  - Least-privilege RBAC
  - Per-container access
  - Optionally an external secret store or CSI driver
  - Mounting Secrets as files rather than environment variables
  - Turning off service-account token automounting where it isn't needed
- **Recommendation:** remove the Secret manifests from Git and rotate every exposed value. Treat permission to create Pods or Deployments as read access to Secrets.

### 9. Storage reclaim policy

- **Effect on existing PVs:** dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`). The docs say that otherwise "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). That implies changing the class does not rewrite existing PVs, but no explicit sentence saying so was found.
- **Retain:** after the PVC is deleted, the PV is Released and the data stays until someone reclaims it manually (`persistent-volumes.md:185-199`).
- **Delete:** removes both the PV and the external storage asset (`persistent-volumes.md:201-210`).
- **PVC deletion vs StatefulSet actions:**
  - Deleting a PVC triggers the reclaim policy (`persistent-volumes.md:176-183`).
  - For StatefulSets, `persistentVolumeClaimRetentionPolicy` defaults to Retain for both deletion and scale-down. `Delete` lets the garbage collector remove the PVCs after the Pods terminate (`reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`; `concepts/workloads/controllers/statefulset.md:438-463`).
- **Recommendation:** use `Retain` for the database volumes and patch the existing PVs explicitly.

### 10. Rollout and validation checklist (in priority order)

1. Move Secrets out of Git, rotate them, enable encryption at rest, and tighten RBAC, including who can create Pods or Deployments (Q8).
2. Confirm the CNI enforces NetworkPolicy. Then apply default-deny, the allow rules, and DNS egress (Q7).
3. Set CPU and memory requests (and limits where appropriate) and verify the HPA metrics (Q5, Q6).
4. Add startup, readiness and liveness probes sized to the measured startup time (Q3).
5. Size the grace period and `preStop` (Q4).
6. Change the rollout to `maxSurge: 1` with `maxUnavailable: 0` or 1. Add `unhealthyPodEvictionPolicy: AlwaysAllow` to the PDB (Q1).
7. Add zone spreading and decide between `DoNotSchedule` and `ScheduleAnyway` (Q2).
8. Set the storage reclaim policy to `Retain` and patch existing PVs (Q9).
9. Rehearse: a drain, a rollout during load, a zone outage, and HPA scale-up under slow startup.

**Limits that still need application or cluster validation (not guaranteed by these docs):**
- Whether long requests finish within the grace period, and whether the app drains connections on SIGTERM.
- Whether the CNI actually enforces NetworkPolicy, and the exact DNS egress rule needed.
- Real startup time and probe thresholds.
- Zone-outage capacity and the scheduling outcome.
- Node autoscaler awareness of the topology domains.
- That the volume plugin supports `Delete`, and how the database handles failover.
- That no involuntary disruption drops availability below five; PDBs cannot prevent that.