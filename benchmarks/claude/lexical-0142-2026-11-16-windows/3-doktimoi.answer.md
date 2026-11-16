I have all the evidence I need, so I'm writing the memo now.

# Decision memo: production readiness review of the API Deployment (Kubernetes v1.32 docs)

**Recommendation: do not approve the design as written.** Two choices work against each other: `minAvailable: 5` and `maxUnavailable: 2`. Three choices are not safe: default-allow networking, base64-only Secrets in Git, and the default `Delete` reclaim policy for database storage. Paths are relative to the supplied `docs` folder. The labels used below are **G** (documented guarantee), **C** (configuration choice), **P** (prerequisite) and **N** (the docs do not establish this).

## 1. PDB `minAvailable: 5` across three cases

- **Node failure.** Node failure is an involuntary disruption (`concepts/workloads/pods/disruptions.md:21-65`). **G:** "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`disruptions.md:92-131`). Losing a node that holds two Pods leaves four. The PDB does not guarantee five.
- **Node drain.** `kubectl drain` uses the Eviction API, which respects PDBs. Rejected evictions are retried until the Pods are gone or a timeout is reached (`disruptions.md:92-131`; `tutorials/stateful-application/zookeeper.md:1136-1153`). With 6 replicas and `minAvailable: 5`, only one eviction is allowed at a time. If two Pods share a node, the drain stalls until a replacement is Ready. Slow startup makes that stall longer. **C:** by default, eviction waits for Pods to be healthy. The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy (`disruptions.md:133-145`). **P:** cluster tooling must call the Eviction API, because deleting Pods or Deployments directly bypasses PDBs (`disruptions.md:21-65`).
- **Rolling update.** **G:** rollout Pods "do count against the disruption budget, but workload resources (such as Deployment…) are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-145`). `maxUnavailable: 2` allows as few as four available Pods. The `maxUnavailable` field "specifies the maximum number of Pods that can be unavailable" (`concepts/workloads/controllers/deployment.md:1189-1199`). A rollout also uses up the budget, which blocks drains while it runs.

**Recommendation:** use `maxUnavailable: 0` and `maxSurge: 1`, or 2 if capacity allows. `maxSurge` cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1201-1310`). Keep integer `minAvailable: 5`. Percentages round up (`tasks/run-application/configure-pdb.md:85-104`). Reserve spare capacity so a surge Pod can schedule.

## 2. Zone spreading

Use a `topologySpreadConstraint` with `maxSkew: 1` and `topologyKey` set to the cluster's zone node label. `topologyKey` names a node label, and nodes with the same value form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:76-126`). With `DoNotSchedule` (the default), `maxSkew` is the largest allowed difference from the global minimum, and a Pod that would break it is not scheduled. `ScheduleAnyway` still schedules the Pod and only prefers placements that reduce skew (`:76-126`). That preference is weighed together with other scheduler priorities (`:335-354`). `minDomains` works only with `DoNotSchedule` (`:76-126`).

**Zone outage.** **G:** the constraints are not guaranteed to stay satisfied when Pods are removed. Domains are discovered from existing nodes, so a zone scaled to zero nodes is not counted (`:605-623`). **N:** the docs do not say exactly how replacements behave while a zone's nodes still exist but are unhealthy. `DoNotSchedule` with `minDomains: 3` may leave replacements Pending. `ScheduleAnyway` keeps the replica count up at the cost of balance. **Recommendation:** use `DoNotSchedule` for the zone key, test a zone failure, and add a node-level `ScheduleAnyway` constraint.

## 3. Probes for slow startup

**G:** when a startup probe is defined, all other probes stay disabled until it succeeds. If it fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:474-500`). Set `failureThreshold × periodSeconds` to cover the worst-case startup time. For example, 30 × 10 s gives 300 s, after which the container is killed (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).

**When traffic stops.** A failed readiness probe removes the Pod IP from Service endpoints. Readiness defaults to `Failure` before the initial delay (`pod-lifecycle.md:474-500`).

**When a container restarts.** A failed liveness probe restarts the container. The docs suggest giving liveness a higher `failureThreshold` than readiness, so the Pod is marked not-ready before it is killed. Liveness should detect only unrecoverable states such as a deadlock (`configure-liveness-readiness-startup-probes.md:2-41`). A liveness probe that checks the database could restart every replica during a database outage.

## 4. Termination, and whether 30 seconds is enough

1. The Pod is marked Terminating with a deadline (`pod-lifecycle.md:584-610`).
2. The grace-period clock starts **before** preStop runs (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`).
3. preStop runs. If it is still running when the grace period ends, the kubelet adds a one-time 2 s extension (`pod-lifecycle.md:584-610`).
4. SIGTERM goes to PID 1, or to the image's STOPSIGNAL. Containers receive it in arbitrary order (`:559-582`, `:584-610`).
5. When the grace period ends, the runtime sends SIGKILL (`:636-645`).

At the same time as shutdown starts, terminating endpoints get `ready: false` and are not used for regular traffic, while `serving` reflects actual readiness (`:612-634`).

**G:** the guarantee is that termination will finish, not that requests will. Thirty seconds is the default, not a fit for long requests. Set `terminationGracePeriodSeconds` to at least preStop time plus the longest request plus margin (**C**).

## 5. Resources

Requests are not caps. A container may use more than its request (`concepts/configuration/manage-resources-containers.md:27-67`). CPU limits cause **throttling**. Memory limits are enforced reactively by **OOM kill**, under memory pressure (`:27-67`). If only a limit is set, the request defaults to the limit (`:27-67`).

**HPA impact.** If any container in the Pod has no CPU request, CPU utilization is undefined and "the autoscaler will not take any action for that metric" (`tasks/run-application/horizontal-pod-autoscale.md:89-121`). **Recommendation:** set CPU and memory requests on every container, including sidecars. Set a memory limit. Validate CPU-limit throttling against latency, because the docs give no guidance on it.

## 6. HPA behaviour

**P:** the `metrics.k8s.io` API, usually provided by Metrics Server, must be installed (`horizontal-pod-autoscale.md:89-121`).

The base formula is `ceil(current × ratio)` with a 0.1 tolerance (`:129-165`). The result can differ from the raw ratio because:

- terminating Pods are ignored and failed Pods are discarded;
- Pods with missing metrics, and not-yet-ready Pods when scaling on CPU, are set aside (`:129-165`);
- for missing metrics, the average is recomputed assuming 100% use on scale-down and 0% on scale-up;
- not-yet-ready Pods count as 0% on scale-up;
- if the recomputed ratio reverses direction or falls within the tolerance, the HPA does nothing (`:167-202`).

Readiness timing uses `--horizontal-pod-autoscaler-initial-readiness-delay` (30 s) and `--horizontal-pod-autoscaler-cpu-initialization-period` (5 min) (`:167-202`). Slow startup therefore weakens scale-up.

Scale-down uses a **300 s** stabilization window and allows removing up to 100% of Pods per 15 s. Scale-up has no window and adds at most the larger of 4 Pods or 100% per 15 s (`:455-486`). **Recommendation:** set `minReplicas: 6` so the HPA cannot undercut the PDB and zone layout.

## 7. Network policy

By default, Pods are non-isolated in both directions. A Pod becomes isolated for a direction when any policy that selects it lists that direction in `policyTypes`. Policies are additive (a union), and reply traffic is allowed implicitly. A connection needs **both** the source's egress and the destination's ingress to allow it (`concepts/services-networking/network-policies.md:51-81`). Ingress isolation still allows traffic from the Pod's own node (`:51-81`).

Start with a namespace default-deny for both directions (`:254-262`). Then allow:

- ingress from the Service's clients;
- egress from the API to the database port;
- ingress on the database side.

**P:** a CNI plugin that supports NetworkPolicy is required. Without one, policies have no effect (`:45-49`). Support for `endPort` also depends on the plugin (`:281-307`). **N:** none of the retrieved passages covers DNS. Because egress isolation allows only listed traffic (`:51-81`), DNS egress has to be allowed explicitly. Test it.

## 8. Secrets

Base64 is encoding, not protection. The docs say a base64 value is "obscured but not secret" (`concepts/configuration/secret.md:240-307`). Committing Secrets to Git exposes them. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and **anyone who can create a Pod, or indirectly a Deployment, can read every Secret in that namespace** (`secret.md:1-53`).

Required steps:

- Turn on encryption at rest. The `identity` provider means no encryption (`tasks/administer-cluster/encrypt-data.md:80-143`). KMS is preferred over a raw key held in the config file (`:347-404`).
- Rewrite existing Secrets with a replace so they get encrypted (`:590-615`).
- Use least-privilege RBAC (`secret.md:1-53`). Permission to create workloads implicitly grants access to Secrets, ServiceAccounts and PVs (`concepts/security/rbac-good-practices.md:100-120`), and the built-in `edit` role can read Secrets (`reference/access-authn-authz/rbac.md:667-686`).
- Consider an external secret store (`secret.md:1-53`).

## 9. Storage reclaim

Dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`; `reference/kubernetes-api/config-and-storage-resources/storage-class-v1.md:83-99`). Existing PVs must be "edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). **N:** no retrieved passage says outright that changing a StorageClass leaves existing PVs alone. The passages above imply it: patch each PV yourself.

- **Delete** removes both the PV and the backing storage asset (`persistent-volumes.md:201-210`).
- **Retain** keeps a "released" PV that needs manual cleanup. Deleting the PV leaves the storage asset in place (`:185-199`).

Deleting a PVC triggers the reclaim policy. Deleting or scaling down a StatefulSet does **not** delete its volumes (`concepts/workloads/controllers/statefulset.md:48-56`). The `persistentVolumeClaimRetentionPolicy` field (`whenDeleted`/`whenScaled`) defaults to `Retain`, needs the `StatefulSetAutoDeletePVC` feature gate, and applies only to deletion or scale-down, not to replacing a Pod after node failure (`statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`). **Recommendation:** set `Retain` on the database's class and patch its existing PVs.

## 10. Prioritized checklist

1. **Secrets:** remove them from Git, turn on encryption at rest (KMS), rewrite existing Secrets, tighten RBAC on Pod and Deployment creation.
2. **Storage:** set `Retain` on the database StorageClass, patch existing PVs, check the StatefulSet retention policy.
3. **Network:** confirm the CNI enforces policies, apply default-deny, add allow rules for clients, the database and DNS, then test both ends of each connection.
4. **Rollout:** `maxUnavailable: 0` and `maxSurge: 1`, PDB `minAvailable: 5` with `AlwaysAllow`, spare node capacity.
5. **Probes:** a startup probe sized to worst-case startup, a readiness probe, and a conservative liveness probe.
6. **Termination:** a preStop delay and a grace period of at least the longest request.
7. **Resources and HPA:** requests on every container, a memory limit, Metrics Server installed, `minReplicas: 6`.
8. **Zone spread:** test a drain, a rollout and a zone loss in staging.

**Limits that still need validation, because these docs do not guarantee them:**

- The actual longest request time, and whether 30 s or the chosen grace period covers it. SIGKILL ends anything still running.
- How replacements schedule during a real zone outage under `DoNotSchedule`.
- Whether the CNI enforces NetworkPolicy and what DNS egress it needs.
- Latency under CPU throttling, and real memory headroom before OOM.
- How the application handles retries and reconnects when database connections drop during drains.
- Whether the cluster's maintenance tooling actually uses the Eviction API.