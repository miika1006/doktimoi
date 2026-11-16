# Decision memo: production review of the six-replica API design (Kubernetes v1.32 docs)

**Verdict: do not approve the design as proposed.** Four parts are unsafe as written: the 5-of-6 PDB combined with `maxUnavailable: 2`, the default-allow network, Secrets committed to Git as base64, and the reclaim policy on dynamically provisioned storage, which may be the default `Delete`. All paths are under `docs/`. Labels used below: **[G]** a documented guarantee, **[C]** a configuration choice, **[P]** a prerequisite, **[N]** something the docs do not establish.

---

### 1. PDB `minAvailable: 5`

- **Node failure: no protection.** **[G]** "A disruption budget does not truly guarantee" availability. A budget only protects against voluntary evictions (`tasks/run-application/configure-pdb.md:148-155`). Involuntary disruptions "cannot be prevented by PDBs" but still count against the budget (`concepts/workloads/pods/disruptions.md:130-131`).
- **Node drain: protected, with a prerequisite.** **[G]** `kubectl drain` goes through the Eviction API and keeps retrying rejected evictions (`disruptions.md:107-121`). With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time (`configure-pdb.md:131-132`). Only Ready Pods count as healthy. **[P]** The platform's tooling must actually respect PDBs. **[C]** Set `unhealthyPodEvictionPolicy: AlwaysAllow`; otherwise unready Pods can block the drain (`disruptions.md:138-141`).
- **Rolling update: not protected.** **[G]** Rolling updates "do count against the disruption budget", but Deployments "are not limited by PDBs" (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can drop to 4 of 6 (`concepts/workloads/controllers/deployment.md:1191-1199`).
- **Recommendation:** use `maxUnavailable: 0` and `maxSurge: 1`. `maxUnavailable` may be 0 only when `maxSurge` is non-zero (`deployment.md:1191-1206`). Set the HPA's `minReplicas` to at least 6. Another option is a PDB with `maxUnavailable: 1`, which is defined against desired replicas (`configure-pdb.md:125-129, 137-138`). Avoid budgets that require zero evictions, because then drains never finish (`configure-pdb.md:157-161`).

### 2. Spreading across zones

- **Fields:** `topologyKey: topology.kubernetes.io/zone` makes each zone one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`). With `DoNotSchedule`, `maxSkew` is the largest allowed difference from the global minimum. With `ScheduleAnyway`, it only gives priority to placements that reduce skew (`:82-93, 124-126`). `minDomains` works only together with `DoNotSchedule` (`:107-115`).
- **[C] Recommendation:** `maxSkew: 1` across zones gives 2/2/2. Add a per-node (hostname) constraint. Add `matchLabelKeys: [pod-template-hash]` so that each revision is spread on its own (`:142-148`).
- **When a zone is lost:** with `DoNotSchedule`, replacement Pods can stay Pending if placing them in the surviving zones would break the skew limit. `ScheduleAnyway` keeps the Pods schedulable, at the cost of balance (`:82-93`). The scheduler only knows about zones that currently have nodes (`:614-619`). Pods on tainted nodes still count (`:612-613`). Nothing rebalances Pods after removals (`:606-611`). **[N]** Recovery from a lost zone is not established and must be tested.

### 3. Probes for slow startup

- **[G]** A startup probe disables the other probes until it succeeds. If it fails, the container is killed and restarted (`concepts/workloads/pods/pod-lifecycle.md:492-497`). Liveness and readiness delays start only after the startup probe has succeeded (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:398-402`).
- **[C]** Set the startup probe's `failureThreshold × periodSeconds` to cover the worst-case startup time. For example, 30 × 10 s gives 300 s (`probes.md:311-347`; `pod-lifecycle.md:544-557`).
- **Traffic stops** when readiness fails: the Pod's IP is removed from the Service endpoints, and the container is not restarted (`pod-lifecycle.md:485-490`; `probes.md:412-419`).
- **The container restarts** after `failureThreshold` consecutive liveness failures (`pod-lifecycle.md:479-483`; `probes.md:412-418`).
- Readiness may check backend services such as the database (`pod-lifecycle.md:524-528`). Liveness should not, so that a database outage does not trigger restarts.

### 4. Termination

- **Order:**
  1. The Pod is marked Terminating.
  2. The `preStop` hook runs, inside the grace period. If it is still running when the period ends, the kubelet adds a one-off 2 s (`pod-lifecycle.md:584-600`).
  3. TERM is sent to each container's main process, in no particular order (`:603-610`).
  4. In parallel with step 1, endpoints are marked terminating with `ready=false`. A `serving` condition is available for draining connections (`:612-632`).
  5. When the grace period ends, SIGKILL (`:636-640`).
- Evictions also honor `terminationGracePeriodSeconds` (`disruptions.md:143-145`).
- **Is 30 s enough? Not guaranteed.** 30 s is only the default, and `preStop` runs inside that same window (`pod-lifecycle.md:594-600`). **[N]** The docs set no upper bound on request length. Size the grace period from the measured longest request plus the `preStop` time.

### 5. Requests and limits

- **[G]** The scheduler uses requests to place Pods. The CPU request is also a weighting when CPU is contended (`concepts/configuration/manage-resources-containers.md:232-241, 255-257`).
- **CPU limit:** enforced by throttling. A container is not killed for using too much CPU (`:43-46, 252-254, 275-276`).
- **Memory limit:** enforced reactively by the OOM killer, and the container then restarts (`:48-53, 261-265`).
- **Limit without a request:** the limit is copied as the request (`:63-66`).
- **Missing CPU requests break the HPA:** utilization is calculated against the request. If any container lacks a CPU request, utilization is undefined and the HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`).

### 6. HPA behaviour

- **Missing metrics:** those Pods are set aside, then counted as 100% usage on scale-down and 0% on scale-up (`hpa.md:160-161, 183-186`).
- **Not-yet-ready Pods:** set aside, then counted as 0% on scale-up (`:163-165, 188-191`). The readiness delay and the CPU initialization period (30 s and 5 min by default) interact with slow startup (`:167-178`).
- **Why scaling differs from the raw ratio:** if the adjusted ratio reverses direction or falls within the 0.1 tolerance, nothing happens (`:141-147, 193-197`). The status still reports the unadjusted value (`:199-202`).
- **Default downscale stabilization: 300 s.** Within that window the HPA uses the highest recent recommendation (`:213-218, 480-486`).

### 7. Least-privilege networking

- **[P]** NetworkPolicy has no effect unless the network plugin enforces it (`concepts/services-networking/network-policies.md:47-49`).
- **Isolation is per direction:** a Pod becomes isolated for ingress or egress once a policy selecting it lists that direction. Node traffic is always allowed in (`:53-73`).
- **Policies are additive:** they combine as a union (`:75-77`).
- **Both ends must allow a connection:** egress at the source and ingress at the destination (`:79-81`).
- **[C] Plan:**
  - Default-deny for both ingress and egress (`:214-262`).
  - Allow ingress from the clients or ingress controller only, on the API port.
  - Allow egress to the database's Pods or IP block on its port, and allow ingress on the database side.
  - Allow egress for DNS. The `kube-dns` Service listens on 53/UDP and 53/TCP, and its Pods are labeled `k8s-app=kube-dns` (`tasks/administer-cluster/dns-debugging-resolution.md:127-129, 168`). **[N]** These docs give no DNS policy example, so test that name resolution still works.
- Only TCP, UDP and SCTP behaviour is defined (`network-policies.md:264-279`). `ipBlock` matching is not reliable when addresses are rewritten (NAT) (`:200-206`).

### 8. Secrets

- **No, base64 is not protection.** **[G]** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and so can anyone who can create Pods or Deployments in the namespace (`concepts/configuration/secret.md:35-40`). Base64 is shown decoding straight back to the plaintext (`tasks/administer-cluster/encrypt-data.md:585-588`).
- **Required steps:**
  - Enable encryption at rest, use least-privilege RBAC, restrict which containers see each Secret, and consider an external secret store (`secret.md:42-48`).
  - After enabling encryption, rewrite the existing Secrets so they get encrypted (`encrypt-data.md:590-597`). Check the stored prefix in etcd (`:574-577`).
  - Treat `list` and `watch` on Secrets as able to reveal them (`concepts/security/rbac-good-practices.md:95-98`).
- **Why permission to create Pods matters:** it implicitly grants access to the namespace's Secrets, ConfigMaps, PersistentVolumes, and the permissions of any service account there. Boundaries inside a namespace are weak (`rbac-good-practices.md:100-120`).
- Encryption at rest does not cover mounted volumes (`encrypt-data.md:22-32`). Remove plaintext Secrets from Git. **[N]** The Git workflow itself is outside these docs.

### 9. Storage reclaim policy

- **[G]** A StorageClass's `reclaimPolicy` is applied when a PV is dynamically provisioned, and it defaults to `Delete` (`concepts/storage/storage-classes.md:34-36, 128-132`). Dynamically provisioned PVs inherit it, so existing PVs "must be edited or patched" (`concepts/storage/persistent-volumes.md:205-210`).
- **[N, inferred]** Changing the StorageClass therefore does not touch PVs that already exist. Patch each PV and verify it.
- **Retain vs Delete:** with `Retain`, deleting the PVC leaves the PV "Released" with its data intact, and cleanup is manual (`persistent-volumes.md:180-199`). With `Delete`, deleting the PVC removes both the PV and the external storage (`:201-207`).
- **StatefulSet:** PVC retention defaults to `Retain` for both `whenDeleted` and `whenScaled`. It applies only when the StatefulSet is deleted or scaled down, not when Pods are replaced after a node failure (`concepts/workloads/controllers/statefulset.md:391-423`). Deleting a PVC directly is what triggers the reclaim policy. For a database volume, use `Retain`.

### 10. Rollout and validation checklist (in priority order)

1. **Data:** set every database PV to `Retain` and verify it (Q9). Take backups. **[N]** Backups are not covered here.
2. **Secrets:** enable encryption at rest and rewrite existing Secrets. Remove Secrets from Git. Tighten RBAC on Secrets and on creating workloads (Q8).
3. **Rollout settings:** `maxUnavailable: 0`, `maxSurge: 1`; HPA `minReplicas` ≥ 6; PDB with `AlwaysAllow` (Q1).
4. **Resources:** set CPU and memory requests on every container, plus a memory limit (Q5).
5. **Probes:** startup, readiness and liveness as in Q3. Grace period sized above `preStop` + longest request (Q4).
6. **Spreading:** zone and hostname constraints with `matchLabelKeys` (Q2).
7. **Network:** confirm the CNI enforces policies, then apply default-deny plus the DNS, database and client allow rules (Q7).
8. **Tests:** a drain, a simulated zone loss, a rollout under load, and an HPA scale-up during slow startup.

**Limits these docs do not guarantee and that still need testing:**

- Whether the 30 s, or any chosen grace period, covers the real request length (`pod-lifecycle.md:594-600`).
- Whether the cluster's tooling and node autoscaler respect PDBs and know all zones (`configure-pdb.md` prerequisites; `topology-spread-constraints.md:614-623`).
- Whether the CNI enforces NetworkPolicy and DNS works under default-deny (`network-policies.md:47-49`).
- Whether a Metrics Server is installed for the HPA (`hpa.md:113-118`).
- The database's own failover and behaviour when connections drop. **[N]**
- Whether the storage driver supports `Delete`, encryption and the right zone placement (`persistent-volumes.md:203`; `encrypt-data.md:26-31`).