# Decision memo: API Deployment production design (Kubernetes v1.32 docs)

**Verdict: not ready to approve as proposed.** Four parts of the design rest on assumptions the docs contradict: that the PDB protects rolling updates, that the 30-second grace period is enough, that default-allow networking is acceptable, and that base64 Secrets in Git are protected. Paths below are relative to `docs/`. Each point is tagged **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, or **[N]** not established by the docs.

## 1. PDB and the three disruption cases

- **Node drain** (voluntary eviction): the PDB applies **[G]**. Evictions go through the Eviction API, and `kubectl drain` retries rejected evictions (`concepts/workloads/pods/disruptions.md:107-116`). With `minAvailable: 5`, an eviction is allowed only if it leaves 5 or more *healthy* (Ready) Pods (`tasks/run-application/configure-pdb.md:131-132, 238-240`). At 6 replicas, that means one eviction at a time. Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:63-64`).
- **Node failure** (involuntary): the PDB cannot prevent it, although those losses do count against the budget **[G]** (`disruptions.md:130-131`). Losing a whole zone means losing 2 of 6 Pods, leaving 4. Pods stay bound to an unreachable node for 300 s by default (`concepts/scheduling-eviction/taint-and-toleration.md:274-281`).
- **Rolling update**: the PDB does **not** limit it **[G]**. "Workload resources (such as Deployment…) are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2`, the Deployment may drop to 4 available Pods (`concepts/workloads/controllers/deployment.md:1191-1199`). This conflicts directly with the intent of `minAvailable: 5`.

**Recommendation [C]:**
- Set `maxUnavailable: 0` with `maxSurge: 1` (both are allowed as long as they aren't both 0, `deployment.md:1194, 1203-1206`).
- Add `minReadySeconds` so a Pod must stay Ready for a while before it counts as available (`deployment.md:1325-1328`).
- Set `unhealthyPodEvictionPolicy: AlwaysAllow` so crash-looping Pods can't block drains (`disruptions.md:138-141`; `configure-pdb.md:254-274`).
- **[N]** The docs don't say whether surge capacity exists in each zone.

## 2. Zone spreading

- `topologyKey` is a node label key. Each distinct value of that label is one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- `maxSkew` is the largest allowed difference from the global minimum, the smallest Pod count in any eligible domain (`:82-93`).
- `DoNotSchedule` (the default) leaves a Pod unscheduled if placing it would break the skew. `ScheduleAnyway` places it anyway and only prefers lower skew (`:124-126`).

**Recommendation [C]:**
- Use `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1`, `whenUnsatisfiable: DoNotSchedule`, and `matchLabelKeys: [pod-template-hash]` so that only Pods of the current revision are counted during rollouts (`:134-163`).
- Add a hostname constraint with `ScheduleAnyway` (`:527-546`).

**Zone outage:**
- Domains are discovered only from nodes that exist, and the scheduler doesn't know about zones in advance (`:614-619`). The docs don't spell out how a zone whose nodes still exist but are unhealthy is treated **[N]**.
- With `DoNotSchedule`, replacement Pods may stay Pending instead of piling into the surviving zones. That is the trade-off: strict spread versus capacity.
- Spread isn't maintained when Pods are removed, for example on scale-down (`:607-608`) **[G]**.

## 3. Probes for slow startup

- **startupProbe:** set `failureThreshold × periodSeconds` to cover the worst-case startup time. If it never succeeds, the container is killed and handled per `restartPolicy` (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **When the other probes begin:** the liveness and readiness probes and their delays start only after the startup probe succeeds (`:398-402`).
- **When a container restarts:** liveness (or startup) failures reaching `failureThreshold` restart the container, using the grace period (`:412-418`).
- **When traffic stops:** a failed readiness probe sets `Ready=false` and removes the Pod from Service traffic without restarting it (`:351-358, 419-422`). Readiness runs for the container's whole lifetime (`:360-362`).
- **[C]** Keep liveness cheap and independent of the database. Otherwise a database outage would restart all six Pods. The docs warn about restarts under load (`:45`), but the right thresholds are **[N]** and must be measured.

## 4. Termination order

1. The Pod is marked Terminating, and the grace-period clock starts (default 30 s) (`concepts/workloads/pods/pod-lifecycle.md:584-594`).
2. The `preStop` hook runs first and uses the **same** clock. If it overruns, the kubelet gives only a one-off 2-second extension (`:591-601`).
3. SIGTERM is then sent, or the image's STOPSIGNAL; containers may receive it in arbitrary order (`:572, 603-610`).
4. At the same time, the endpoint stays in the EndpointSlice with `ready=false` and `terminating=true`, and `serving` shows the Pod's actual readiness (`:612-631`; `concepts/services-networking/endpoint-slices.md:89-115`).
5. SIGKILL is sent when the grace period expires (`:636-639`).

**Is 30 s guaranteed to finish requests? No [G].** It is a hard deadline, not a promise that work completes. Set `terminationGracePeriodSeconds` to at least the longest request time plus the `preStop` time. Whether load balancers stop sending traffic quickly enough is **[N]**.

## 5. Resources

- **Requests** drive scheduling and are reserved for the container. **Limits** are enforced by the kubelet and kernel (`concepts/configuration/manage-resources-containers.md:18-23`).
- **CPU limit → throttling**, a hard cap (`:43-46`). **Memory limit → OOM kill**, enforced reactively under memory pressure (`:48-53`).
- If only a limit is set, the request defaults to the limit (`:63-66`).
- **A missing CPU request means CPU utilization is undefined, and the HPA takes no action for that metric** (`tasks/run-application/horizontal-pod-autoscale.md:91-101`) **[G]**.

**Recommendation [C]:** set CPU and memory requests on every container, including sidecars, and a memory limit. Be cautious with CPU limits: throttling can stretch long requests and slow startup.

## 6. HPA behaviour

- The baseline is `desired = ceil(current × current/target)`, with a 0.1 tolerance (`horizontal-pod-autoscale.md:131-147`).
- Pods being deleted are ignored, and failed Pods are discarded (`:156-158`).
- Pods with missing metrics, and not-yet-ready Pods on a CPU metric, are set aside (`:160-165`). The readiness windows default to 30 s and 5 min (`:167-178`).
- The ratio is then recomputed conservatively:
  - Missing Pods count as 100% of the target on scale-down and 0% on scale-up.
  - Not-yet-ready Pods count as 0% on scale-up.
  - If the recomputed ratio reverses direction or falls within tolerance, nothing happens (`:183-197`).
- The status still reports the raw average (`:199-202`), so the status can disagree with the action taken.
- **Downscale stabilization** defaults to 300 s, using the highest recommendation within that window; scale-up has no window (`:213-218, 480-486`).
- **[P]** A metrics API, usually Metrics Server, must be installed (`:113-116`).
- Slow startup combined with the 5-minute CPU initialization period means scale-up lags during traffic spikes **[N, test]**.

## 7. Least-privilege networking

- **[P]** NetworkPolicy has effect only if the network (CNI) plugin enforces it; otherwise it does nothing (`concepts/services-networking/network-policies.md:16, 45-49`).
- Pods are non-isolated by default. A policy with Ingress or Egress in `policyTypes` isolates that direction (`:51-73`).
- Policies are additive (a union), so evaluation order doesn't matter (`:75-77`).
- **Both ends must allow a connection:** egress on the source and ingress on the destination (`:79-81`).

**Plan [C]:**
1. Default-deny all traffic in the namespace (`:254-262`).
2. Allow ingress to the API only from the ingress/load-balancer Pods.
3. Allow egress from the API to the database on its port, plus a matching ingress rule at the database.
4. Allow egress to cluster DNS on UDP/TCP 53. The policy doc gives no DNS guidance **[N]**; this is an inference from egress isolation (`:59-65`) and must be tested.

**Caveats:**
- Only TCP, UDP and SCTP behaviour is defined (`:264-279`).
- A Pod can start before its policy is applied, either unprotected or with no connectivity at all (`:362-384`).

## 8. Secrets

- Base64 is not protection. The docs call it "obscured but not secret" (`concepts/configuration/secret.md:306`). By default, Secrets are stored unencrypted in etcd (`:36-37`).
- **Committing base64 Secrets to Git is effectively committing plaintext.** Replace them with an external store, or with an encryption mechanism the docs don't cover **[N]**.
- **Encryption at rest:**
  - The default `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:64-66, 310`).
  - The first provider in the list is the one that encrypts (`:151`).
  - Existing Secrets must be rewritten to become encrypted (`:590-603`).
- **RBAC:** `get`, `list` and `watch` on Secrets all reveal their contents (`concepts/security/rbac-good-practices.md:93-98`).
- **Creating Pods or Deployments implicitly grants access** to the namespace's Secrets and service accounts (`secret.md:38-40`; `rbac-good-practices.md:100-108`).
- Privileged containers can read every Secret used on their node (`secret.md:671-673`).
- Use separate namespaces to isolate Secrets (`secret.md:667-669`).

## 9. Storage reclaim policy

- A StorageClass's `reclaimPolicy` is applied **when a PV is dynamically provisioned**. It defaults to `Delete` (`concepts/storage/storage-classes.md:34-36, 128-135`).
- Dynamically provisioned PVs inherit the policy. Changing it afterwards means editing each PV (`concepts/storage/persistent-volumes.md:205-210`). So changing the class doesn't retroactively change existing PVs. The docs imply this but don't state it in those words **[N/inferred]**.
- **Retain:** after the PVC is deleted, the PV becomes "Released" and its data stays; reclaiming it is manual (`persistent-volumes.md:185-199`).
- **Delete:** deleting the PVC removes both the PV and the backing storage asset (`:201-205`).
- **StatefulSet deletion or scale-down** is governed separately by `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`). The default is `Retain`, it requires the `StatefulSetAutoDeletePVC` feature gate, and it doesn't apply when a Pod is replaced after node failure (`concepts/workloads/controllers/statefulset.md:389-423`).
- **[C]** Use `Retain` for database volumes and patch existing PVs explicitly.

## 10. Prioritized rollout and validation checklist

1. **Secrets:** remove them from Git, rotate them, enable encryption at rest with a non-identity provider, and rewrite all existing Secrets. Then restrict `get/list/watch` on Secrets and Pod/Deployment creation rights.
2. **Database volumes:** set PV reclaim policy to `Retain`; check `persistentVolumeClaimRetentionPolicy`.
3. **Resources:** add requests (and a memory limit) to every container, and confirm the HPA shows a valid utilization.
4. **Probes:** startupProbe sized to the measured worst-case startup, plus separate readiness and liveness probes.
5. **Termination:** a `preStop` hook, a grace period longer than the longest request, and apps that handle SIGTERM.
6. **Rollout:** `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds`, a `progressDeadlineSeconds` greater than `minReadySeconds` (`deployment.md:1314-1321`).
7. **PDB:** `minAvailable: 5` with `AlwaysAllow`; a drain test should evict one Pod at a time.
8. **Zone spread:** zone and host topology spread with `matchLabelKeys`.
9. **Networking:** default-deny plus allow-lists including DNS, applied in staging first.
10. **Drills:** drain tests, zone-loss simulation, and load tests of HPA scale-up.

**Limits these documents don't guarantee and that still need validation:**
- (a) Whether 4 replicas, which is what remains after losing one zone or one node per zone, can carry peak load.
- (b) Whether the CNI enforces NetworkPolicy, and how quickly.
- (c) The actual request-drain time versus how fast load balancers stop sending traffic to terminating endpoints.
- (d) Whether there is enough surge and per-zone node capacity for `maxSurge` under `DoNotSchedule`.
- (e) Whether HPA scale-up is fast enough given slow startup and the readiness windows.
- (f) Database failover and connection-pool behaviour during Pod churn. The docs don't cover these at all.