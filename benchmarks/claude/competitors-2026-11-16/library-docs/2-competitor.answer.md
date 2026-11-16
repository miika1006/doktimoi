# Decision memo: API Deployment production readiness (Kubernetes v1.32 docs)

**Verdict: do not approve as written.** Three parts of the design contradict the documentation: a rolling update with `maxUnavailable: 2` can take the Deployment below the PDB's five replicas; Secrets that are only base64-encoded are stored in Git; and networking is left default-allow. The 30-second grace period and the Delete-by-default storage reclaim also need changes. All paths below are relative to `docs/`.

**Labels used below:** **G** = guaranteed by the docs, **C** = a configuration choice, **P** = a prerequisite, **N** = something the docs do not establish.

---

### 1. Does the PDB keep five replicas available?

With six replicas and `minAvailable: 5`, the PDB lets the Eviction API remove only one Pod at a time, and only while at least five healthy Pods remain (`tasks/run-application/configure-pdb.md:131-132`; `concepts/workloads/pods/disruptions.md:118-121`).

- **Node failure:** not protected. PDBs cannot prevent involuntary disruptions, although those Pods still count against the budget (G, `disruptions.md:130-131`). If a zone holding two Pods fails, four remain.
- **Node drain:** protected, as long as the drain uses the Eviction API. `kubectl drain` retries rejected evictions until they succeed or a timeout is reached (G, `disruptions.md:107-116`). Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:62-65`). Set `unhealthyPodEvictionPolicy: AlwaysAllow` so misbehaving Pods do not block a drain (C, `disruptions.md:138-141`).
- **Rolling update:** not protected. Deployments are not limited by PDBs during rolling upgrades (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can drop to 4 of 6 (`concepts/workloads/controllers/deployment.md:1191-1199`).

**Recommendation:** use `maxUnavailable: 0` with `maxSurge: 1`. `maxSurge` cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1203-1211`). The cluster must have spare capacity for the extra Pod (P). Consider PDB `maxUnavailable: 1` instead of an absolute `minAvailable`, because it is calculated from the controller's desired replica count, which HPA changes (`configure-pdb.md:125-129,137-138`).

### 2. Spreading replicas across zones

Use `topologyKey: topology.kubernetes.io/zone`. Nodes with the same label value form one domain, and nodes missing the key are skipped (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122,206-215`). Use `maxSkew: 1`, which limits the difference between a zone and the global minimum (`:82-93`).

- **`DoNotSchedule`** (the default) leaves a Pod unscheduled rather than break the skew limit.
- **`ScheduleAnyway`** only prefers zones that reduce the skew (`:124-126`).

Add `matchLabelKeys: [pod-template-hash]` so the spread is calculated per Deployment revision (`:142-160`).

**When a zone is unavailable:** the docs do not establish behaviour during an outage beyond these rules (N). What they do state: domains are discovered from existing nodes, so a zone with no nodes is not considered (`:614-619`). Constraints are not re-enforced when Pods are removed (`:607-608`). With `DoNotSchedule` and `minDomains` set, the global minimum is treated as 0 when fewer domains are eligible (`:107-115`), so replacement Pods may stay Pending. `ScheduleAnyway` keeps capacity but may concentrate Pods in the surviving zones.

### 3. Probes for slow startup

- **startupProbe:** set `failureThreshold × periodSeconds` to cover the worst-case startup time. The example gives 30 × 10 s = 300 s (C, `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). All other probes are disabled until it succeeds (G, `concepts/workloads/pods/pod-lifecycle.md:492-497`), and their delays also wait for it (`configure-liveness-readiness-startup-probes.md:398-402`).
- **Traffic stops** when the readiness probe fails: the Pod is removed from Service endpoints but is not restarted (G, `pod-lifecycle.md:485-490`; `configure-liveness-readiness-startup-probes.md:419-422`). Readiness runs for the container's whole lifetime (`:360-362`).
- **A restart happens** when the startup or liveness probe fails `failureThreshold` times in a row (G, `:412-418`).

Keep liveness focused on the process itself. Database dependency checks belong in readiness (`pod-lifecycle.md:524-528`).

### 4. Termination order and the 30-second grace period

1. The Pod is marked Terminating and the grace-period clock starts.
2. `preStop` runs first. If it is still running when the grace period expires, the kubelet grants a single 2-second extension (`pod-lifecycle.md:584-601`).
3. SIGTERM is sent; the order across containers is arbitrary (`:603-610`).
4. At the same time, endpoints are marked terminating with `ready=false`, while `serving` still reflects the Pod's actual readiness (`:612-632`).
5. When the grace period expires, remaining processes get SIGKILL (`:636-639`).

**30 seconds is not guaranteed to finish requests (N).** The grace period counts from the start of shutdown, including `preStop` (`:599-600`). Set `terminationGracePeriodSeconds` to at least preStop delay + longest request + margin.

### 5. CPU, memory and HPA

- **CPU limits** are enforced by throttling (`concepts/configuration/manage-resources-containers.md:43-46`).
- **Memory limits** are enforced reactively by OOM kills under memory pressure (`:48-53`).
- If only a limit is set, it is copied to the request (`:63-67`).
- **Missing CPU requests:** if any container lacks a CPU request, CPU utilization is undefined and HPA takes no action for that metric (G, `tasks/run-application/horizontal-pod-autoscale.md:89-101`).

**Recommendation:** set CPU requests on every container, including sidecars. Set memory requests and limits.

### 6. HPA behaviour with missing metrics and not-yet-ready Pods

- Pods without metrics are set aside. They are then assumed to use 100% of the target when scaling down and 0% when scaling up (`horizontal-pod-autoscale.md:160-161,183-186`).
- For CPU, Pods that are not yet ready are set aside. On a scale-up they are counted as using 0% (`:163-178,188-191`). Two windows decide this: `initial-readiness-delay` (30 s) and `cpu-initialization-period` (5 min).
- If the recalculated ratio reverses direction or falls within the 0.1 tolerance, nothing happens (`:146-147,193-197`).
- Scale-down uses the highest recommendation within a 5-minute window (`:213-218`).

The result therefore differs from the raw `ceil(current × ratio)`. Slow startup makes this dampening stronger.

### 7. Least-privilege networking

**P:** NetworkPolicy has no effect without a network plugin (CNI) that supports it (`concepts/services-networking/network-policies.md:45-49`).

How isolation works:

- A policy that selects a Pod isolates it in each direction listed in its `policyTypes`. Reply traffic is implicitly allowed (`:51-73`).
- Policies are additive: the result is the union of what they allow (`:75-77`).
- A connection needs both egress allowed at the source and ingress allowed at the destination (`:79-81`).
- Only TCP, UDP and SCTP behaviour is defined (`:275-279`).

**Recommended policy set:**

1. A default-deny for all ingress and egress (`:254-262`).
2. Ingress to the API port only from the ingress tier.
3. Egress to the database port only.
4. Egress to the cluster DNS service.

**DNS (N):** the policy pages I read have no DNS example. However, deny-all egress blocks every outbound connection (`:236-242`), and cluster DNS listens on 53/UDP and 53/TCP (`tasks/administer-cluster/dns-debugging-resolution.md`, kube-dns output). So DNS must be allowed explicitly.

### 8. Is base64 enough for Secrets?

No. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and anyone who can create Pods or Deployments in the namespace can read every Secret there (`concepts/configuration/secret.md:35-40`).

**Required (C/P):**

- encryption at rest
- least-privilege RBAC
- restricting Secret access to specific containers
- considering an external secret store (`:42-48`)

Remove plaintext Secrets from Git. Treat permission to create Pods or Deployments as permission to read Secrets.

### 9. StorageClass reclaim policy and existing PVs

A StorageClass's `reclaimPolicy` is applied to PVs when they are dynamically provisioned, and it defaults to `Delete` (`concepts/storage/storage-classes.md:34-36,126-132`). PVs keep their own policy. Changing an existing PV means editing or patching it after creation (`concepts/storage/persistent-volumes.md:205-210`). Whether editing the class changes PVs that already exist is not stated (N); assume it does not and patch the PVs.

- **Retain:** after PVC deletion the PV becomes Released, and the external storage asset survives even if the PV is deleted (`:187-199`).
- **Delete:** removes both the PV object and the external storage asset (`:203-205`).

StatefulSet `persistentVolumeClaimRetentionPolicy`:

- `whenDeleted` and `whenScaled` default to Retain. Set to Delete, they delete the PVCs after their Pods are gone (`concepts/workloads/controllers/statefulset.md:400-415`).
- They apply only when the StatefulSet is deleted or scaled down. A Pod replaced after node failure keeps its PVC (`:417-423`).

Deleting a PVC is what triggers the PV's reclaim policy.

### 10. Prioritized rollout and validation checklist

1. Move Secrets out of Git. Enable encryption at rest and verify it. Tighten RBAC for Secrets and Pod creation.
2. Set `reclaimPolicy: Retain` on the database class and patch existing PVs. Confirm the StatefulSet retention policies.
3. Confirm the CNI enforces NetworkPolicy. Apply default-deny plus allow rules for ingress, the database and DNS, and test each path from both ends.
4. Configure startup, readiness and liveness probes using measured worst-case startup time.
5. Set CPU and memory requests and limits, then check that HPA reports a utilization value.
6. Rollout settings: `maxUnavailable: 0`, `maxSurge: 1`. PDB `maxUnavailable: 1` with `AlwaysAllow`. Set HPA `minReplicas` at or above the PDB floor.
7. Add zone topology spread with `maxSkew: 1`. Choose `DoNotSchedule` or `ScheduleAnyway` after a zone-loss drill.
8. Add a `preStop` drain and size the grace period to the longest request.
9. Test: a drain, a rolling update under load, and an HPA scale up and down.

**Limits that still need application or cluster validation (not guaranteed by these docs):**

- Whether the longest real request finishes within the grace period, and whether the load balancer honours terminating endpoints.
- Capacity in the surviving zones to reschedule replicas after a zone loss; PDBs do not cover this.
- Surge capacity for `maxSurge`, plus how often the provider causes voluntary disruptions (`disruptions.md:81-89`).
- Whether the CNI actually enforces policy, including behaviour for protocols other than TCP, UDP and SCTP.
- Whether the database tolerates connection churn and failover; nothing in these docs addresses it.
- Whether the storage driver supports Delete or Retain reclamation and zone-aware volume attachment.