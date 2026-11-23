I've collected sources for all ten questions. Here is the memo.

# Decision memo: production review of the API Deployment (Kubernetes v1.32 docs)

**Verdict:** Don't approve as proposed. Two parts conflict with what the docs say: the rollout setting (`maxUnavailable: 2`) breaks the 5-replica goal, and Secrets kept in Git as plain base64 are not protected. The 30-second grace period and default-allow networking are choices the team has not yet shown to be safe. All paths below are relative to `docs/`.

---

### 1. Does the PDB guarantee five available replicas?

**No, not in any of the three cases.**

- **Node failure (involuntary):** A PDB cannot prevent involuntary disruptions; they only count against the budget (`concepts/workloads/pods/disruptions.md:130-131`).
- **Node drain (voluntary):** Here the PDB does apply. `kubectl drain` uses the Eviction API, which may reject a request and retry until a timeout (`disruptions.md:99-121`). With 6 replicas and `minAvailable: 5`, one eviction is allowed at a time. By default the drain waits until the Pods are healthy. The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy (`disruptions.md:138-141`).
- **Rolling update:** Pods taken down by a rollout count against the budget, but "Deployment and StatefulSet are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). `maxUnavailable` is rounded down, and with it set to 2, availability may drop to 4 (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommendation:** Set `maxUnavailable: 0` and `maxSurge: 1`. `maxSurge` cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1201-1206`). Keep `minAvailable: 5` only if the cluster has spare capacity for the surge Pod. The docs do not establish how long a drain takes with this budget.

### 2. Spreading replicas across zones

Use `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1` and `whenUnsatisfiable: DoNotSchedule`. That gives 2/2/2.

- **maxSkew:** With `DoNotSchedule`, this is the largest allowed difference from the global minimum. With `ScheduleAnyway`, the scheduler only prefers placements that reduce skew. `DoNotSchedule` is the default (`concepts/scheduling-eviction/topology-spread-constraints.md:76-126`).
- **Pending Pods:** With `DoNotSchedule`, a Pod that can't satisfy the constraint stays Pending (`topology-spread-constraints.md:262-333`).
- **Defaults:** Without explicit constraints, the built-in default only does zone `maxSkew: 5` with `ScheduleAnyway` (`topology-spread-constraints.md:532-578`).
- **Losing a zone:** The docs do not say exactly what happens. They do say three things (`topology-spread-constraints.md:605-623`):
  - Zones are discovered only from nodes that currently exist.
  - The constraint is not guaranteed to hold after Pods are removed.
  - A rebalancing tool is needed to restore the spread.

**Choice:** `DoNotSchedule` protects the spread but can leave replacement Pods Pending. `ScheduleAnyway` keeps capacity up but lets the spread drift. Test a zone outage either way.

### 3. Probes for slow startup

- **startupProbe:** Give it the same check as liveness, with `failureThreshold × periodSeconds` covering the worst-case startup time. In the docs' example, 30 × 10 gives 300 s. If it never succeeds, the container is killed and its restart policy applies (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). Liveness and readiness do not start until it succeeds (`concepts/workloads/pods/pod-lifecycle.md:474-500`; `configure-liveness-readiness-startup-probes.md:1-41`).
- **When traffic stops:** When readiness fails, the Pod's IP is removed from the Service endpoints. Readiness runs for the container's whole life (`pod-lifecycle.md:474-500`; `configure-liveness-readiness-startup-probes.md:349-388`).
- **When the container restarts:** Only when liveness fails (`pod-lifecycle.md:474-500`). Point liveness at real deadlocks only, not at the database being down. A higher `failureThreshold` on liveness means the Pod is marked not-ready before it gets killed (`configure-liveness-readiness-startup-probes.md:1-41`).

### 4. Termination order

1. The Pod is marked Terminating with a deadline (`pod-lifecycle.md:584-590`).
2. The grace-period clock starts *before* preStop runs (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`).
3. preStop runs. If it is still running at the deadline, the kubelet adds a one-time 2-second extension (`pod-lifecycle.md:591-601`).
4. SIGTERM goes to process 1 in each container, in arbitrary order across containers (`pod-lifecycle.md:603-610`).
5. When the grace period expires, SIGKILL is sent (`pod-lifecycle.md:636-645`).

**Endpoints:** At the same time, endpoints for the terminating Pod are marked `ready: false`. Draining has to use the `serving` condition (`pod-lifecycle.md:612-634`; `concepts/services-networking/endpoint-slices.md:100-117`).

**Is 30 s guaranteed?** No. 30 s is just the default, and preStop time comes out of it. Requests longer than the remaining time get SIGKILL. Set `terminationGracePeriodSeconds` to at least preStop time + the longest request + a margin, and measure it.

### 5. Resources and HPA

- **CPU limits** are enforced by throttling.
- **Memory limits** are enforced reactively by the OOM killer (`concepts/configuration/manage-resources-containers.md:27-67`).
- **Limit without a request:** Kubernetes copies the limit into the request (same lines).
- **CPU limits and autoscaling:** CPU limits "can have unintended effects on auto-scaling features," and a memory limit above the request can expose the node to OOM (`concepts/security/security-checklist.md:138-152`).
- **Missing CPU requests:** HPA utilization is a percentage of the request. If any container in the Pod lacks a request, utilization is undefined and HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-121`).

**Requirement:** Set a CPU request on every container, including sidecars. Set memory request equal to memory limit.

### 6. How HPA treats missing metrics and not-yet-ready Pods

- **Basic rule:** desired = ceil(current × ratio). The default tolerance is 0.1.
- **Excluded Pods:** Pods being deleted are ignored and failed Pods are discarded. Pods with missing metrics, and (for CPU) Pods that are not yet ready, are set aside (`horizontal-pod-autoscale.md:123-165`).
- **Recalculation:** Missing Pods are assumed to use 100% of target when scaling down and 0% when scaling up. Not-yet-ready Pods are assumed to use 0% when scaling up. If the recalculated ratio reverses direction or falls within the tolerance, nothing happens (`horizontal-pod-autoscale.md:167-202`).
- **Timing flags:** The initial-readiness delay defaults to 30 s and the CPU initialization period to 5 minutes. Both matter for slow startup (same lines).
- **Scale-down window:** The default stabilization window is 300 s (`horizontal-pod-autoscale.md:455-486`).
- **Status display:** HPA status shows the original, unadjusted utilization (`horizontal-pod-autoscale.md:167-202`).

### 7. Least-privilege networking

Pods accept all ingress and egress until a policy selecting them lists that direction in `policyTypes`. Allow rules add together, and order doesn't matter. A connection needs both the source's egress and the destination's ingress to allow it (`concepts/services-networking/network-policies.md:45-81`).

**Plan:**
- Default-deny ingress and egress (`network-policies.md:234-262`).
- Allow ingress from the clients and the ingress controller.
- Allow egress to the database's labels and port. Also allow the database's ingress from the API.
- Allow DNS explicitly. The deny-egress policy blocks *all* egress, but the docs I searched have no DNS example, so the rule must be tested.

**Prerequisite:** Without a CNI plugin that implements NetworkPolicy, policies have no effect (`network-policies.md:45-49`). There are also no deny rules, no TLS, no logging, and no blocking of node or localhost traffic (`network-policies.md:438-462`).

### 8. Is base64 enough for Secrets?

**No.** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them. Anyone who can create Pods or Deployments in the namespace can read every Secret there (`concepts/configuration/secret.md:35-53`).

**Required steps** (same lines):
- Encryption at rest (`tasks/administer-cluster/encrypt-data.md:1-32`; `tasks/administer-cluster/securing-a-cluster.md:251-265`).
- Least-privilege RBAC.
- Limit Secret access to specific containers.
- Consider an external Secret store.

**Why Pod creation matters:** Permission to create workloads indirectly grants their Secrets, ConfigMaps, PVs and any ServiceAccount's permissions, so restrict it and enforce a Pod Security Standard (`concepts/security/rbac-good-practices.md:100-120`).

**Git:** The docs don't cover Git storage directly. Treat base64 in Git as plaintext.

### 9. Changing the StorageClass reclaim policy

- **Existing PVs:** Dynamically provisioned PVs *inherit* the StorageClass's policy, which defaults to Delete. If that's wrong, the PV itself "must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). So changing the class doesn't protect existing PVs; patch each one.
- **Retain:** After the PVC is deleted, the PV becomes Released. It isn't reused, and cleanup is manual (`persistent-volumes.md:185-199`).
- **Delete:** Removes both the PV and the storage asset behind it (`persistent-volumes.md:201-210`).
- **StatefulSet:** PVCs are kept by default when the set is deleted or scaled down. `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`) can change that, and needs the `StatefulSetAutoDeletePVC` feature gate. It doesn't apply when a Pod is replaced after node failure (`concepts/workloads/controllers/statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`).
- **What deletes data:** Deleting a PVC under Delete deletes the data. Deleting or scaling down the StatefulSet doesn't, unless the policy says so.

### 10. Prioritized checklist

1. Patch the database PVs to Retain and confirm backups.
2. Enable encryption at rest, remove plaintext Secrets from Git, and restrict Secret and Pod-creation RBAC.
3. Set `maxUnavailable: 0` and `maxSurge: 1`. Verify there's room for the surge Pod under the spread constraint.
4. Add the startup probe (budget at least worst-case startup), a readiness probe, and a conservative liveness probe.
5. Set CPU requests on every container. Make an explicit, tested decision on CPU limits. Set memory request = memory limit.
6. Size the grace period and preStop, then test that `serving`-based draining works.
7. Confirm the CNI enforces NetworkPolicy. Then apply default-deny plus allow rules (clients, database, DNS) and test from both ends.
8. Add the zone spread constraint and the PDB with `AlwaysAllow`. Run a drain and a zone-outage drill.

**Limits these docs don't guarantee, which you still need to test:**
- **Zone outage:** 2 Pods are lost and the PDB can't prevent it, so capacity drops to 4.
- **Grace period:** Whether the grace period covers the longest request.
- **DNS:** That DNS egress works under default-deny.
- **Database:** The database's behavior and connection limits during scale-out and reconnects. The docs don't cover them.
- **Autoscaling:** Whether CPU is the right scaling signal for long requests.
- **Drain time:** How long drains take with one eviction at a time.