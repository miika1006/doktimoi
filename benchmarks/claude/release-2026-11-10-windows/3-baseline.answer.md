# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs)

**Verdict:** Do not ship the design as written. Four parts conflict with the supplied docs: `minAvailable: 5` combined with `maxUnavailable: 2`, the fixed 30-second grace period for long requests, default-allow networking, and plain base64 Secrets in Git. The storage reclaim behaviour also has to be set on purpose.

All paths are relative to `docs/`. Each point is marked as a **Guarantee** (what the docs promise), a **Config** (a setting the team chooses), a **Prereq** (something that must already be true), or a **Gap** (something the docs do not establish).

---

### 1. Does the PDB guarantee five replicas?

No, it does not in any of the three cases.

- **Node failure.** Hardware loss, kernel panic and network partition are involuntary disruptions (`concepts/workloads/pods/disruptions.md:21-35`). **Guarantee:** a PDB cannot prevent them, but they still count against the budget (`disruptions.md:130-131`). If you lose a zone holding 2 of the 6 Pods, you are left with 4.
- **Node drain.** `kubectl drain` uses the Eviction API, which does respect the PDB and retries rejected evictions (`disruptions.md:107-121`). With 6 replicas, at most 1 Pod can be evicted at a time. By default, Pods that are not healthy block the drain (`IfHealthyBudget`); `AlwaysAllow` is the recommended setting (`disruptions.md:138-141`; `tasks/run-application/configure-pdb.md:242-275`). The protection only holds for tools that call the Eviction API (**Prereq**).
- **Rolling update.** Pods taken down by a rollout count against the budget, but Deployments are not limited by PDBs (`disruptions.md:133-136`). `maxUnavailable: 2` lets the rollout drop to 4 available Pods (`concepts/workloads/controllers/deployment.md:1191-1199`). That breaks the PDB's intent and blocks any drain while the rollout runs.

**Recommendation (Config):**
- Set `maxUnavailable: 0` and `maxSurge: 1` (or 2). The surge cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1203-1211`).
- Set `minReadySeconds` (`deployment.md:1325-1328`) and `progressDeadlineSeconds` (`deployment.md:1314-1321`).
- Reserve capacity for the surge Pods (`deployment.md:329-330`).
- Note that `minAvailable` and `maxUnavailable` cannot both be set on one PDB (`configure-pdb.md:125`).

### 2. Zone spreading

**How the fields work:**
- `topologyKey` names a node label. Each distinct value of that label is one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- With `DoNotSchedule`, `maxSkew` is the largest allowed difference from the global minimum. With `ScheduleAnyway`, the scheduler only prefers placements that reduce skew (`topology-spread-constraints.md:82-93`).
- `DoNotSchedule` is the default and leaves the Pod unscheduled if the constraint cannot be met (`topology-spread-constraints.md:124-126`).

**Config:** use `topology.kubernetes.io/zone`, `maxSkew: 1`, `DoNotSchedule`, which gives 2/2/2 Pods per zone. Add a hostname constraint with `ScheduleAnyway`.

**When a zone is unavailable:**
- Domains are discovered from existing nodes. A zone with no nodes at all is not considered (`topology-spread-constraints.md:614-619`).
- Pods on tainted nodes are still counted (`:612`). The default `nodeTaintsPolicy` is `Ignore` (`:179-185`). So a zone whose nodes still exist but are tainted can keep `DoNotSchedule` replacement Pods Pending. `nodeTaintsPolicy: Honor` excludes tainted nodes that the Pod does not tolerate.
- After recovery, Pods are not rebalanced (`:607-608`).

**Gap:** the docs reviewed do not show which taints a failed zone's nodes receive. Losing one zone also drops you to 4 Pods, below the PDB's 5.

### 3. Probes for slow startup

- **startupProbe:** set `failureThreshold × periodSeconds` to at least the worst-case startup time. If it never succeeds, the container is killed (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **When the other probes begin:** liveness and readiness probes, including their delays, do not start until the startup probe has succeeded (`probes.md:31-33`, `:398-402`).
- **When traffic stops:** a readiness failure, after `failureThreshold` failures in a row, sets Ready to false and removes the Pod from Service load balancers. The container keeps running (`probes.md:23-29`, `:412-422`).
- **When a container restarts:** after `failureThreshold` failed liveness or startup checks, honouring the grace period (`probes.md:412-418`).
- **Config:** the docs suggest using the same lightweight endpoint for liveness and readiness, with a higher `failureThreshold` for liveness (`probes.md:19-21`).
- **Gap:** whether a probe should check the database is not established by the docs. Treat that as a design decision to make explicitly.

### 4. Termination and the 30-second grace period

**Order of events:**
1. The deletion records the grace-period deadline (`concepts/workloads/pods/pod-lifecycle.md:584-589`).
2. The kubelet runs `preStop` first, inside the same grace period. If the hook is still running when the period ends, the kubelet adds a one-time 2-second extension. Hooks that need longer require a larger `terminationGracePeriodSeconds` (`pod-lifecycle.md:591-601`).
3. SIGTERM (or the image's `STOPSIGNAL`) is sent to each container in no guaranteed order (`pod-lifecycle.md:572`, `:603-610`).
4. At the same time, the endpoints are marked terminating with `ready=false`; `serving` still shows the real readiness (`pod-lifecycle.md:612-631`; `concepts/services-networking/endpoint-slices.md:89-106`).
5. When the grace period expires, SIGKILL is sent (`pod-lifecycle.md:636-639`).

Evictions honour the grace period (`disruptions.md:143-145`).

**Answer:** 30 seconds is not guaranteed to finish long requests. **Config:** set the grace period to at least `preStop` time plus the longest request drain. Use a probe-level `terminationGracePeriodSeconds` for liveness restarts (`probes.md:523-529`).

### 5. Resources

- **CPU limits** are a hard ceiling enforced by throttling (`concepts/configuration/manage-resources-containers.md:43-46`, `:252-254`).
- **Memory limits** are enforced reactively by OOM kills (`manage-resources-containers.md:48-53`).
- **CPU requests** set the weighting under contention (`manage-resources-containers.md:255-257`).
- **Limit without a request:** Kubernetes copies the limit and uses it as the request (`manage-resources-containers.md:64-67`).
- **HPA effect:** utilization is calculated relative to the request. If any container lacks the request, utilization is undefined and the HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:90-102`).
- **Config:** set CPU and memory requests on every container, including sidecars.

### 6. HPA behaviour

**How Pods are handled:**
- Pods that are being deleted are ignored, and failed Pods are discarded.
- Pods missing metrics, and CPU Pods that are not yet ready, are set aside (`horizontal-pod-autoscale.md:153-166`). "Not yet ready" depends on two flags: `initial-readiness-delay` (30 s) and `cpu-initialization-period` (5 min) (`:168-178`).
- Missing Pods are then assumed to use 100% of the target on scale-down and 0% on scale-up. Not-yet-ready Pods are assumed to use 0% on scale-up.
- If the adjusted ratio reverses direction or falls within the 0.1 tolerance, nothing happens (`:139-147`, `:183-197`).
- The status shows the raw average (`:199-202`).

**Downscale stabilization:** the HPA takes the highest recommendation from the last 5 minutes (`:213-218`, `:480-486`).

**Consequence:** slow startup delays scale-up. **Config:** keep `minReplicas` at 6 or more, because the PDB is an absolute 5.

### 7. Least-privilege networking

**How isolation works (Guarantee):**
- Pods are non-isolated by default. A policy whose `policyTypes` includes Ingress or Egress isolates the Pods it selects in that direction.
- Allow rules from all policies add up, so evaluation order does not matter.
- Ingress from the Pod's own node stays allowed (`concepts/services-networking/network-policies.md:51-77`).
- A connection needs both the source's egress and the destination's ingress to allow it (`network-policies.md:79-81`).

**Config:**
1. Default-deny for ingress and egress (`network-policies.md:214-265`).
2. Allow ingress to the API port from its client namespaces.
3. Allow egress to the database's port and add a matching ingress rule on the database side.
4. Allow egress to DNS.

**Gap:** the supplied docs do not document a DNS egress rule. That it is needed only follows from the egress isolation rules, so test it.

**Prereq:** without a CNI plugin that enforces NetworkPolicy, policies have no effect (`network-policies.md:47-49`). Rules apply eventually and possibly late: a Pod may start unprotected or with no connectivity (`network-policies.md:362-392`).

### 8. Secrets

Base64 is not protection. It "is obscured but not secret" (`concepts/configuration/secret.md:306`).

- **Encryption at rest:** Secrets are stored unencrypted in etcd by default (`secret.md:34-46`). The default `identity` provider offers no confidentiality (`tasks/administer-cluster/encrypt-data.md:60-71`). Existing Secrets must be rewritten to become encrypted (`encrypt-data.md:590-603`).
- **Least-privilege RBAC:** `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:93-98`).
- **Pod creation:** anyone who can create Pods or Deployments in a namespace can read its Secrets and use its ServiceAccounts (`secret.md:37-40`; `rbac-good-practices.md:100-108`). Enforce the Baseline or Restricted Pod Security Standard (`rbac-good-practices.md:110-115`). Privileged containers can read every Secret used on their node (`secret.md:671-674`).
- **Git:** the docs do not address Git storage. Base64 values in Git are effectively plaintext, so move them to an encrypted or external store (`secret.md:47`).

### 9. Storage reclaim

**Guarantees:**
- Dynamically provisioned PVs take their reclaim policy from the StorageClass. If the class does not set one, it defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`; `concepts/storage/persistent-volumes.md:203-210`).
- Otherwise the PV itself "must be edited or patched after it is created" (`persistent-volumes.md:207-210`).

**Gap:** the docs never say that changing a StorageClass rewrites existing PVs. Assume it does not, and patch each existing PV.

**Retain vs Delete:**
- **Retain:** deleting the PVC leaves the PV "Released" with its data intact, and cleanup is manual (`persistent-volumes.md:185-199`).
- **Delete:** deleting the PVC removes both the PV and the backing storage asset (`persistent-volumes.md:203-205`).

**PVC deletion vs StatefulSet deletion or scaling:**
- Deleting a PVC is what triggers the reclaim policy (`persistent-volumes.md:179-183`).
- Deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`).
- `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`) controls whether the StatefulSet deletes PVCs. It defaults to Retain, is gated by a feature flag, and does not apply when a Pod is replaced after a node failure (`statefulset.md:385-419`).

**Config:** use `Retain` for database volumes.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** enable encryption at rest and rewrite existing Secrets. Remove Secrets from Git. Tighten RBAC, including create rights on Pods and Deployments, and enforce Pod Security.
2. **Storage:** set `Retain` on the database StorageClass and patch existing PVs. Decide the StatefulSet PVC retention policy explicitly.
3. **Rollout and PDB:** `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds`, a progress deadline, and PDB `unhealthyPodEvictionPolicy: AlwaysAllow`. Reconsider `minAvailable: 5`, or raise the replica count, so a zone loss or single eviction is survivable.
4. **Probes:** a startup probe sized to the worst-case start, plus separate readiness and liveness probes.
5. **Termination:** `preStop` plus a grace period at least as long as the longest request. The application must handle SIGTERM.
6. **Resources and HPA:** requests on every container, `minReplicas` of 6 or more, and a reviewed downscale window.
7. **Zone spread:** a zone constraint with `nodeTaintsPolicy` set deliberately.
8. **Networking:** default-deny, then explicit API, database and DNS allows. Verify the CNI enforces them.

**Limits that still need application or cluster validation:**
- **Real request duration versus the grace period:** SIGKILL is guaranteed at the deadline, but completing requests before it is not (`pod-lifecycle.md:636-639`).
- **Whether the CNI enforces NetworkPolicy, and how fast:** policies apply eventually, with no API signal when they take effect (`network-policies.md:380-382`).
- **Zone-failure behaviour (taints, autoscaler awareness) and capacity for surge Pods:** see `topology-spread-constraints.md:614-623` and `deployment.md:329-330`.
- **Database behaviour during API restarts:** connection limits and failover are not covered by these docs.
- **Ability to restore from Retained volumes:** these docs describe manual reclamation but no recovery procedure (`persistent-volumes.md:191-198`).