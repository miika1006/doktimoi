# Decision memo: production API design review (Kubernetes v1.32 docs)

**Verdict: do not approve as proposed.** Four settings conflict with one another or leave a gap: the PDB and rollout settings, the 30-second grace period, default-allow networking, and base64-only Secrets. The rest is workable with the changes below. All paths are relative to `docs/`.

Each point is tagged as one of: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

---

### 1. Does the PDB guarantee five available replicas?

**No, in none of the three cases.**

- **Node failure:** this is an involuntary disruption. A PDB cannot prevent it, although it still counts against the budget. **[G]** (`concepts/workloads/pods/disruptions.md:21-34`, `:130-131`)
- **Node drain:** a drain is voluntary. `kubectl drain` goes through the Eviction API, which respects the PDB and retries rejected evictions until a timeout (`disruptions.md:107-121`). With 6 replicas and minAvailable 5, one Pod can be evicted at a time. **[G]** Three things limit this protection:
  - Deleting Pods or Deployments directly bypasses the PDB (`:62-65`).
  - The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy so that a drain is not blocked by unhealthy Pods (`:138-141`). **[C]**
  - Tools from the cluster admin or provider must actually use eviction (`:107-109`, `:58-59`). **[P]**
- **Rolling update:** Deployments are not limited by PDBs during rolling upgrades, even though those Pods count against the budget (`:133-136`). **[G]** So maxUnavailable 2 can leave 4 available Pods, which breaks the intent of minAvailable 5.

**Recommendation:** use `maxUnavailable: 0` and `maxSurge: 1` (or 2). `maxUnavailable` cannot be 0 if `maxSurge` is 0, and vice versa (`concepts/workloads/controllers/deployment.md:1191-1206`). Also set `minReadySeconds` so that a Pod counts as available only after it has stayed ready for a while (`:1323-1328`), and set `progressDeadlineSeconds` (`:1314-1321`). **[C]** Surge needs spare cluster capacity. **[P]**

### 2. Zone spreading

- **`topologyKey`:** a node-label key, here `topology.kubernetes.io/zone`. Each label value is one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- **`maxSkew`:**
  - With `DoNotSchedule` it is the largest allowed difference from the global minimum (`:82-91`).
  - With `ScheduleAnyway` it only gives preference to placements that reduce skew (`:92-93`, `:124-126`).
- **`minDomains`:** only valid with `DoNotSchedule`. If fewer eligible domains exist than `minDomains`, the global minimum is treated as 0 (`:95-115`).

**Recommendation:** `maxSkew: 1` with `DoNotSchedule` on the zone key, which gives 2/2/2 across three zones. Add a softer hostname constraint as well (the example at `:541-546` combines constraints). **[C]**

**When a zone is unavailable:**
- With `DoNotSchedule`, replacement Pods can stay Pending rather than pile into the surviving zones. Raising `maxSkew` or switching to `ScheduleAnyway` relaxes this (`:345-350`, `:422-423`).
- Domains are discovered only from nodes that exist. A zone scaled to zero nodes is not considered (`:614-619`).
- Spreading is not maintained after Pods are removed. Rebalancing needs a tool such as the Descheduler (`:607-611`). **[N]** Nothing guarantees the spread comes back by itself.

### 3. Probes for slow startup

- **Startup probe:** set `failureThreshold × periodSeconds` to cover the worst-case startup time. Liveness and readiness probes do not start until it succeeds. If it never succeeds, the container is killed and handled by `restartPolicy` (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:31-34`, `:311-347`). **[G]**
- **Readiness probe:** runs for the whole lifetime of the container. A not-ready Pod is removed from Service load balancers, so traffic stops without a restart (`:23-29`, `:351-362`). **[G]**
- **Liveness probe:** a failure restarts the container (`:13-17`). Use the same cheap endpoint as readiness with a higher `failureThreshold`, so the Pod goes not-ready before it is killed (`:19-21`). **[C]**
- Readiness and liveness do not wait on each other (`:364-368`).
- A liveness probe must not depend on the database, or a database outage restarts every Pod. **[N]** This is design judgement; the docs do not say it.

### 4. Termination order. Is 30 seconds enough?

The documented sequence (`concepts/workloads/pods/pod-lifecycle.md:565-644`):

1. The Pod is marked Terminating with a deadline.
2. `preStop` runs. If it is still running when the grace period ends, it gets a one-time extension of 2 seconds (`:591-601`).
3. TERM is sent to each container. Containers receive it in arbitrary order unless they are sidecars (`:603-610`).
4. At the same time, the control plane starts taking the Pod out of EndpointSlices. Terminating endpoints show `ready: false` and expose `serving` for draining (`:612-631`).
5. When the grace period expires, SIGKILL is sent (`:636-639`).

The grace-period clock covers `preStop` too (`:599-600`), and the default is 30 seconds (`:594`).

**30 seconds is not guaranteed to finish long requests. [N]** The docs promise only that processes are killed at the deadline. They say nothing about request completion. Set `terminationGracePeriodSeconds` to at least the `preStop` delay plus the measured longest request plus a margin. **[C]**

### 5. Resources

- Scheduling uses requests: the sum of requests must fit on the node (`concepts/configuration/manage-resources-containers.md:230-235`).
- **CPU limit:** enforced by throttling. It is a hard cap, and the container is not killed (`:43-46`).
- **Memory limit:** enforced reactively by an OOM kill, only under memory pressure (`:48-53`). The status shows `OOMKilled` (`:901-922`).
- **Missing CPU requests:** if any container lacks the request, CPU utilization is undefined and **HPA takes no action** for that metric (`tasks/run-application/horizontal-pod-autoscale.md:91-101`, `:257-260`). **[G]**

**Recommendation:** set CPU requests on every container, including sidecars, and a memory limit based on measured use. CPU limits are a choice; throttling can slow down long requests. **[C]**

### 6. HPA behaviour

- **Missing metrics:** those Pods are set aside. They are then assumed to use 100% of target on scale-down and 0% on scale-up, which dampens the change (`horizontal-pod-autoscale.md:160-161`, `:183-186`).
- **Not-yet-ready Pods (CPU):** set aside, then treated as 0% when scaling up (`:163-165`, `:188-191`).
  - A Pod counts as "not yet ready" using `--horizontal-pod-autoscaler-initial-readiness-delay` (default 30s) and `--horizontal-pod-autoscaler-cpu-initialization-period` (default 5 min) (`:167-178`).
  - Pods with a deletion timestamp are ignored (`:156-158`).
- **Why the result differs from the raw ratio:**
  - Changes within the 0.1 tolerance are skipped (`:145-147`).
  - The adjusted ratio can reverse direction, and then nothing happens (`:193-197`).
  - The status shows the unadjusted utilization (`:199-202`).
- **Scale-down stabilization:** the default window is 5 minutes (300s). The highest recommendation in the window wins (`:213-218`, `:480-482`). Scale-up has no stabilization window (`:484`).

Slow startup and the 5-minute initialization period mean scale-up will lag. Set `minReplicas` to at least 6. **[C]**

### 7. Least-privilege networking

- A Pod is isolated for ingress or egress only when some policy selects it with that `policyType`. Allowed connections are then the union of the matching policies (`concepts/services-networking/network-policies.md:59-77`).
- Both ends must allow a connection: the source's egress and the destination's ingress (`:79-81`).
- Reply traffic is allowed implicitly (`:63-64`, `:71-72`).

**Plan:**
1. Apply a default deny for ingress and egress (`:254-268`).
2. Allow ingress to the API only from the ingress/client Pods.
3. Allow egress from the API to the database's port.
4. Allow ingress on the database from the API.
5. Allow egress to DNS.

**[N]** This document has no DNS guidance (searching it for DNS finds nothing). The DNS egress rule is a necessary inference and must be tested.

**Prerequisites [P]:**
- Without a network plugin that enforces NetworkPolicy, policies have no effect (`:16`, `:47-49`).
- Deny-all is guaranteed only for TCP, UDP and SCTP (`:275-279`).
- Enforcement is eventually consistent (`:362-380`).

### 8. Secrets

**Base64 is not protection.** The docs call it "obscured but not secret" (`concepts/configuration/secret.md:306`). By default Secrets are stored unencrypted in etcd. Anyone with Pod-create rights in a namespace can read every Secret there, including indirectly by creating a Deployment (`:36-40`). Base64 Secrets in Git are effectively plaintext.

**Required steps (`:42-48`):**
- **Encryption at rest:**
  - The default `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:62-73`).
  - Existing Secrets must be rewritten to become encrypted (`:590-597`).
- **Least-privilege RBAC:**
  - Workload-create permission implicitly grants access to the namespace's Secrets and to its ServiceAccounts' permissions (`concepts/security/rbac-good-practices.md:100-108`).
  - Privileged containers can read every Secret on their node (`secret.md:671-673`).
- Use separate namespaces (`:667-669`) and consider an external secret store (`:48`).

**Recommendation:** remove the Secrets from Git and rotate them.

### 9. Storage reclaim policy

- Dynamically provisioned PVs take the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:128-132`).
- Changing the class afterwards does not update existing PVs. They must be patched one by one (`concepts/storage/persistent-volumes.md:205-210`; manually created PVs keep their own policy, `storage-classes.md:134-135`).
- **Retain:** after the PVC is deleted, the PV is "released" and the data stays. Cleanup is manual (`persistent-volumes.md:185-199`).
- **Delete:** removes the PV and the backing storage (`:201-205`).
- **PVC deletion vs StatefulSet changes:**
  - Deleting a PVC triggers the reclaim policy.
  - Deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`).
  - `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`, default `Retain`) changes this, needs the `StatefulSetAutoDeletePVC` feature gate, and applies only to StatefulSet deletion or scale-down (`:389-418`).

**Recommendation:** use `Retain` for the database data and patch any existing PVs. **[C]**

### 10. Prioritized rollout and validation checklist

1. **Secrets:** rotate leaked credentials, remove them from Git, enable encryption at rest and rewrite existing Secrets, tighten RBAC including Pod-create rights.
2. **Database data:** set `Retain` on the StorageClass and patch existing PVs. Back up before changing anything.
3. **Rollout:** `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds`, `progressDeadlineSeconds`. Keep the PDB at minAvailable 5 for drains (or 4 so drains can proceed) and set `AlwaysAllow` for unhealthy Pods.
4. **Probes:** startup probe sized to the worst-case startup, readiness probe, and a liveness probe with a higher threshold.
5. **Termination:** a `preStop` delay and a grace period of at least `preStop` plus the longest request; handle SIGTERM in the application.
6. **Resources:** CPU requests on all containers, memory limits, and HPA `minReplicas` ≥ 6.
7. **Zone spreading:** `maxSkew: 1`, `DoNotSchedule` on zones.
8. **Networking:** confirm the CNI enforces policy, then apply default deny and allow-lists including DNS.
9. **Staging tests:** drain a node, kill a zone, run a rollout under load, run a load test that triggers HPA, and test DB connectivity under the policies.

**Limits the docs do not guarantee and that need testing [N]:**
- That in-flight long requests finish within any grace period.
- That the CNI enforces NetworkPolicy, and what happens to DNS and non-TCP/UDP/SCTP traffic.
- That the cluster has spare capacity for surge Pods and for rescheduling after a zone failure. Pending Pods under `DoNotSchedule` and no automatic rebalancing are possible.
- That the cluster's disruption tools actually call the Eviction API.
- How the stateful database behaves during failover and connection churn. These documents cover no database-side guarantees.