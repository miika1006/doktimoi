I checked the docs. Here is the memo.

---

# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs)

**Recommendation: do not approve as proposed.** Five items need to change before rollout: the rollout strategy, the grace period, Secret handling, networking, and the storage reclaim policy. In the answers, **[G]** marks a documented guarantee, **[C]** a configuration choice, **[P]** a prerequisite, and **[N]** something the docs do not establish. All paths are under `docs/`.

### 1. Does the PDB guarantee five replicas?
No. A PDB covers only voluntary evictions.
- **Node failure:** This is an involuntary disruption. A PDB cannot prevent it, but it still counts against the budget **[G]** (`concepts/workloads/pods/disruptions.md:26-34, 130-131`). The docs say plainly that a budget "does not truly guarantee" the minimum. A node failure while you are at 5 drops you to 4 (`tasks/run-application/configure-pdb.md:148-155`). By default, Pods also stay bound to an unreachable node for 300 s (`concepts/scheduling-eviction/taint-and-toleration.md:274-282`).
- **Node drain:** This goes through the Eviction API, so the PDB is honoured. With 6 replicas and `minAvailable: 5`, one Pod can be evicted at a time, and drain retries until it succeeds or times out **[G]** (`disruptions.md:107-121`; `configure-pdb.md:131-132`). Unhealthy Pods block drains under the default `IfHealthyBudget`. `AlwaysAllow` is the recommended setting **[C]** (`disruptions.md:138-141`; `configure-pdb.md:246-274`). Deleting Pods or Deployments directly bypasses PDBs (`disruptions.md:62-65`).
- **Rolling update:** Deployments are **not limited** by PDBs, although the Pods they take down do count against the budget (`disruptions.md:133-136`). `maxUnavailable: 2` lets availability fall to 4 (`concepts/workloads/controllers/deployment.md:1191-1199`). That breaks the five-replica goal and blocks drains while the rollout runs.
- **Recommended:** `maxUnavailable: 0` with `maxSurge: 1` **[C]**. `maxSurge` can be nonzero only because `maxUnavailable` is 0, and a percentage rounds up (`deployment.md:1194, 1203-1211`). Whether the cluster has room for the surge Pod is **[N]**.

### 2. Zone spreading
- Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1`.
- With `DoNotSchedule`, the skew is measured against the global minimum, and Pods that would break it stay unscheduled. With `ScheduleAnyway`, the constraint only ranks nodes (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93, 117-126`).
- **If a zone goes down:** domains are worked out from the nodes that exist, so a zone with no nodes is not counted (`:614-619`). If you set `minDomains: 3` and only two eligible zones remain, the global minimum becomes 0. That caps each zone at `maxSkew` Pods, and replacements stay Pending (`:95-115`). Without `minDomains`, replacements balance across the zones that are left.
- **Recommendation [C]:** zone `DoNotSchedule` with `maxSkew: 1` and no `minDomains`, plus a hostname constraint with `ScheduleAnyway`.
- Spreading is not kept up after Pods are removed, so scale-down can leave zones imbalanced **[G limitation]** (`:605-613`).

### 3. Probes for slow startup
- **Startup probe:** set `failureThreshold × periodSeconds` to cover the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). Liveness and readiness probes do not run until it succeeds (`:31-35, 398-402`; `concepts/workloads/pods/pod-lifecycle.md:492-497`).
- **Traffic stops** when readiness fails `failureThreshold` times. Ready becomes false and the Pod is removed from Service endpoints, but the container is not restarted (`probes:23-29, 412-422`; `pod-lifecycle.md:485-490`). Readiness runs for the whole container lifetime (`probes:360-362`).
- **Restart** happens when the startup or liveness probe exceeds `failureThreshold`, and the grace period is honoured (`probes:415-418`).
- Use a cheap liveness check with a higher threshold than readiness (`probes:19-21`). Keep database checks in readiness, not liveness (`pod-lifecycle.md:524-528`). A badly designed liveness probe can cause cascading restarts (`probes:37-48`).

### 4. Termination
- **Order:** the Pod is marked Terminating, then preStop runs, then the runtime sends TERM. preStop runs inside the grace period, and if it overruns, the kubelet allows a one-time 2 s extension. When the grace period expires, the runtime sends SIGKILL **[G]** (`pod-lifecycle.md:572-577, 584-610, 636-645`).
- **Endpoints:** at the same moment, terminating endpoints stay in EndpointSlices with `ready=false`, so they get no new regular traffic. They still report `serving` (`pod-lifecycle.md:612-632`; `concepts/services-networking/endpoint-slices.md:89-115`).
- **Is 30 s enough?** No. 30 s is only the default (`pod-lifecycle.md:594`). Any request still running at expiry is killed. If preStop needs more time, raise `terminationGracePeriodSeconds` (`:598-601`). Evictions honour this setting (`disruptions.md:143-145`). Set the period above the longest request plus the preStop time **[C]**. Whether the application drains cleanly on SIGTERM is **[N]**.

### 5. Resources
- **CPU limit:** a hard ceiling enforced by throttling. CPU overuse never kills a container (`concepts/configuration/manage-resources-containers.md:43-46, 252-257, 275-276`).
- **Memory limit:** enforced reactively by the OOM killer, which may kill the container. A Pod that uses more memory than it requested can be evicted when the node runs short (`:48-53, 261-273`).
- **CPU request:** acts as a weight when CPU is contested (`:255-257`).
- **HPA impact:** if any container has no CPU request, utilization is undefined and the HPA does nothing for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`). Set requests on every container, sidecars included **[P]**.

### 6. HPA behaviour
- The base formula is `ceil(current × ratio)`. Ratios within the 0.1 tolerance are skipped (`horizontal-pod-autoscale.md:131-147`).
- Pods being deleted or that have failed are ignored. Pods with missing metrics and Pods that are not yet ready are set aside. Missing Pods count as 100% usage on scale-down and 0% on scale-up. Not-yet-ready Pods count as 0% on scale-up (`:153-191`).
- The readiness windows default to 30 s and 5 min (`:167-178`). If these adjustments reverse the scaling direction or land inside the tolerance, the HPA does nothing (`:193-197`).
- HPA status shows the unadjusted utilization (`:199-202`).
- Scale-down uses the highest recommendation from the last **300 s** (`:213-218, 480-486`). Slow startup therefore delays scale-up from taking effect.
- The Metrics Server must be deployed separately **[P]** (`:113-118`).

### 7. Least-privilege networking
- A Pod is isolated in a direction only once some policy selects it with that direction in `policyTypes` (`concepts/services-networking/network-policies.md:51-73`).
- Policies are additive unions and never conflict (`:75-77`). A connection needs both egress allowed on the source and ingress allowed on the destination (`:79-81`).
- **Plan [C]:** default-deny for both ingress and egress (`:254`). Then allow ingress from the client or ingress tier only, egress to the database port only, and egress to DNS. The docs recommend allowing DNS alongside default-deny (`concepts/security/multi-tenancy.md:215-222`). The exact DNS selectors are **[N]**.
- **[P]:** without a network plugin that enforces policies, the objects have no effect (`network-policies.md:16, 45-49`; `multi-tenancy.md:231-234`).
- Policy application is eventually consistent, so new Pods may start unprotected or with no connectivity (`network-policies.md:362-384`). Traffic to and from the Pod's own node is always allowed (`:35-36`).

### 8. Secrets
- Base64 is not protection. It is "obscured but not secret" (`concepts/configuration/secret.md:306-307`). Committing it to Git exposes the values.
- Secrets are stored unencrypted in etcd by default (`secret.md:35-37`). Turn on encryption at rest with a first provider other than `identity` (`tasks/administer-cluster/encrypt-data.md:60-73`). Existing Secrets stay unencrypted until rewritten (`:140-142, 603-607`).
- Apply least-privilege RBAC to Secrets (`secret.md:42-48`).
- Anyone allowed to create Pods, or workloads such as a Deployment, can read every Secret in the namespace and use any ServiceAccount there (`secret.md:38-40`; `concepts/security/rbac-good-practices.md:100-113`).
- Keep the Secrets out of Git. How to replace them in the Git workflow is **[N]**.

### 9. Storage reclaim policy
- A StorageClass's `reclaimPolicy` defaults to `Delete` and applies to PVs it provisions dynamically (`concepts/storage/storage-classes.md:126-135`). Existing PVs keep the policy they got when created, so a changed class does not fix them. Patch each PV instead (`concepts/storage/persistent-volumes.md:201-210`).
- **Retain:** after the PVC is deleted, the PV becomes "released" and its data and storage asset remain. Reclaiming it is manual (`:185-199`).
- **Delete:** removes both the PV and the storage asset.
- **PVC deletion** triggers the reclaim policy (`:180-183`). **StatefulSet deletion or scale-down** does not delete PVCs by default (`concepts/workloads/controllers/statefulset.md:52-53`). `persistentVolumeClaimRetentionPolicy` defaults to `Retain` for both `whenDeleted` and `whenScaled`, and it needs the `StatefulSetAutoDeletePVC` gate (`:391-415, 423`). After a node failure, the replacement Pod reuses the existing PVC (`:417-421`).
- **Recommendation [C]:** `Retain` for database volumes.

### 10. Prioritized checklist
1. Enable encryption at rest, re-encrypt existing Secrets, remove Secrets from Git, and tighten RBAC for Secrets and Pod creation (Q8).
2. Set reclaim policy to `Retain` on the class and patch existing PVs. Confirm the StatefulSet PVC retention settings (Q9).
3. Rollout: `maxUnavailable: 0` and `maxSurge: 1`. Keep `minAvailable: 5`, add `unhealthyPodEvictionPolicy: AlwaysAllow`, and test a drain (Q1).
4. Add the startup, readiness and liveness probes, then measure worst-case startup (Q3).
5. Set the grace period above the longest request plus preStop. Load-test a termination (Q4).
6. Set CPU and memory requests on all containers and confirm the Metrics Server is running (Q5–6).
7. Confirm the network plugin enforces policies, then roll out default-deny plus allow rules including DNS, and test connectivity (Q7).
8. Add the zone spread constraint and run a zone-outage drill (Q2).

**Limits that still need application or cluster testing [N]:**
- Whether the cluster has capacity for surge Pods, and for replacements during a zone outage.
- Whether the application handles SIGTERM and drains long requests within the grace period.
- Real startup time compared with the probe budgets.
- Whether the network plugin enforces policies and how quickly they take effect.
- Whether the database stays consistent through failover. Nothing in these docs addresses it.
- Whether a node failure during a drain drops availability below 5. The docs say a PDB cannot prevent this.