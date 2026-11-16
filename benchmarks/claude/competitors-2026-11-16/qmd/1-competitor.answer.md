# Decision memo: production design review for the six-replica API (Kubernetes v1.32 docs)

**Recommendation:** Don't approve the design as proposed. Five parts work against each other or are unsafe: a PDB of 5 alongside `maxUnavailable: 2`, a fixed 30-second grace period for long requests, default-allow networking, Secrets in Git protected only by base64, and the default `Delete` reclaim policy for database storage.

All paths are relative to `docs/`. Each point is labelled **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, or **[N]** not established by the docs.

---

### 1. PDB `minAvailable: 5` across node failure, drain and rolling update

With 6 replicas, the PDB allows only one voluntary disruption at a time (see the worked example in `concepts/workloads/pods/disruptions.md:118-121`).

- **Node failure:** **[G]** PDBs can't prevent involuntary disruptions, though those disruptions do count against the budget (`disruptions.md:130-131`). Hardware failure and node loss are involuntary (`:26-34`). If one zone holds two Pods and that zone fails, you drop to 4, and the PDB can't stop that.
- **Node drain:** **[G]** `kubectl drain` goes through the Eviction API, which respects the PDB and retries rejected evictions (`:107-116`). Drains block until a replacement Pod becomes available (`:195-197`), and a replacement that can't be scheduled blocks the drain too (`:212-219`). With slow startup, expect long drains. **[C]** The docs recommend `AlwaysAllow` as the unhealthy Pod eviction policy (`:138-141`). **[G]** Deleting Pods or Deployments directly bypasses the PDB (`:62-65`).
- **Rolling update:** **[G]** Deployments are not limited by PDBs during rolling updates (`:133-136`). With `maxUnavailable: 2`, you can drop to 4 Pods during a rollout.
- **Recommendation [C]:** set `maxUnavailable: 0` and `maxSurge: 1`. Both can't be 0 at the same time (`concepts/workloads/controllers/deployment.md:1205-1207`, `reference/kubernetes-api/workload-resources/deployment-v1.md:108`). A rollout then never goes below 6 ready Pods, as long as there is capacity for the extra surge Pod.

### 2. Zone spreading

**[C]** Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1`. Six Pods then land 2/2/2.

- `maxSkew` is the maximum allowed difference from the global minimum when the policy is `DoNotSchedule`. With `ScheduleAnyway`, the scheduler only prefers placements that reduce skew (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`).
- `DoNotSchedule` is the default and refuses placements that violate the constraint. `ScheduleAnyway` still places the Pod (`:124-126`).
- `topologyKey` is a node label, and each distinct value is a domain (`:117-122`).
- Add `matchLabelKeys: [pod-template-hash]` so that each revision is spread separately during a rollout (`:134-160`).
- **When a zone is lost:** **[G]** spreading isn't maintained when Pods are removed (`:607-611`). The scheduler only knows about zones that currently have nodes (`:614-623`).
- **[N]** The docs I read don't say exactly how replacement Pods behave under `DoNotSchedule` when a zone is down. You need to test it. A zone that disappears from the node list may also stop counting as a domain at all.
- `minDomains` (only valid with `DoNotSchedule`) treats the global minimum as 0 when fewer domains are eligible (`:107-115`).
- Choosing between them: `DoNotSchedule` protects the spread but can leave Pods Pending. `ScheduleAnyway` keeps capacity up but can pile Pods into one zone.

### 3. Probes for slow startup

**[G]** While a startup probe is defined and hasn't yet succeeded, all other probes are disabled. If the startup probe fails, the kubelet kills the container (`concepts/workloads/pods/pod-lifecycle.md:492-497`).

- **When traffic stops:** a failing readiness probe removes the Pod from the Service endpoints (`:485-490`). It doesn't restart anything.
- **When a container restarts:** a failing liveness probe kills the container and applies the restart policy (`:479-483`).
- **[C]** Give the startup probe the same endpoint as the liveness probe, with a `failureThreshold × periodSeconds` larger than the worst-case startup time. Leave the liveness defaults alone (`:544-557`).
- **[C]** Keep the readiness check separate from liveness. It may check backends such as the database (`:524-528`). Don't make liveness depend on the database, or a database outage would restart every Pod.

### 4. Termination, and whether 30 seconds is enough

**[G]** The sequence is:

1. The Pod is marked Terminating.
2. The `preStop` hook runs, and the grace-period clock is already running. If the hook overruns, the kubelet grants a one-off 2-second extension (`pod-lifecycle.md:584-601`).
3. TERM is sent, or the image's STOPSIGNAL if it defines one (`:572`, `:603-610`).
4. When the grace period expires, SIGKILL is sent (`:637-639`).

While this happens, the endpoint stays in the EndpointSlice with `ready: false`, and `serving` shows whether it is still serving (`:612-632`).

**30 seconds is not guaranteed to finish requests.** It is just the default (`:594`), and both the `preStop` hook and request draining have to fit inside it (`:599-601`). **[C]** Set `terminationGracePeriodSeconds` to at least the preStop delay plus the longest request time. **[N]** The docs don't say how quickly endpoint removal reaches clients and load balancers. You have to measure that.

### 5. Resources

- **[G]** A Pod may use more than its request when the node has spare capacity (`concepts/configuration/manage-resources-containers.md:29-34`).
- **[G]** A CPU limit is enforced by throttling, so it is a hard cap. A memory limit is enforced reactively by OOM kills, which happen only under memory pressure (`:36-53`).
- **[G]** If a limit is set without a request, the limit is copied into the request (`:63-67`).
- **[G]** HPA utilization is calculated as a percentage of the request. If any container lacks a CPU request, utilization is undefined and the HPA does nothing for that metric (`tasks/run-application/horizontal-pod-autoscale.md:90-102`).
- **[C]** Set CPU and memory requests on every container, including sidecars, and set a memory limit. **[N]** Whether a CPU limit makes long requests too slow can only be found by load testing.

### 6. HPA behaviour

- **[G]** The base formula is `ceil(current × metric/target)`, with a default tolerance of 0.1 (`horizontal-pod-autoscale.md:131-147`).
- **[G]** Pods being deleted are ignored, failed Pods are discarded, and Pods with missing metrics are set aside (`:156-165`).
- **[G]** Pods that aren't ready yet are also set aside. This is governed by the default 30-second initial readiness delay and the 5-minute CPU initialization period (`:167-178`).
- **[G]** Missing metrics are assumed to be 100% of target on scale-down and 0% on scale-up. Not-yet-ready Pods count as 0% on scale-up. Scaling is skipped if the adjustment reverses direction or lands within tolerance (`:183-197`).
- **[G]** Scale-down uses the highest recommendation from a 5-minute window (`:213-218`). The `scaleDown` default is a 300-second stabilization window (`reference/kubernetes-api/workload-resources/horizontal-pod-autoscaler-v2.md:99`).
- **What this means here:** slow startup and this dampening both delay scale-up, so HPA can't absorb sudden spikes. Also set `minReplicas ≥ 6` so the PDB math still holds.

### 7. Least-privilege networking

- **[P]** NetworkPolicy has no effect without a network plugin that implements it (`concepts/services-networking/network-policies.md:45-49`, `concepts/security/security-checklist.md:54-58`).
- **[G]** Ingress and egress isolation are independent. Policies are additive, so the allowed traffic is the union of all policies that select a Pod. A connection needs both the sender's egress and the receiver's ingress to allow it (`network-policies.md:51-81`). Traffic from the Pod's own node is always allowed (`:35-36`, `:70-71`).
- **[C]** Steps:
  1. Add a namespace-wide default deny for both ingress and egress (`:254-262`).
  2. Allow ingress from the ingress or load-balancer source.
  3. Allow egress to the database, and allow ingress on the database side.
  4. Allow egress for DNS.
- **[N]** The docs I retrieved have no worked DNS example. The need to allow DNS follows from the egress isolation rule (`:62-65`). NetworkPolicy covers layer 4 only (`:266-268`). `ipBlock` behaviour through NAT varies by plugin (`:201-206`).

### 8. Secrets

**[G]** Base64 is not protection. Secrets are stored unencrypted in etcd by default, and anyone with API or etcd access can read them. Anyone who can create a Pod, or a Deployment, in the namespace can read every Secret in it (`concepts/configuration/secret.md:35-40`).

The minimum steps are encryption at rest, least-privilege RBAC, limiting which containers get each Secret, and considering an external secret store (`:42-48`). `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:93-98`). Workload-creation rights implicitly grant access to the namespace's Secrets and to its ServiceAccounts' API permissions (`:100-108`). Set `automountServiceAccountToken: false` where the token isn't needed (`:71-75`).

**[C]** Remove Secret values from Git. The docs establish the risk. **[N]** Which Git-side tool to use instead is outside these docs.

### 9. Reclaim policy and StatefulSet volumes

- **[G]** A dynamically provisioned PV takes its reclaim policy from its StorageClass, and `Delete` is the default (`concepts/storage/storage-classes.md:126-135`).
- **[G]** With `Delete`, deleting the PVC removes both the PV and the underlying storage. With `Retain`, the PV is kept in the "Released" state for manual cleanup (`concepts/storage/persistent-volumes.md:185-210`).
- **[G]** To change an existing PV, you have to edit or patch the PV itself (`persistent-volumes.md:207-210`). Manually created PVs keep the policy they were given (`storage-classes.md:134-135`). **[N]** No passage I read says that changing a StorageClass updates existing PVs. Assume it doesn't, and patch each PV.
- **[G]** Deleting or scaling down a StatefulSet doesn't delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-55`).
- **[G]** `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`, default `Retain`) needs a feature gate. It only applies to StatefulSet deletion or scale-down, not to replacing a Pod after a node failure (`:387-423`).
- **The difference:** deleting a PVC is what triggers the reclaim policy. Deleting or scaling a StatefulSet leaves PVCs alone unless you opt in.

### 10. Prioritized rollout and validation checklist

1. Move Secrets out of Git. Enable encryption at rest. Audit RBAC for `get`/`list`/`watch` on Secrets and for Pod-creation rights (Q8).
2. Patch the database PVs to `Retain` and use a `Retain` StorageClass. Keep the PVC retention policy at `Retain` (Q9).
3. Set `maxUnavailable: 0` and `maxSurge: 1`. Keep `minAvailable: 5` with `AlwaysAllow` for unhealthy Pods. Set HPA `minReplicas ≥ 6` (Q1, Q6).
4. Set requests on every container and a memory limit. Load-test before adding a CPU limit (Q5).
5. Add startup, readiness and liveness probes, with startup sized to the measured worst case (Q3).
6. Add a preStop delay and a grace period of at least the preStop delay plus the longest request (Q4).
7. Spread by zone with `maxSkew: 1` and `matchLabelKeys`, and pick `DoNotSchedule` or `ScheduleAnyway` deliberately (Q2).
8. Confirm the CNI supports NetworkPolicy, then roll out default-deny with allow rules for ingress, the database and DNS (Q7).
9. Test node drain, zone loss, a rollout under load, and an HPA spike.

**Limits that still need application or cluster validation (not guaranteed by these docs):**
- **(a)** Whether 2 Pods per zone can carry full load after a zone is lost. The PDB can't prevent that loss.
- **(b)** The real time for endpoint removal to reach clients, and the actual longest request time.
- **(c)** Whether the CNI enforces policy, including DNS and NAT/`ipBlock` behaviour.
- **(d)** Node or zone capacity for surge and replacement Pods. Unschedulable Pods block both drains and rollouts.
- **(e)** HPA response time given slow startup and its dampening.
- **(f)** The database's own failover and quorum behaviour, which none of these documents cover.