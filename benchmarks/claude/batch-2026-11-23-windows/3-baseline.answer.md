I have the evidence I need and am writing the memo now.

# Decision memo: production API on Kubernetes v1.32

**Verdict: do not approve as proposed.** Four parts conflict with what the documentation says: the PDB and rollout settings, the 30-second grace period, base64 Secrets in Git, and default-allow networking. The storage plan also depends on a reclaim policy the design doesn't specify.

All paths are relative to `docs/`. Each point is labelled: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these documents.

---

### 1. Does the PDB guarantee five available replicas?

No, it guarantees five in none of the three cases.

- **Node failure:** this is an involuntary disruption (`concepts/workloads/pods/disruptions.md:21-34`). A PDB cannot prevent it, although it counts against the budget (`:130-131`). The docs say a budget "does not truly guarantee" the number. A node can fail while the app is already at its minimum (`tasks/run-application/configure-pdb.md:148-155`). **[G, a stated non-guarantee]**
- **Node drain:** `kubectl drain` goes through the Eviction API, which respects PDBs (`disruptions.md:107-121`). `minAvailable: 5` allows an eviction only if at least five healthy Pods remain (`configure-pdb.md:131-132`). This is the only case the PDB protects. However, if HPA ever scales the Deployment down to five, the budget allows zero evictions and drains never finish (`configure-pdb.md:157-161`). The default `IfHealthyBudget` policy can also block drains when Pods are unready (`configure-pdb.md:254-264`). The docs recommend `AlwaysAllow` (`disruptions.md:138-141`).
- **Rolling update:** Deployments are **not limited by PDBs** during rolling updates. Rollout safety comes from the Deployment's own strategy settings (`disruptions.md:133-136`). With `maxUnavailable: 2`, the Deployment may drop to 4 of 6 available Pods (`concepts/workloads/controllers/deployment.md:1191-1199`). That contradicts the intent of `minAvailable: 5`.

**Recommendation [C]:**
- Rollout: `maxUnavailable: 0` and `maxSurge: 1`. `maxUnavailable` may be 0 as long as `maxSurge` is not 0 (`deployment.md:1194`, `:1203-1206`).
- Add `minReadySeconds` so a Pod only counts as available after staying ready for a while (`deployment.md:1325-1328`).
- PDB: use `maxUnavailable: 1`, which the docs recommend (`configure-pdb.md:78`, `:175`), together with `unhealthyPodEvictionPolicy: AlwaysAllow`.
- Set HPA `minReplicas` to at least 6.

### 2. How should replicas be spread across zones?

- **topologyKey:** a node label. Nodes with the same value for that label form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`). Use `topology.kubernetes.io/zone`, plus a second constraint on `kubernetes.io/hostname`.
- **maxSkew:**
  - With `DoNotSchedule`, it is the largest allowed difference between any zone and the global minimum.
  - With `ScheduleAnyway`, the scheduler only gives preference to placements that reduce skew (`:82-93`).
- **DoNotSchedule** (the default) leaves a Pod Pending rather than break the constraint. **ScheduleAnyway** schedules it anyway and tries to minimise skew (`:124-126`).
- **matchLabelKeys: [pod-template-hash]** calculates the spread per revision, so old and new Pods are not mixed up during a rollout (`:134-159`).

**What happens when a zone is unavailable [N, so validate]:**
- Spread is not maintained when Pods are removed (`:607-611`).
- Domains are discovered only from nodes that exist. A zone with zero nodes is invisible to the scheduler (`:614-619`).
- With `DoNotSchedule`, `maxSkew: 1`, and `minDomains: 3` (`:107-115`), replacement Pods can stay Pending while a zone is down. That preserves the spread but loses capacity.

**Recommendation [C]:** use `ScheduleAnyway` for the zone constraint if capacity matters more than strict balance during an outage. Either way, test the behaviour with a zone actually down.

### 3. Which probes fit slow startup?

- **startupProbe:** set `failureThreshold × periodSeconds` to cover the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-318`). If it never succeeds, the container is killed after that budget (`:346-347`).
- **When the other probes start:** liveness and readiness probes don't begin until the startup probe succeeds (`:31-35`, `:398-402`).
- **When traffic stops:** a readiness failure sets `Ready=false` and the Pod is removed from Service load balancers. The container is **not** restarted (`:23-26`, `:419-422`). Readiness keeps running for the container's whole life (`:361`).
- **When a container restarts:** after `failureThreshold` consecutive liveness (or startup) failures (`:412-418`).
- **Recommended pattern:** point liveness at the same cheap endpoint as readiness, with a higher `failureThreshold` (`:19-21`). Keep database checks out of liveness. A database outage should make Pods unready, not restart them **[C]**.

### 4. Termination order, and is 30 seconds enough?

The sequence (`concepts/workloads/pods/pod-lifecycle.md:567-644`):
1. The Pod is marked Terminating, and the grace-period clock starts (`:584-589`).
2. `preStop` runs, and it runs **inside** the grace period. If it is still running when the period expires, the kubelet adds a one-off 2 seconds (`:591-601`).
3. TERM is sent to process 1 in each container (`:603-610`).
4. When the grace period expires, `SIGKILL` is sent to anything still running (`:573`, `:637-639`).

At the same time as step 1, the control plane starts removing the Pod from Service endpoints:
- Terminating endpoints stay in the EndpointSlice with `ready=false`, so they get no new regular traffic.
- A `serving` condition shows whether the Pod can still handle traffic while it drains (`:612-631`).

**Is 30 seconds enough? Not guaranteed.** 30 s is only the default (`:594`), and `preStop` time counts against it. For long requests, set `terminationGracePeriodSeconds` to at least preStop delay + longest request + margin, and handle SIGTERM in the app. **[C/N]** How quickly load balancers stop sending traffic is not established here.

### 5. CPU and memory requests and limits

- **Requests vs limits:** the kubelet reserves at least the request, and enforces the limit (`concepts/configuration/manage-resources-containers.md:18-22`).
- **CPU limits** are enforced by **throttling**. The container is slowed down, not killed (`:43-46`).
- **Memory limits** are enforced reactively by **OOM kills** (`:48-53`).
- **Missing request:** if only a limit is set, the limit is copied as the request (`:64-66`).
- **Effect on HPA:** utilization is calculated as a percentage of the request. If any container is missing the relevant request, utilization is undefined and HPA **takes no action** for that metric (`tasks/run-application/horizontal-pod-autoscale.md:90-102`).

**Recommendation [C]:** set CPU and memory requests on every container, and a memory limit. Decide on CPU limits deliberately, because throttling can make long requests slower.

### 6. HPA with missing metrics and not-ready Pods

- **Base formula:** `ceil(current × currentMetric/desiredMetric)`. HPA skips scaling when the ratio is within the 0.1 tolerance (`horizontal-pod-autoscale.md:131-147`).
- **Pods that are set aside or ignored:**
  - Pods being deleted are ignored, and failed Pods are discarded (`:156-158`).
  - Pods with missing metrics are set aside (`:160-161`).
  - For CPU, Pods that are not yet ready are also set aside (`:163-178`). This uses a 30 s initial-readiness delay and a 5-minute CPU initialization period.
- **Conservative recalculation:**
  - Missing-metric Pods are counted as using 100% of target when scaling down and 0% when scaling up (`:183-186`).
  - Not-ready Pods are counted as 0% when scaling up (`:188-191`).
  - If this flips the scaling direction, or lands inside the tolerance, HPA does nothing (`:193-197`).
  - The status shows the original, unadjusted average (`:199-202`).
- **Downscale stabilization:** HPA picks the highest recommendation from the last **5 minutes** (`:213-218`, `:480-484`). Scale-up has no stabilization window.

So actual scaling can be smaller, later, or absent compared with the raw ratio. Slow startup makes this worse.

### 7. Replace default-allow networking with least privilege

- **[P]** The network plugin must enforce NetworkPolicy. Without that, policy objects have no effect (`concepts/services-networking/network-policies.md:16`, `:45-49`).
- **Default:** Pods are non-isolated in both directions. A Pod becomes isolated for a direction once any policy selecting it lists that direction in `policyTypes` (`:59-73`).
- **Additive:** policies never conflict. The allowed set is the union of all applicable rules (`:75-77`).
- **Both ends:** a connection works only if the source allows it as egress **and** the destination allows it as ingress (`:79-81`).
- **Plan [C]:**
  1. Default-deny ingress and egress (`:214-259`).
  2. Allow ingress to the API from the ingress or Service clients.
  3. Allow egress from the API to the database Pods or CIDR, on the database port.
  4. Allow matching ingress on the database side.
  5. Allow **DNS egress**. Egress isolation blocks every outbound connection not listed, DNS included. That is an inference from `:62-65`; the corpus has no DNS-specific rule.
- **Limits:** policies cannot target Services by name or do TLS (`:438-459`). New Pods may briefly start without protection, or without connectivity (`:362-384`).

### 8. Is base64 enough for Secrets?

No. Base64 is "obscured but not secret" (`concepts/configuration/secret.md:306`).

- Secrets are stored **unencrypted** in etcd by default (`secret.md:36-37`).
- **Encryption at rest:** configure `--encryption-provider-config` with a provider other than `identity` listed first. `identity` gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:60-72`). Existing Secrets must be rewritten to become encrypted (`:592-603`).
- **RBAC:** grant least-privilege access to Secrets (`secret.md:42-48`). Remember that `list` and `watch` also reveal Secret contents (`concepts/security/rbac-good-practices.md:93-98`).
- **Pod creation permission matters:** anyone who can create Pods, or Deployments, in a namespace can read every Secret in it and act as any ServiceAccount there (`secret.md:38-40`; `rbac-good-practices.md:100-108`).

Remove plaintext Secrets from Git **[C]**. The docs suggest external secret stores (`secret.md:48`).

### 9. StorageClass reclaim policy

- Dynamically provisioned PVs take the class's `reclaimPolicy` when they are created. The default is **Delete** (`concepts/storage/storage-classes.md:126-135`).
- Existing PVs keep their policy. To change one, edit or patch the PV itself (`concepts/storage/persistent-volumes.md:203-210`). The corpus doesn't spell out what happens if the class itself is changed **[N]**; the only documented route is patching the PV.

**Retain vs Delete:**
- **Retain:** after the PVC is deleted, the PV is "released" and its data stays. An admin cleans up by hand (`persistent-volumes.md:185-198`).
- **Delete:** removes the PV and the backing storage asset (`:203-206`).

**PVC deletion vs StatefulSet deletion or scaling:**
- Deleting a PVC triggers the reclaim policy.
- Deleting or scaling down a StatefulSet does **not** delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`).
- `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default Retain) controls PVC cleanup. It applies only to deletion and scale-down, not to node failure (`statefulset.md:391-420`).

**Recommendation [C]:** use `Retain` for database volumes.

### 10. Prioritized rollout and validation checklist

1. Fix secrets: remove them from Git, enable encryption at rest and rewrite existing Secrets, tighten RBAC including Pod and Deployment creation rights. (Q8)
2. Set the database StorageClass and PVs to `Retain`, and check each existing PV's policy. (Q9)
3. Set the rollout to `maxUnavailable: 0`, `maxSurge: 1`, with `minReadySeconds`. Set the PDB to `maxUnavailable: 1` with `AlwaysAllow`. Set HPA `minReplicas` to at least 6. (Q1, Q6)
4. Add startup, readiness and liveness probes sized from measured startup times. (Q3)
5. Set `terminationGracePeriodSeconds` and a `preStop` hook from the measured longest request, and handle SIGTERM. (Q4)
6. Set requests on every container, and a memory limit. (Q5)
7. Add zone and host spread constraints with `matchLabelKeys`. (Q2)
8. Confirm the CNI enforces NetworkPolicy, then apply default-deny plus allows for DNS, the database and clients. (Q7)
9. Run a drain test, a rollout under load, and a simulated zone outage.

**Limits still to validate rather than assume:**
- The real startup time and the longest request time.
- Whether the CNI enforces NetworkPolicy, and how fast.
- How quickly load balancers stop sending traffic to terminating endpoints.
- Node-pool capacity, and autoscaler behaviour when a zone is unavailable.
- Availability and latency of Metrics Server (`horizontal-pod-autoscale.md:113-118`).
- The database's own failover, connection limits and backups. These documents establish nothing about them.

---

I can also publish this as a shareable page if you want to send it to the team.