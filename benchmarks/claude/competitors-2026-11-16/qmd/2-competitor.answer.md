# Decision memo: Kubernetes v1.32 review of the proposed API deployment

**Recommendation:** Do not approve the design as proposed. Four parts conflict with what the documentation says: the PDB combined with `maxUnavailable: 2`, the 30-second grace period for long requests, default-allow networking, and base64 Secrets in Git. The other parts can work, but only with explicit configuration and testing. All paths below are under `docs/`.

---

### 1. Does the PDB keep five replicas available?

With six replicas and `minAvailable: 5`, the budget allows one voluntary disruption at a time. A PDB "limits the number of Pods … that are down simultaneously from voluntary disruptions" (`concepts/workloads/pods/disruptions.md:99-105`, `118-121`).

- **Node failure:** this is an involuntary disruption, and the PDB does not protect against it. Involuntary disruptions "cannot be prevented by PDBs; however they do count against the budget" (`disruptions.md:26-34`, `130-131`). If a node holding two Pods fails, you have four.
- **Node drain:** `kubectl drain` goes through the Eviction API. An eviction that would break the budget is refused and retried (`disruptions.md:107-116`), and the worked example shows drains blocking (`195-223`). Two caveats apply. Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:62-65`). Unhealthy Pods block a drain unless you set `AlwaysAllow` (`disruptions.md:138-141`).
- **Rolling update:** "workload resources (such as Deployment …) are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2` the Deployment may legitimately drop to four available Pods (`concepts/workloads/controllers/deployment.md:1191-1199`).

**Fix (configuration):** set `maxUnavailable: 0` and `maxSurge: 1`. The two cannot both be 0 (`deployment.md:1194`, `1203-1206`). This keeps six available Pods during a rollout, but only if there is spare capacity to schedule the surge Pod.

### 2. How to spread replicas across zones

Use `maxSkew: 1`, set `topologyKey` to the node label that identifies the zone, and use a `labelSelector` that matches the app. The `matchLabelKeys: [pod-template-hash]` field separates Deployment revisions (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`, `117-122`, `134-160`). Check which zone label your nodes actually carry; the docs do not fix it for your cluster.

- **`DoNotSchedule`** (the default) is a hard rule: a Pod that would exceed the skew is not scheduled.
- **`ScheduleAnyway`** only prefers placements that reduce skew (`topology-spread-constraints.md:124-126`).
- **`minDomains`** works only with `DoNotSchedule`. When there are fewer eligible domains than `minDomains`, the global minimum is treated as 0 (`topology-spread-constraints.md:107-115`).

**Zone loss:** the docs do not describe what happens during a zone outage. What they do say is that spreading is checked only at scheduling time. "There's no guarantee that the constraints remain satisfied when Pods are removed" (`topology-spread-constraints.md:608-609`). With `DoNotSchedule`, replacement Pods may stay Pending, so test this in your cluster. A practical starting point is `DoNotSchedule` with `minDomains` unset, plus capacity planning.

### 3. Probes for a slow-starting app

- **Startup probe:** use the same check as the liveness probe, with `failureThreshold × periodSeconds` covering the worst-case startup time (example: 30 × 10s = 300s). If it never succeeds, the container is killed and restarted according to `restartPolicy` (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **When the other probes start:** "All other probes are disabled if a startup probe is provided, until it succeeds" (`concepts/workloads/pods/pod-lifecycle.md:492-497`).
- **When traffic stops:** when readiness fails, the Pod's IP is removed from Service endpoints. The container keeps running (`pod-lifecycle.md:485-490`). Readiness runs for the container's whole lifetime (`probes.md:360-362`).
- **When a container restarts:** when the liveness probe fails (`pod-lifecycle.md:479-483`).

Keep the liveness probe at its defaults (`pod-lifecycle.md:552-557`). Do not make liveness depend on the database, or a database outage will restart every replica. That last point is a design inference; the docs do not state it.

### 4. Termination order, and whether 30 seconds is enough

1. The Pod is marked Terminating, and the grace-period clock starts (`pod-lifecycle.md:584-589`).
2. `preStop` runs inside that same grace period. If it is still running when the period expires, the kubelet grants one extra 2 seconds (`pod-lifecycle.md:591-601`).
3. SIGTERM is sent to PID 1, or the image's STOPSIGNAL. Containers receive it in arbitrary order (`pod-lifecycle.md:572`, `603-610`).
4. At the same time, the endpoint is marked terminating with `ready=false`, so load balancers stop sending it regular traffic (`pod-lifecycle.md:612-628`).
5. When the grace period expires, remaining processes get SIGKILL (`pod-lifecycle.md:636-640`).

**30 seconds is not guaranteed to finish requests.** It is only the default (`pod-lifecycle.md:594`). Set `terminationGracePeriodSeconds` to at least: preStop time + longest request + a margin. Evictions honor this setting (`disruptions.md:143-145`).

### 5. CPU and memory resources

- **CPU request:** used for scheduling and as a weighting when CPU is contended (`concepts/configuration/manage-resources-containers.md:232-241`, `255-257`).
- **CPU limit:** a hard ceiling. Exceeding it causes **throttling**, not a kill (`manage-resources-containers.md:252-254`).
- **Memory limit:** exceeding it triggers the kernel **OOM killer**, and the container may be restarted (`manage-resources-containers.md:261-265`). Exceeding the memory *request* on a node short of memory makes the Pod a likely eviction target (`manage-resources-containers.md:271-273`).
- **Limit without request:** if only a limit is set, it is copied as the request (`manage-resources-containers.md:63-67`).
- **HPA impact:** HPA utilization is a percentage of the request. If any container lacks a CPU request, "CPU utilization for the Pod will not be defined and the autoscaler will not take any action" (`tasks/run-application/horizontal-pod-autoscale.md:92-102`). **CPU requests are therefore mandatory for this design.**

### 6. HPA behaviour with missing metrics and not-yet-ready Pods

- Pods being deleted are ignored, failed Pods are discarded, and Pods with missing metrics are set aside (`horizontal-pod-autoscale.md:153-161`).
- For CPU, Pods that are not yet ready, or whose metric predates readiness, are also set aside. This uses `initial-readiness-delay` (default 30s) and `cpu-initialization-period` (default 5 min) (`horizontal-pod-autoscale.md:163-178`).
- Missing Pods are then counted as using 100% of target for a scale-down and 0% for a scale-up. Not-yet-ready Pods count as 0%, which dampens scale-up (`horizontal-pod-autoscale.md:183-191`).
- If the adjusted ratio reverses direction or falls within the 0.1 tolerance, HPA does nothing (`horizontal-pod-autoscale.md:145-147`, `193-197`).
- The status shows the original, unadjusted utilization (`horizontal-pod-autoscale.md:199-202`).
- Downscale stabilization picks the highest recommendation from the last **5 minutes** (`horizontal-pod-autoscale.md:213-218`).

For this app, slow startup means new Pods add capacity late and scale-up is deliberately conservative. Set `minReplicas` high enough to cover that lag.

### 7. Replacing default-allow networking

- Without policies, all traffic is allowed (`concepts/services-networking/network-policies.md:208-212`).
- A Pod becomes isolated for ingress or egress only when some policy selects it and lists that direction in `policyTypes`. The allowed traffic is then the union of all applicable policies; policies are additive (`network-policies.md:51-77`).
- A connection needs **both** egress allowed on the source and ingress allowed on the destination (`network-policies.md:79-81`).

Start with default-deny ingress and default-deny egress (`network-policies.md:214-242`). Then add allow rules for the clients or ingress controller → API port, and API → database port. Ingress from the Pod's own node is always allowed (`network-policies.md:33-36`, `70-71`).

**DNS:** the docs I retrieved do not give a DNS-specific example. Under default-deny egress, name resolution works only if you explicitly allow egress to your DNS Pods on port 53 over UDP and TCP. This follows from the egress rules above.

**Prerequisite:** policies "will have no effect" without a NetworkPolicy-capable CNI (`network-policies.md:45-49`). Behaviour for protocols other than TCP, UDP and SCTP is undefined (`network-policies.md:275-279`).

### 8. Is base64 enough for Secrets?

No. Base64 is "obscured but not secret" (`concepts/configuration/secret.md:306-308`).

- Secrets are stored unencrypted in etcd by default. Anyone authorized to create a Pod, or indirectly a Deployment, in the namespace can read every Secret there (`secret.md:35-41`).
- Required steps: encryption at rest, least-privilege RBAC, restricting Secrets to specific containers, and considering external Secret stores (`secret.md:42-48`).
- For RBAC: use namespace-scoped RoleBindings and avoid wildcards (`concepts/security/rbac-good-practices.md:25-37`). `list` and `watch` reveal Secret contents just like `get` (`rbac-good-practices.md:93-98`). Workload-creation permission implicitly grants access to Secrets and to any ServiceAccount in the namespace (`rbac-good-practices.md:100-108`).

Remove plaintext Secret values from Git. Which replacement to use is a configuration choice the docs leave open.

### 9. Changing a StorageClass reclaim policy

- Dynamically provisioned PVs take the class's `reclaimPolicy` at the time they are created. The default is `Delete` (`concepts/storage/storage-classes.md:126-135`).
- The docs do not say that changing the class later updates existing PVs. They point to editing or patching each PV instead (`concepts/storage/persistent-volumes.md:205-210`).
- **Retain:** deleting the PVC leaves the PV "Released", and the data and storage asset need manual cleanup (`persistent-volumes.md:185-199`).
- **Delete:** removes both the PV and the external storage asset (`persistent-volumes.md:201-206`).
- **StatefulSet PVCs:** `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`, default `Retain`) applies only when the StatefulSet is deleted or scaled down. It does not apply to node-failure replacement (`concepts/workloads/controllers/statefulset.md:387-423`).

Deleting the PVC is what triggers the PV reclaim policy. For database volumes, set `Retain` on existing PVs before going live.

### 10. Prioritized rollout and validation checklist

1. Fix the rollout to `maxUnavailable: 0`, `maxSurge: 1`, keep the PDB, add `AlwaysAllow` for unhealthy Pods, and confirm surge capacity in each zone (Q1).
2. Add Secret encryption at rest, least-privilege RBAC covering `list`/`watch` and Pod creation, and remove Secrets from Git (Q8).
3. Patch database PVs to `Retain` and review the StorageClass default (Q9).
4. Set CPU and memory requests, a memory limit, and a deliberate CPU-limit policy; then configure HPA (Q5–6).
5. Add a startup probe sized to the measured worst-case startup, plus separate readiness and liveness probes (Q3).
6. Size the grace period for preStop plus the longest request, and test connection draining (Q4).
7. Add zone topology spread constraints (Q2).
8. Confirm the CNI supports NetworkPolicy, apply default-deny, then add allow rules including DNS and the database (Q7).

**Limits these documents do not guarantee, and which need application or cluster testing:**
- Behaviour during a zone outage: whether replacement Pods stay Pending or capacity runs out. Run a game day.
- Whether your longest requests finish within the grace period, and whether the app handles SIGTERM correctly.
- Actual startup time, and how long HPA scale-up takes in practice.
- Whether the CNI enforces NetworkPolicy and whether DNS and database flows still work under default-deny.
- Whether the storage provisioner supports `Delete` or `Retain`, and whether backup and restore work for the stateful database.
- Which voluntary-disruption sources your provider runs, and whether they use the Eviction API (`disruptions.md:58-60`, `81-89`).