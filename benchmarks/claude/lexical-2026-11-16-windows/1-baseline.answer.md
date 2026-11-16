# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs)

**Verdict: do not approve as proposed.** Four parts of the design conflict with what the docs state: the PDB/rollout pairing, the default 30 s grace period for long requests, default-allow networking, and base64 Secrets in Git. All paths below are relative to `docs/`.

**Labels used:** **G** = documented guarantee, **C** = configuration choice, **P** = prerequisite, **N** = not established by these docs.

---

### 1. Does the PDB keep five replicas available?

**No, in none of the three cases.**

- **Node failure:** this is an involuntary disruption (`concepts/workloads/pods/disruptions.md:26-34`). PDBs "cannot prevent" these, although they "do count against the budget" (`:130-131`). **G:** no protection here.
- **Node drain:** this is voluntary (`:50`). `kubectl drain` goes through the Eviction API, which respects the PDB and retries rejected evictions (`:107-116`). With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time (same logic as `:118-121`). If one node holds two replicas, the drain will block until a replacement becomes Ready, as the walkthrough shows (`:195-214`).
  - By default, unhealthy Pods can be evicted only when the budget is met (`reference/kubernetes-api/policy-resources/pod-disruption-budget-v1.md:85-89`). The docs recommend `AlwaysAllow` (`disruptions.md:138-141`).
  - Deleting Pods or Deployments directly bypasses the PDB (`:62-64`).
- **Rolling update:** rollout disruptions count against the budget, but Deployments "are not limited by PDBs when doing rolling upgrades" (`:133-136`). `maxUnavailable: 2` lets availability drop to 4 (`concepts/workloads/controllers/deployment.md:1191-1199`).

**Recommendation (C):** `maxUnavailable: 0`, `maxSurge: 1` (or 2). This is valid because only one of the two may be 0 (`:1194`, `:1205`). Also set `minReadySeconds` and `progressDeadlineSeconds` (`:1314-1325`). Keep `minAvailable: 5`, or use 4 if drains need more room. Add `unhealthyPodEvictionPolicy: AlwaysAllow`.

### 2. Zone spreading

- `topologyKey` is a node-label key; each key/value pair is one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`). Use `topology.kubernetes.io/zone` (example at `:527-529`).
- `maxSkew` is the largest allowed difference from the global minimum. It must be greater than 0 (`:82-91`).
- `DoNotSchedule` (the default) refuses to place a Pod that would break the constraint. `ScheduleAnyway` places it anyway and only prefers lower skew (`:124-126`).
- `minDomains` works only with `DoNotSchedule`. If fewer domains exist than `minDomains`, the global minimum is treated as 0 (`:107-115`).

**Recommendation (C):** zone constraint with `maxSkew: 1` and `DoNotSchedule`, which gives 2/2/2 across three zones. Add a hostname constraint with `ScheduleAnyway` (pattern at `:541-546`).

**When a zone is unavailable:**
- **N:** the docs do not give a full worked case for a zone outage.
- **G:** domains come only from existing nodes (`:614-619`).
- **G:** Pods on tainted nodes still count toward the spread (`:612`).
- **G:** a constraint can be violated after Pods are removed (`:607-608`).

So `DoNotSchedule` may leave replacement Pods Pending. If the team prefers capacity over even spread, use `ScheduleAnyway` or a larger skew (`:345-350`, `:422-423`). This trade-off has to be tested.

### 3. Probes for slow startup

- **startupProbe (C):** set `failureThreshold × periodSeconds` to cover the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-318`). Until it succeeds, all other probes are disabled (`concepts/workloads/pods/pod-lifecycle.md:492-497`).
  - If it never succeeds, the container is killed after the window and the restart policy applies (`configure-liveness-readiness-startup-probes.md:342-347`).
- **Liveness probe:** takes over after startup succeeds (`:344-345`). A failure kills the container (`pod-lifecycle.md:479-483`).
- **Readiness probe:** a failure removes the Pod from Service endpoints but does not restart it (`:485-490`; `configure-liveness-readiness-startup-probes.md:419`). It runs for the container's whole life (`:361`).
- **G:** readiness and liveness do not depend on each other (`:364-368`).

**Summary:** traffic stops when readiness fails. A restart happens when liveness or startup fails.

### 4. Termination order and the 30 s grace period

1. The Pod is marked Terminating.
2. `preStop` runs, and it counts against the grace period. If it is still running when the period expires, the kubelet adds a one-off 2 s extension (`pod-lifecycle.md:584-601`).
3. TERM is sent to PID 1. The order across containers is arbitrary (`:603-610`).
4. At the same time, the control plane starts removing the Pod from EndpointSlices (`:612-617`). Terminating endpoints stay listed with `ready: false`; the `serving` condition supports draining (`:624-632`).
5. When the grace period ends, SIGKILL is sent (`:637-639`; `:572-573`).

The default grace period is 30 s (`:594`). Eviction honours it (`disruptions.md:143-145`).

**Is 30 s enough?** Not guaranteed. Nothing in the docs ensures long requests finish within it. `preStop` time also uses up the same budget. **C:** raise `terminationGracePeriodSeconds` above the worst-case request time plus `preStop` time.

### 5. Resources

- **CPU limit:** a hard limit enforced by throttling (`concepts/configuration/manage-resources-containers.md:43-46`; `:252-254`).
- **CPU request:** acts as a weight when CPU is contended (`:255-257`).
- **Memory limit:** enforced reactively by OOM kills (`:48-53`). If PID 1 is killed, the container is restarted (`:261-265`).
- **Summary:** going over a CPU limit makes the container slower; going over a memory limit can kill it.
- **HPA impact:** utilization is measured as a percentage of the request. If any container lacks a CPU request, utilization is undefined and the HPA "will not take any action for that metric" (`tasks/run-application/horizontal-pod-autoscale.md:89-101`).
- **P:** every container, sidecars included, needs a CPU request.

### 6. HPA behaviour

- **Basic formula:** desired replicas = ceil(current × ratio). If the ratio is within the 0.1 tolerance, no action is taken (`horizontal-pod-autoscale.md:131-147`).
- **Ignored Pods:** Pods being deleted are ignored and failed Pods are discarded (`:156-158`).
- **Set aside:** Pods with missing metrics, and Pods that are not yet Ready (on CPU), are set aside (`:160-165`).
  - "Not yet ready" depends on a 30 s initial readiness delay and a 5-minute CPU initialization period (`:167-178`). This matters for a slow-starting app.
- **Conservative recalculation:** missing Pods are assumed to use 100% on scale-down and 0% on scale-up. Not-ready Pods are assumed to use 0% on scale-up. If the recalculated ratio reverses direction or falls within tolerance, the HPA does nothing (`:183-197`).
- **Status:** the reported status shows the raw, unadjusted value (`:199-202`).
- **Multiple metrics:** if some metrics are missing and the rest suggest a scale-down, the scale-down is skipped (`:204-211`).
- **Downscale stabilization:** default 300 s. The HPA uses the highest recommendation within that window (`:213-218`; `:480-484`). Scale-up has no stabilization window.

### 7. Least-privilege networking

- **P:** a network plugin that enforces NetworkPolicy. Without one, policies "will have no effect" (`concepts/services-networking/network-policies.md:16`, `:47-49`).
- **Isolation:** a Pod is isolated for a direction (ingress or egress) only when a policy selects it with that type in `policyTypes`. Replies are implicitly allowed (`:59-73`).
- **Additive:** policies combine as a union, and evaluation order does not matter (`:75-77`).
- **Both ends:** the source's egress and the destination's ingress must both allow a connection (`:79-81`). API→DB needs API egress and DB ingress.
- **Plan (C):**
  1. Apply default-deny for ingress and egress (`:214-268`).
  2. Allow ingress from the load balancer or ingress controller.
  3. Allow egress to the DB port.
  4. Allow egress to DNS.
- **N:** this page does not document a DNS egress rule. That DNS must be allowed explicitly is an inference from egress isolation.
- **N:** deny-all is guaranteed only for TCP, UDP and SCTP (`:275-279`).
- **N:** enforcement is not immediate after a policy is created (`:362-394`).

### 8. Secrets

**Base64 is not protection.** Values are "obscured but not secret" (`concepts/configuration/secret.md:306`).

- Secrets are stored unencrypted in etcd by default. Anyone with API access or etcd access can read them (`:36-37`).
- Anyone allowed to create a Pod, or a Deployment, in a namespace can read every Secret in that namespace (`:38-40`; `concepts/security/rbac-good-practices.md:100-108`). Creating workloads also gives access to that namespace's service-account permissions.
- **Required steps:** encryption at rest, least-privilege RBAC, limiting which containers get Secrets, and considering an external store (`secret.md:42-48`).
- **Encryption config:** the `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:64-66`). Existing Secrets must be rewritten after encryption is enabled (`:590-603`).
- **N:** Git exposure is outside these docs, but base64 values committed to Git are effectively plaintext. Remove them.

### 9. Storage reclaim policy

- A dynamically provisioned PV inherits the class's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`).
- **Changing the StorageClass later does not change existing PVs.** Existing PVs keep their policy and must be patched individually (`concepts/storage/persistent-volumes.md:205-210`). The docs don't say outright that a class edit leaves existing PVs alone; that follows from "must be edited or patched".
- **Retain:** deleting the PVC leaves a "Released" PV. Cleanup is manual, and the storage asset survives deletion of the PV (`:185-199`).
- **Delete:** removes both the PV and the backing asset (`:201-205`).
- **StatefulSets:** deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). The `whenDeleted` and `whenScaled` policies (default `Retain`) apply only in those two situations (`:397-423`). PVC deletion is a separate event that triggers the PV reclaim policy.
- **Recommendation (C):** use `Retain` for the database's storage.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** remove them from Git, rotate them, enable non-identity encryption at rest and rewrite existing Secrets. Restrict `get`/`list` on Secrets and the right to create workloads.
2. **Resources:** set CPU and memory requests on all containers, set memory limits, and decide whether a CPU limit is acceptable given throttling.
3. **Probes:** add a startupProbe sized to the measured worst-case startup, plus separate readiness and liveness checks.
4. **Rollout:** `maxUnavailable: 0`, `maxSurge: 1`, plus `minReadySeconds` and `progressDeadlineSeconds`.
5. **Termination:** a `preStop` delay, a grace period longer than the longest request, and app-level SIGTERM draining.
6. **Spread:** zone constraint with `maxSkew: 1`; choose between DoNotSchedule and ScheduleAnyway and test it.
7. **PDB:** `minAvailable: 5` (or 4) with `AlwaysAllow`. Run a drain drill per zone.
8. **Network:** confirm the network plugin enforces NetworkPolicy, then apply default-deny and the allow rules, testing both ends and DNS.
9. **Storage:** set `Retain` on the database StorageClass and patch existing PVs.
10. **HPA:** test scaling with a slow startup and the 300 s scale-down window.

**Limits that still need application or cluster validation (N):**
- Whether in-flight requests actually finish within the grace period, and how quickly the load balancer stops sending traffic to terminating endpoints (`pod-lifecycle.md:619-632`).
- Scheduling and capacity during a full zone outage, and with node pools scaled to zero (`topology-spread-constraints.md:614-619`).
- NetworkPolicy behaviour and timing on the specific CNI (`network-policies.md:275-279`, `:380-394`).
- Which other voluntary disruptions the provider runs (`disruptions.md:58-59`).
- Whether the storage plugin supports `Delete` and protects data (`persistent-volumes.md:203`).
- Database connection limits as the HPA adds replicas. **N:** not covered by these docs.