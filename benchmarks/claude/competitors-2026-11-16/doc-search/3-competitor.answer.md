# Decision memo: production readiness review of the API Deployment

**Corpus:** the supplied Kubernetes v1.32 docs, under `C:\Users\miikame\AppData\Local\Temp\doktimoi-bench-3-competitor-CEpode\`. Paths below are relative to that folder and line ranges are inclusive. Each point is labelled **[G]** for a documented guarantee, **[C]** for a configuration choice, **[P]** for a prerequisite, or **[N]** for something these docs do not establish.

**Verdict:** Don't approve the design as proposed. The PDB, the rollout settings, the termination timing, networking and Secrets handling all need changes first.

---

### 1. Does the PDB guarantee five available replicas?

No, not in any of the three cases.

- **Node failure:** A PDB cannot prevent involuntary disruptions, although they still count against the budget **[G]** (`docs/concepts/workloads/pods/disruptions.md:130-131`). A budget "does not truly guarantee" that the stated number of Pods stays up (`docs/tasks/run-application/configure-pdb.md:148-155`).
- **Node drain:** The PDB is enforced here, through the Eviction API **[G]** (`disruptions.md:107-121`). Two things work against it:
  - With `minAvailable: 5` on 6 replicas, only one eviction is allowed at a time. If any Pod is unready, which is likely during a slow startup, zero evictions are allowed.
  - "Healthy" means `Ready=True` (`configure-pdb.md:236-240`). The default `IfHealthyBudget` policy can block a drain (`configure-pdb.md:246-257`, `157-161`).
- **Rolling update:** Deployments "are not limited by PDBs when doing rolling upgrades" **[G]** (`disruptions.md:133-136`). With `maxUnavailable: 2` the rollout can drop to 4 available Pods.

**Recommendation [C]:**
- Deployment: `maxUnavailable: 0` and `maxSurge: 1`. Both values cannot be 0 at the same time (`docs/concepts/workloads/controllers/deployment.md:1189-1199`).
- PDB: `maxUnavailable: 1` instead of `minAvailable: 5`, because it follows replica changes such as HPA scaling (`configure-pdb.md:174-176`).
- PDB: `unhealthyPodEvictionPolicy: AlwaysAllow` (`disruptions.md:138-141`).

### 2. Zone spreading

- `topologyKey: topology.kubernetes.io/zone` makes each zone one domain (`docs/concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- `maxSkew: 1` limits how far any zone's Pod count may exceed the global minimum. That keeps 6 replicas at 2/2/2 (`:82-93`).
- `DoNotSchedule` (the default) leaves a Pod unscheduled if placing it would break the constraint. `ScheduleAnyway` only prefers placements that reduce skew (`:124-126`).

**Zone loss:**
- Spreading is not maintained when Pods are removed **[G]** (`:607-611`).
- Domains are discovered from existing nodes, so a zone with zero nodes is not counted (`:614-619`).
- **[N]** The docs do not say exactly how `DoNotSchedule` behaves while a failed zone's nodes are still registered. Replacement Pods may stay Pending. Test this.
- Losing a zone that holds 2 of 6 Pods leaves 4, which is below the target of 5. Holding 5 or more through a zone loss needs at least 3 Pods per zone (9 replicas) **[C]**.

**Recommendation [C]:**
- A zone constraint with `maxSkew: 1`, `DoNotSchedule` and `matchLabelKeys: [pod-template-hash]` (`:134-148`).
- A hostname constraint with `ScheduleAnyway`.
- Don't rely on the built-in defaults. They are only `ScheduleAnyway`, with `maxSkew` 5 for zones (`:536-547`).

### 3. Probes for slow startup

- **Startup probe:** Give it the same endpoint as liveness, with `failureThreshold × periodSeconds` covering the worst-case startup. For example, 30 × 10 s allows 300 s (`docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **When the other probes begin:** All other probes are disabled until the startup probe succeeds, and their delays start only after that **[G]** (`docs/concepts/workloads/pods/pod-lifecycle.md:492-497`; `probes.md:398-402`).
- **When traffic stops:** A failed readiness probe removes the Pod from Service endpoints. The container is not restarted, and readiness keeps being checked for the Pod's whole life **[G]** (`pod-lifecycle.md:485-490`; `probes.md:360-362`, `412-422`).
- **When the container restarts:** After `failureThreshold` consecutive liveness or startup failures, the container restarts under its restart policy **[G]** (`probes.md:412-418`; `pod-lifecycle.md:479-483`).
- **Database dependency:** A readiness probe may check backend dependencies (`pod-lifecycle.md:524-528`). **[N]** Whether that is safe when the shared database fails is not established. It could mark all 6 replicas unready at once.

### 4. Termination order

1. The Pod is marked Terminating and the grace-period deadline is recorded.
2. The `preStop` hook runs. If it is still running when the grace period expires, the kubelet gives a one-off 2-second extension (`pod-lifecycle.md:584-601`).
3. SIGTERM (or the image's STOPSIGNAL) is sent to each container's main process.
4. When the grace period expires, SIGKILL is sent (`:572-577`, `603-610`, `636-639`).

In parallel with this, the terminating Pod's endpoints are marked `ready: false`, so load balancers stop sending it regular traffic. The `serving` condition remains available for draining (`:612-632`).

**Is 30 seconds enough? No [G].** The `preStop` hook uses up part of the grace period, and SIGKILL ends whatever is still running (`:596-601`, `637-639`). Set `terminationGracePeriodSeconds` above `preStop` time plus your longest request time **[C]**. **[N]** The actual maximum request duration is an application fact the docs cannot supply.

### 5. CPU, memory and HPA

- Requests are used for scheduling. A container may use more than its request when the node has spare capacity (`docs/concepts/configuration/manage-resources-containers.md:28-34`).
- A CPU limit is enforced by throttling. A memory limit is enforced reactively by OOM kills (`:43-53`).
- If only a limit is set, it is copied as the request (`:63-67`).
- If any container lacks a CPU request, CPU utilization is undefined and the **HPA takes no action** for that metric **[G]** (`docs/tasks/run-application/horizontal-pod-autoscale.md:99-102`).

**Recommendation [C]:** Set CPU and memory requests on every container. Size the memory limit from measured peak usage.

### 6. HPA behaviour

- The base formula is `ceil(current × currentMetric / desiredMetric)`, with a ±0.1 tolerance (`hpa.md:131-147`).
- Pods being deleted are ignored, and failed Pods are discarded (`:153-158`).
- Pods with missing metrics, and not-yet-ready Pods when scaling on CPU, are set aside (`:160-178`).
- Missing metrics are then assumed to be 100% of target on scale-down and 0% on scale-up. Not-yet-ready Pods are assumed to be 0% (`:183-191`).
- If that adjustment reverses the scaling direction, or lands within tolerance, the HPA does nothing (`:193-197`).
- The status still reports the raw, unadjusted utilization (`:199-202`).
- Scale-down uses the highest recommendation from a 300-second window (`:213-218`, `455-483`).

So actual scaling can differ from the raw ratio. Slow-starting Pods damp scale-up, and scale-down lags by about five minutes.

### 7. Least-privilege networking

- **Isolation:** A Pod becomes isolated for ingress or egress only when some policy selects it with that policy type. After that, only what the rules allow gets through **[G]** (`docs/concepts/services-networking/network-policies.md:51-73`).
- **Additive policies:** Policies combine as a union, and evaluation order doesn't matter (`:75-77`).
- **Both ends:** The source's egress and the destination's ingress must both allow a connection (`:79-81`).
- **Exceptions:** Traffic to and from the Pod's own node is always allowed (`:35-36`, `70-71`).
- **CNI support [P]:** Without a plugin that enforces NetworkPolicy, the policies have no effect (`:45-49`, `92-95`).

**Recommendation [C]:** Default-deny ingress and egress (`:208-242`). Then allow:
- ingress from the load balancer or ingress Pods on the API port;
- egress to the database on its port.

**DNS [N]:** The retrieved passages give no DNS example. It follows from egress isolation that DNS egress must be allowed explicitly.

### 8. Secrets

Base64 is not protection. Secrets are stored **unencrypted in etcd by default**. Anyone with API or etcd access can read them, and anyone allowed to create Pods, even indirectly through a Deployment, can read every Secret in that namespace **[G]** (`docs/concepts/configuration/secret.md:35-48`).

**Required:**
- encryption at rest **[P]**;
- least-privilege RBAC on Secrets;
- restricting Secret access to specific containers;
- tight control of Pod and Deployment create rights;
- considering an external secret store (`:42-48`).

**[N]** These docs don't cover keeping Secret manifests in Git. Treat committed base64 values as plaintext and remove them.

### 9. Reclaim policy

- A StorageClass's `reclaimPolicy` is applied when a PV is dynamically provisioned, and it defaults to `Delete` (`docs/concepts/storage/storage-classes.md:34-40`, `126-135`).
- Existing PVs must be "edited or patched after [they are] created" (`docs/concepts/storage/persistent-volumes.md:201-210`). That implies changing the class does not rewrite existing PVs **[G, by inference]**.
- **Retain:** When the PVC is deleted, the PV becomes Released and the data stays until an admin cleans it up (`:185-199`).
- **Delete:** Both the PV and the backing storage asset are removed (`:201-205`).
- **StatefulSet:** Deleting or scaling down a StatefulSet does not delete its PVCs by default (`Retain`). `whenDeleted` and `whenScaled` can change that, and they apply only to deletion and scale-down, not to node failure (`docs/concepts/workloads/controllers/statefulset.md:391-423`).

So deleting a PVC triggers the reclaim policy, while deleting a StatefulSet does not delete PVCs unless its policy says so.

**Recommendation [C]:** Use `Retain` for database volumes, and patch the existing PVs individually.

### 10. Prioritized rollout and validation checklist

1. Encrypt Secrets at rest, scope RBAC (including Pod-create rights), and remove base64 Secrets from Git.
2. Confirm the CNI enforces NetworkPolicy. Then apply default-deny plus explicit allows, including DNS.
3. Set CPU and memory requests and confirm the HPA reports utilization.
4. Add a startup probe, a readiness probe and a conservative liveness probe.
5. Set `maxUnavailable: 0` / `maxSurge: 1` on the Deployment, and the PDB to `maxUnavailable: 1` with `AlwaysAllow`.
6. Add the zone and hostname spread constraints, and consider 9 replicas.
7. Set a `preStop` hook and a grace period sized to the longest request.
8. Patch database PVs to `Retain` and set the StatefulSet PVC retention policy.

**Limits that still need application or cluster validation:**
- The real worst-case startup time and request duration (§3, §4).
- Pod scheduling during a zone outage with `DoNotSchedule`, tested with a game day (§2).
- Whether the provider's drain tooling respects PDBs (`configure-pdb.md` prerequisites; `disruptions.md:107-109`).
- Whether a database outage causes cluster-wide unreadiness (§3).
- That Metrics Server is installed (`hpa.md:113-118`).
- CNI support for egress and port rules (§7).