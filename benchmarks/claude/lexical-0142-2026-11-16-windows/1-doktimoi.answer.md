# Decision memo: production review of the API Deployment on Kubernetes v1.32

**Verdict:** Do not approve the design as written. Six of the proposed settings rest on behaviour these docs do not guarantee: the PDB, `maxUnavailable: 2`, default-allow networking, base64-only Secrets in Git, the 30-second grace period, and the default `Delete` reclaim policy. Paths below are relative to `docs/`. Each point is labelled **G** (documented guarantee), **C** (configuration choice), **P** (prerequisite) or **U** (not established by these docs).

## 1. Does the PDB keep five replicas available?

No, not in all three cases.

- **Node failure:** not protected. Node failure is an involuntary disruption (`concepts/workloads/pods/disruptions.md:21-65`). "A disruption budget does not truly guarantee" the minimum. If a node fails while the app is already at the minimum, availability drops below it (`tasks/run-application/configure-pdb.md:148-176`). Involuntary disruptions "cannot be prevented by PDBs" but do count against the budget (`disruptions.md:92-131`). **G**
- **Node drain:** protected. `kubectl drain` uses the Eviction API, keeps retrying rejected evictions, and respects the budget (`disruptions.md:92-131`). With 6 replicas and `minAvailable: 5`, one Pod can be evicted at a time. **G**, as long as the tooling uses eviction and not deletion. Deleting Pods or Deployments bypasses PDBs (`disruptions.md:21-65`). The docs recommend the `AlwaysAllow` unhealthy-pod eviction policy so a misbehaving Pod cannot stall a drain (`disruptions.md:133-145`). **C**
- **Rolling update:** not protected. Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-145`). `maxUnavailable: 2` therefore allows 4 available replicas, which breaks the intended floor of 5. Percentages round down and the default is 25% (`concepts/workloads/controllers/deployment.md:1189-1199`, `1201-1310`).

**Recommendation:** use `maxUnavailable: 0` with `maxSurge: 1`. `maxSurge` cannot be 0 when `maxUnavailable` is 0, so the pair must be set together. Also consider a PDB with `maxUnavailable: 1`, which the docs recommend because it adjusts as replica counts change (`configure-pdb.md:148-176`). That matters here because the HPA changes the replica count. Each surge Pod needs spare capacity (`tutorials/stateful-application/zookeeper.md:1136-1153`).

## 2. How should replicas be spread across zones?

- **`topologyKey`:** set it to the zone node label. Nodes with the same label value form one domain, and the scheduler tries to balance Pods across domains. **C**
- **`maxSkew: 1`:** the allowed difference in matching Pods between domains. The default is 1, and 0 is not allowed (`reference/kubernetes-api/workload-resources/pod-v1.md:209-263`).
- **`DoNotSchedule` (the default):** the scheduler refuses to place a Pod that would break the constraint.
- **`ScheduleAnyway`:** the scheduler places the Pod anyway and only prefers lower skew (`concepts/scheduling-eviction/topology-spread-constraints.md:95-126`). That preference is weighed together with other scoring factors (`topology-spread-constraints.md:335-354`).
- **`minDomains`:** works only with `DoNotSchedule`. When fewer eligible domains exist, it treats the global minimum as 0 (`topology-spread-constraints.md:95-126`).

**When a zone is unavailable:**
- Zones are discovered only from existing nodes. A zone scaled to zero nodes is not considered.
- Nothing guarantees the spread is restored after Pods are removed (`topology-spread-constraints.md:605-623`).
- Under `DoNotSchedule`, replacement Pods may stay Pending if placing them would exceed the skew.
- Under `ScheduleAnyway`, they land in the surviving zones.

**Recommendation:** `DoNotSchedule` with `minDomains: 3` gives strict three-zone placement. `ScheduleAnyway` puts capacity during an outage first. Which one fits is a business choice (**C**). How each behaves during an actual zone outage is **U** and must be tested.

## 3. Which probes fit slow startup?

- **startupProbe:** while one is defined, all other probes are disabled until it succeeds. If it fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:474-500`). Liveness and readiness start only after it succeeds, which protects slow starters (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:2-41`). Its budget (`failureThreshold × periodSeconds`) must exceed the worst-case startup time. That time is **U** and must be measured.
- **readinessProbe:** traffic stops when it fails. The Pod's IP is removed from the endpoints of matching Services, and readiness is `Failure` until the initial delay ends.
- **livenessProbe:** the container restarts only when it fails (`pod-lifecycle.md:474-500`). Use a cheap endpoint with a higher `failureThreshold` than readiness. The probe must reflect only unrecoverable failure such as a deadlock, not slow requests or a database outage (`configure-liveness-readiness-startup-probes.md:2-41`).

## 4. Termination order: is 30 seconds enough?

The documented sequence (`pod-lifecycle.md:559-582`, `584-610`):
1. The Pod is marked Terminating.
2. The `preStop` hook runs. The grace-period clock is already running at this point (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`).
3. If `preStop` is still running when the grace period expires, the kubelet adds a one-off 2-second extension.
4. The container gets TERM, or the image's STOPSIGNAL, in arbitrary order across containers.
5. When the grace period expires, KILL is sent to remaining processes.

At the same time, endpoints for the Pod are marked terminating with `ready=false`, so load balancers stop sending it regular traffic. Draining logic can still read the `serving` condition (`pod-lifecycle.md:612-634`, `concepts/services-networking/endpoint-slices.md:91-117`).

**30 seconds is not guaranteed** to finish long requests. 30 seconds is just the default, and the docs tell you to raise `terminationGracePeriodSeconds` if `preStop` needs longer (`pod-lifecycle.md:584-610`). The worst-case request time is **U**.

**Recommendation:** grace period ≥ `preStop` delay + longest request + margin. The application must stop accepting new requests and drain on SIGTERM.

## 5. CPU and memory resources

- **CPU limit:** enforced by throttling. It is a hard cap.
- **Memory limit:** enforced reactively by OOM kills, and only under memory pressure. A container can exceed it for a time and then be killed.
- **Requests:** a container may use more than its request when the node has spare capacity. If only a limit is set, it is copied into the request (`concepts/configuration/manage-resources-containers.md:27-67`). **G**
- **HPA:** it measures utilization as a percentage of the request. If any container lacks a CPU request, utilization is undefined and the HPA "will not take any action for that metric" (`tasks/run-application/horizontal-pod-autoscale.md:89-121`).

**Recommendation:** set CPU requests on every container, including sidecars. Set a memory limit sized from measurements. Any CPU limit must leave room for startup, because throttling would make slow startup slower. The actual numbers are **U**.

## 6. HPA with missing metrics and not-ready Pods

- **Not-yet-ready Pods:** set aside. The readiness delay defaults to 30 seconds and the CPU initialization period to 5 minutes.
- **Missing metrics:** assumed to be 100% of target when scaling down and 0% when scaling up.
- **During a scale-up:** not-yet-ready Pods are counted as 0%.
- **No action:** if the recalculated ratio reverses direction or falls within tolerance, nothing happens. HPA status still reports the original, unadjusted average (`horizontal-pod-autoscale.md:167-202`).
- **Downscale stabilization:** the default window is 300 seconds. Scale-up has no window; it may add 100% or 4 Pods per 15 seconds, whichever is larger (`horizontal-pod-autoscale.md:455-486`).
- **Metrics source (P):** the Metrics Server add-on must be deployed separately (`horizontal-pod-autoscale.md:89-121`).

For these reasons, actual scaling can differ from the raw ratio. With slow startup, a scale-up takes effect late.

## 7. Least-privilege networking

**How isolation works (G):**
- Pods are non-isolated by default. A Pod becomes isolated for ingress or egress once any policy with that `policyType` selects it.
- Allowed connections are the union of all policies that apply ("additive"), and reply traffic is implicitly allowed.
- A connection needs both the source's egress and the destination's ingress to allow it (`concepts/services-networking/network-policies.md:51-81`).

**Prerequisite (P):** the CNI plugin must implement NetworkPolicy. Otherwise the policies have no effect (`network-policies.md:45-49`; `concepts/security/multi-tenancy.md:208-234`). Support for `endPort` is plugin-specific (`network-policies.md:281-307`).

**Plan:**
1. A default-deny policy for all ingress and egress (`network-policies.md:254-262`).
2. An explicit egress allow to DNS (`multi-tenancy.md:208-234`).
3. Ingress to the API only from the ingress/load-balancer source.
4. Egress from the API to the database port, plus a matching ingress rule on the database side.

## 8. Is base64 enough for Secrets?

No. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and anyone who can create a Pod, or indirectly a Deployment, in the namespace can read any Secret there (`concepts/configuration/secret.md:1-53`).

**At-rest encryption:** without `--encryption-provider-config`, or with `identity` as the first provider, there is no at-rest encryption (`tasks/administer-cluster/encrypt-data.md:53-73`). This encryption covers API data, not mounted volumes (`encrypt-data.md:1-32`).

**RBAC:** creating workloads implicitly grants access to the namespace's Secrets and to its ServiceAccounts' API permissions. Namespace boundaries are weak, so use least privilege plus Baseline or Restricted Pod Security (`concepts/security/rbac-good-practices.md:100-120`).

**Recommendation:**
- Remove plaintext/base64 Secrets from Git. These docs do not cover Git-side handling.
- Enable at-rest encryption.
- Grant least-privilege RBAC on Secrets and on Pod/workload creation.
- Consider an external Secret store (`secret.md:1-53`).

## 9. StorageClass reclaim policy

- **Existing PVs:** dynamically provisioned PVs inherit the class's `reclaimPolicy`, which defaults to `Delete`. If the class does not match expectations, "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`; `concepts/storage/storage-classes.md:126-135`; `reference/kubernetes-api/config-and-storage-resources/storage-class-v1.md:83-99`). The docs imply that changing the class does not rewrite existing PVs, but they do not state it directly (**U**). Patch each PV.
- **Retain:** when the PVC is deleted, the PV becomes "Released" with its data intact and must be reclaimed manually (`persistent-volumes.md:178-199`).
- **Delete:** removes both the PV and the external storage asset (`persistent-volumes.md:201-210`).
- **PVC vs StatefulSet:** deleting a PVC triggers the reclaim policy. Deleting or scaling down a StatefulSet keeps PVCs by default (`Retain`). `persistentVolumeClaimRetentionPolicy` `whenDeleted` and `whenScaled` change this only for deletion or scale-down, not for node-failure replacement (`concepts/workloads/controllers/statefulset.md:387-463`).

**Recommendation:** use `Retain` for database volumes.

## 10. Prioritized rollout and validation checklist

1. Confirm the CNI enforces NetworkPolicy. Then apply default-deny, the DNS allow, and the API↔DB allows. Test both directions (§7).
2. Enable and verify Secret encryption at rest. Purge Secrets from Git. Tighten RBAC and Pod Security (§8).
3. Set the database StorageClass and existing PVs to `Retain`, and verify each PV (§9).
4. Set CPU requests on all containers and confirm Metrics Server is running. Then enable the HPA (§5–6).
5. Add a startupProbe sized to measured startup, a readinessProbe, and a conservative livenessProbe (§3).
6. Size the grace period and `preStop`, and check that SIGTERM drains requests (§4).
7. Rolling update with `maxUnavailable: 0`, `maxSurge: 1`. PDB with `maxUnavailable: 1` plus `AlwaysAllow` (§1).
8. Zone topology spread constraint with a chosen `whenUnsatisfiable`. Reserve spare capacity (§2).
9. Run game days: drain a node, roll out an update, simulate a zone outage, and kill a Pod mid-request.

**Limits these docs do not guarantee; validate them in the application or cluster:**
- Actual startup time and the longest request time, which drive probe thresholds and the grace period.
- Whether the application handles SIGTERM correctly.
- How the load balancer and kube-proxy drain connections in this environment.
- Whether a zone outage leaves enough schedulable capacity, and how the node autoscaler handles zones.
- That the CNI actually enforces the policies.
- That the encryption provider is configured and existing Secrets are migrated.
- Database connection limits as the HPA scales.
- Storage-driver support for `Delete`/`Retain`.