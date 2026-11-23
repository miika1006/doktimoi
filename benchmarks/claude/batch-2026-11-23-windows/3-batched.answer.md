I've checked all ten areas against the local docs. The memo follows.

# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs only)

**Recommendation: do not approve the design as proposed.** The PDB, rollout settings, networking, Secrets handling and storage defaults all need changes. Several limits cannot be guaranteed by Kubernetes and have to be tested. All paths below are relative to `docs/`.

**How to read the labels:** **[G]** = a behaviour the docs guarantee; **[C]** = a configuration choice; **[P]** = something that must already be in place; **[N]** = something the docs do not establish.

---

### 1. Does `minAvailable: 5` keep five replicas up?

**No, not in all three cases.**

- **Node failure:** **[G]** A PDB cannot prevent involuntary disruptions, though they still count against the budget (`concepts/workloads/pods/disruptions.md:130-131`). A budget "does not truly guarantee" its minimum. A node can fail while the app is already at the minimum (`tasks/run-application/configure-pdb.md:148-155`).
- **Node drain:** **[G]** `kubectl drain` uses the Eviction API, which respects PDBs. Rejected evictions are retried until they succeed or time out (`disruptions.md:107-116`). With `minAvailable: 5`, an eviction is allowed only if five or more healthy pods remain (`configure-pdb.md:131-132`). "Healthy" means the pod's Ready condition is True (`configure-pdb.md:236-240`). With six replicas, pods are drained one at a time. If any pod is unhealthy, the drain blocks.
- **Rolling update:** **[G]** Pods taken down by a rolling upgrade count against the budget, but a Deployment is **not limited** by the PDB (`disruptions.md:133-136`). `maxUnavailable: 2` lets the rollout drop to 4 available pods (`concepts/workloads/controllers/deployment.md:1191-1199`). That is below the budget, and any drain during the rollout would be blocked.

**Recommendation [C]:**
- Set the rollout to `maxUnavailable: 0, maxSurge: 1`. `maxUnavailable: 0` is valid only when `maxSurge` is above zero (`deployment.md:1194, 1203-1206`).
- Add `minReadySeconds` so a new pod must stay ready for a while before it counts as available (`deployment.md:1325-1328`).
- Consider a PDB with `maxUnavailable: 1` instead of `minAvailable: 5`. It is calculated from the desired replica count, so it keeps working when the HPA changes the count (`configure-pdb.md:126-128, 137-138`).
- Set `unhealthyPodEvictionPolicy: AlwaysAllow` so broken pods do not block drains (`disruptions.md:138-141`; `configure-pdb.md:242-277`).

### 2. Spreading replicas across zones

- **`maxSkew`** **[G]**: with `DoNotSchedule`, this is the largest allowed difference between a zone's pod count and the global minimum. With `ScheduleAnyway`, the scheduler only prefers placements that reduce skew (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`).
- **`topologyKey`** **[G]**: a node label. Nodes with the same value form one domain (`topology-spread-constraints.md:117-122`).
- **`DoNotSchedule` vs `ScheduleAnyway`** **[G]**: `DoNotSchedule` (the default) leaves a pod unscheduled if it would break the constraint. `ScheduleAnyway` places it anyway (`topology-spread-constraints.md:124-126`).

**Recommendation [C]:**
- Use `topology.kubernetes.io/zone` with `maxSkew: 1`.
- Use `DoNotSchedule` for zone balance, plus a hostname constraint with `ScheduleAnyway`.
- Add `matchLabelKeys: [pod-template-hash]` so each revision is spread separately during a rollout (`topology-spread-constraints.md:134-160`).

**When a zone is unavailable:**
- **[G]** If every node in a zone is unhealthy, the node controller evicts pods at the normal rate. In a partial outage at or above the unhealthy-zone threshold, eviction slows down, and in small clusters (50 nodes or fewer by default) it stops (`concepts/architecture/nodes.md:237-261`).
- **[G]** Nodes that still exist but are NotReady remain eligible domains, because `nodeTaintsPolicy` defaults to Ignore (`topology-spread-constraints.md:179-185`). With `DoNotSchedule`, replacement pods may then stay Pending.
- **[G]** A zone whose node group has scaled to zero is invisible to the scheduler (`topology-spread-constraints.md:614-623`).
- **[G]** Spread is not maintained when pods are removed, so a scale-down can leave zones unbalanced (`topology-spread-constraints.md:607-611`).
- **[N]** The docs do not establish how this exact six-pod layout behaves during a real zone outage. Test it.

### 3. Probes for a slow-starting app

**[G]**
- Use a **startup probe** with `failureThreshold × periodSeconds` covering the worst-case startup time. Liveness takes over after the first startup success. If startup never succeeds, the container is killed and handled by the restart policy (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- The liveness and readiness delays do not start until the startup probe has succeeded (`configure-liveness-readiness-startup-probes.md:398-402`).

**When traffic stops** **[G]**: when readiness fails `failureThreshold` times, the Pod becomes NotReady and stops getting Service traffic. The container keeps running (`configure-liveness-readiness-startup-probes.md:356-358, 419-422`).

**When a container restarts** **[G]**: when the startup or liveness probe fails `failureThreshold` times, that container is restarted with its termination grace period honoured (`configure-liveness-readiness-startup-probes.md:412-418`).

**Recommendation [C]:**
- Readiness should check whether the app can serve, including the database dependency.
- Liveness should check only for deadlocks, so a database outage does not cause restarts (`configure-liveness-readiness-startup-probes.md:351-355, 365-367`).

### 4. Termination order and the 30-second grace period

**[G]** The sequence is:
1. The Pod is marked Terminating with a deadline.
2. The `preStop` hook runs.
3. SIGTERM (or the image's STOPSIGNAL) goes to process 1 in each container.
4. When the grace period runs out, SIGKILL follows (`concepts/workloads/pods/pod-lifecycle.md:572-577, 584-610, 636-645`).

Details that matter here:
- `preStop` counts against the grace period. Only a one-off 2-second extension is added, and a longer hook needs a larger `terminationGracePeriodSeconds` (`pod-lifecycle.md:591-601`).
- The Pod is taken out of EndpointSlices *at the same time* that shutdown starts. A terminating endpoint always has `ready=false` and reports `serving` separately (`pod-lifecycle.md:612-631`; `concepts/services-networking/endpoint-slices.md:89-115`).

**Is 30 seconds enough? [N]** No. 30 seconds is only the default (`pod-lifecycle.md:594`). Nothing in the docs ensures that long requests finish within it. Measure the longest request time, then set grace period ≥ preStop + drain time + margin.

### 5. CPU and memory requests and limits

**[G]**
- **CPU limit:** a hard ceiling enforced by throttling. The container is not killed for using too much CPU (`concepts/configuration/manage-resources-containers.md:43-46, 252-257, 275-276`).
- **Memory limit:** enforced reactively by OOM kill (`manage-resources-containers.md:48-53, 261-265`).
- **Memory request exceeded:** if the node runs short of memory, the pod is likely to be evicted (`manage-resources-containers.md:271-273`).
- **Missing CPU requests:** utilization-based HPA measures CPU as a percentage of the request. If any container lacks a request, utilization is undefined and **the HPA takes no action** for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`).

**[C]** Set a CPU request on every container, including sidecars, and a memory limit. Throttling can make slow startup and long requests worse; test that before setting a tight CPU limit.

### 6. HPA with missing metrics and not-yet-ready Pods

**[G]**
- Pods without metrics, and pods that are not yet ready when scaling on CPU, are set aside. Pods being deleted are ignored and failed pods are discarded (`horizontal-pod-autoscale.md:153-178`).
- For missing metrics, the HPA assumes 100% of target on a scale-down and 0% on a scale-up. On a scale-up, not-yet-ready pods are counted as 0%. If the recomputed ratio reverses direction or falls within the 0.1 tolerance, nothing happens (`horizontal-pod-autoscale.md:141-147, 183-197`).
- The HPA status reports the raw average, not the adjusted one (`horizontal-pod-autoscale.md:199-202`).
- Scale-downs use the highest recommendation from a 5-minute (300 s) stabilization window (`horizontal-pod-autoscale.md:213-218, 480-484`).

**Why actual scaling differs from the raw ratio:** set-aside pods, the conservative assumptions, the tolerance band and the stabilization window all change the result.

**[P]** The metrics API usually comes from Metrics Server, which has to be deployed separately (`horizontal-pod-autoscale.md:113-118`).

### 7. Replacing default-allow networking

**[G]**
- Pods accept all traffic in both directions until a policy that selects them lists Ingress or Egress in `policyTypes` (`concepts/services-networking/network-policies.md:59-73`).
- Policies are additive: the result is the union of what they allow (`network-policies.md:75-77`).
- A connection needs **both** egress permission at the source **and** ingress permission at the destination (`network-policies.md:79-81`).
- Traffic from the pod's own node is always allowed (`network-policies.md:35-36, 70-71`).

**[C]** Apply default deny for both ingress and egress in the namespace (`network-policies.md:236-259`). Then explicitly allow:
- ingress from the load balancer or ingress source;
- egress to the database port;
- egress to DNS. Default-deny egress blocks all egress, and the docs give no DNS example, so the DNS rule has to be written and tested.

The database side needs a matching ingress rule.

**[P]** Enforcement requires a network plugin that supports NetworkPolicy. Without one, a policy object has no effect (`network-policies.md:16, 47-49`).

**[N]** Policies are applied eventually. A new pod may start unprotected, or with no connectivity at all for a short time (`network-policies.md:362-384`).

### 8. Is base64 enough for Secrets?

**No.** **[G]** Base64 is "obscured but not secret" (`concepts/configuration/secret.md:306-307`). Secrets are stored unencrypted in etcd by default. Anyone who can create a Pod or a Deployment in the namespace can read every Secret there (`secret.md:36-48`).

**Encryption at rest:**
- **[P]** It needs `--encryption-provider-config` with a provider other than `identity` listed first. `identity` gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:55-73`).
- **[C]** Existing Secrets must be rewritten to become encrypted (`encrypt-data.md:596-607`).

**RBAC:**
- **[G]** `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:93-98`).
- **[G]** Permission to create workloads implicitly gives access to Secrets, ConfigMaps and PVs that can be mounted, and to any ServiceAccount in the namespace (`rbac-good-practices.md:100-113`).

**[C]** Remove plaintext-equivalent Secrets from Git. Keep secret data out of the repository, for example with an external secret store (`secret.md:48`), and grant minimal `get` rights only.

### 9. StorageClass reclaim policy and the database volumes

**[G]**
- Dynamically provisioned PVs take the class's `reclaimPolicy`, which defaults to `Delete`. Pre-existing PVs keep the policy they were given (`concepts/storage/storage-classes.md:126-135`).
- So changing the class does not fix existing PVs; each one has to be patched (`concepts/storage/persistent-volumes.md:205-209`).
- **Retain:** after the PVC is deleted, the PV is kept as "Released" and must be reclaimed manually. The storage asset outlives deletion of the PV (`persistent-volumes.md:185-199`).
- **Delete:** removes both the PV and the external storage asset (`persistent-volumes.md:203-206`).
- Deleting a **PVC** is what triggers reclaim.
- By default, deleting or scaling down a **StatefulSet** does not delete its volumes (`concepts/workloads/controllers/statefulset.md:52-54`).
- `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`, default `Retain`) applies only to StatefulSet deletion or scale-down, not to node-failure replacement (`statefulset.md:391-423`).

**[C]** Use `Retain` for the database. Patch the existing PVs and verify them.

### 10. Prioritized rollout and validation checklist

1. Enable encryption at rest, rewrite existing Secrets, remove Secrets from Git, and tighten RBAC, including who can create workloads (Q8).
2. Set the database PVs and StorageClass to `Retain`, check each PV, and keep the default StatefulSet retention (Q9).
3. Set CPU requests on all containers and a memory limit. Confirm Metrics Server is running (Q5, Q6).
4. Add startup, readiness and liveness probes based on measured startup time (Q3).
5. Use `maxUnavailable: 0`, `maxSurge: 1` and `minReadySeconds`. Use a PDB with `maxUnavailable: 1` and `AlwaysAllow` (Q1).
6. Spread across zones as in Q2, and test drain and zone failure on a staging cluster.
7. Add `preStop` and a grace period sized to measured long requests (Q4).
8. Confirm the network plugin enforces NetworkPolicy, then apply default deny plus allows for DNS, the database and ingress. Test both ends of each connection (Q7).

**Limits that still need application or cluster validation:**
- **Request drain time vs grace period [N]:** whether long requests finish in time (`pod-lifecycle.md:572-577`).
- **Worst-case startup time [N]:** whether it fits the startup-probe budget (`configure-liveness-readiness-startup-probes.md:317-318`).
- **NetworkPolicy enforcement and timing [N]:** depends on the plugin; isolation is applied eventually (`network-policies.md:47-49, 380-384`).
- **Capacity during a zone outage [N]:** whether the surviving zones can hold the replicas, given Pending pods and node-autoscaler awareness of topology (`topology-spread-constraints.md:614-623`).
- **Node failure at the budget minimum [N]:** can still drop availability below five (`configure-pdb.md:148-155`).
- **Database failover, connection pooling, and HPA response under real load [N]:** not covered by these docs.