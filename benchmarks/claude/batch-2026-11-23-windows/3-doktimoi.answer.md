# Decision memo: production readiness of the six-replica API design (Kubernetes v1.32 docs)

**Recommendation:** Do not approve the design as proposed. Approve it only after these changes: roll out with `maxUnavailable: 0` / `maxSurge: 1`, add explicit zone spreading and a startup probe, set the grace period from the measured longest request, set CPU requests, use deny-by-default NetworkPolicies, encrypt Secrets at rest and take them out of Git, and choose the reclaim policy on purpose. Each point below says whether something is a **guarantee** (the docs say Kubernetes does it), a **configuration** choice, a **prerequisite**, or **not established** by the docs. All paths are relative to `docs/`.

## 1. PDB `minAvailable: 5`

- **Node failure** is an involuntary disruption (`concepts/workloads/pods/disruptions.md:21-65`). A PDB cannot prevent it, though such losses "do count against the budget" (`disruptions.md:92-131`). **Not guaranteed.** Losing one zone (two Pods) leaves four.
- **Node drain** goes through the Eviction API, and the PDB constrains it. With six intended replicas, only one Pod can be evicted at a time. Rejected evictions are retried until the Pods are gone or a timeout is reached (`disruptions.md:92-131`). **Guarantee, but only for tools that use the Eviction API.** Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:21-65`).
- **Rolling update:** Deployments "are not limited by PDBs when doing rolling upgrades", although the unavailable Pods count against the budget (`disruptions.md:133-145`). `maxUnavailable: 2` lets the update drop to 4 available Pods (`concepts/workloads/controllers/deployment.md:1189-1199`). That breaks the "5" intent and blocks any drain that runs at the same time.

**Recommend:** `maxUnavailable: 0`, `maxSurge: 1`. This is valid because `maxSurge` may be 0 only when `maxUnavailable` is not 0 (`deployment.md:1201-1310`). Also set the `AlwaysAllow` unhealthy-Pod eviction policy (`disruptions.md:133-145`).

*Inference:* the PDB's intended count comes from `.spec.replicas` (`disruptions.md:92-131`). If HPA scales down to five replicas, an absolute `minAvailable: 5` allows zero evictions and drains stall. A percentage or `maxUnavailable: 1` PDB avoids that; validate whichever you choose.

## 2. Zone spreading

Add a constraint with `topologyKey: topology.kubernetes.io/zone` and `maxSkew: 1`.

- **`maxSkew`** is the largest allowed difference in matching Pods between zones.
- **`topologyKey`** names the node label that defines a zone. Nodes without that label are skipped.
- **`DoNotSchedule`** leaves the Pod Pending when the constraint cannot be met. **`ScheduleAnyway`** always schedules the Pod and only prefers less-loaded zones, weighed together with other scoring (`concepts/scheduling-eviction/topology-spread-constraints.md:262-354`).
- **Built-in default** is only `maxSkew: 5` on zones with `ScheduleAnyway`, so it is weak (`topology-spread-constraints.md:532-578`).

**Not established:** that the spread stays balanced after scale-down. Zones are discovered only from existing nodes, so a zone with zero nodes is not considered (`topology-spread-constraints.md:605-623`).

When a zone is down, `DoNotSchedule` can leave replacement Pods Pending. `ScheduleAnyway` lets them pack into the surviving zones. Pick deliberately: `DoNotSchedule` protects the spread, `ScheduleAnyway` protects capacity.

## 3. Probes for slow startup

- **startupProbe:** set `failureThreshold × periodSeconds` to cover the worst-case startup. For example, 30 × 10 s gives 300 s. If the probe never succeeds, the container is killed and the restart policy applies (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **Other probes wait:** all other probes are disabled until the startup probe succeeds (`concepts/workloads/pods/pod-lifecycle.md:474-500`).
- **readinessProbe** runs for the container's whole life. When it fails, the Pod's IP is removed from the Service endpoints. Traffic stops, but the container is **not** restarted (`configure-liveness-readiness-startup-probes.md:348-380`; `pod-lifecycle.md:474-500`).
- **livenessProbe:** when it fails, the container is killed and restarted (`pod-lifecycle.md:474-500`). Point it at a local deadlock check, not the database. Readiness and liveness do not depend on each other (`configure-liveness-readiness-startup-probes.md:348-380`).

## 4. Termination order, and whether 30 seconds is enough

1. The Pod is marked terminating, and the grace-period clock starts **before** preStop runs (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`).
2. preStop runs. If it overruns, the kubelet gives a one-off 2-second extension (`pod-lifecycle.md:584-610`).
3. SIGTERM goes to process 1 in each container (`pod-lifecycle.md:584-610`).
4. When the grace period expires, SIGKILL is sent (`pod-lifecycle.md:636-660`).

In parallel, the endpoint stays in the EndpointSlice marked terminating, with `ready=false` and `serving` still showing actual readiness (`pod-lifecycle.md:612-634`; `concepts/services-networking/endpoint-slices.md:86-117`). kube-proxy forwards to terminating endpoints only in narrow `externalTrafficPolicy: Local` cases (`reference/networking/virtual-ips.md:619-642`).

**30 seconds is not guaranteed** to finish long requests. The container "will eventually terminate within the Pod's termination grace period" whatever preStop does (`pod-v1.md:1688-1713`). Set `terminationGracePeriodSeconds` to at least preStop time + the longest request + a margin.

## 5. Resources

- **CPU limits** are enforced by throttling, a hard cap (`concepts/configuration/manage-resources-containers.md:27-67`). The docs warn that throttling "can have unintended effects on auto-scaling" (`concepts/security/security-checklist.md:138-152`).
- **Memory limits** are enforced reactively by OOM kills, only under memory pressure (`manage-resources-containers.md:27-67`). A memory limit above the request exposes the node to OOM (`security-checklist.md:138-152`).
- **A limit without a request** gets the limit copied as the request (`manage-resources-containers.md:27-67`).
- **Missing CPU requests break the HPA:** if any container lacks a CPU request, CPU utilization is undefined and the HPA "will not take any action for that metric" (`tasks/run-application/horizontal-pod-autoscale.md:89-121`).

**Prerequisite:** set CPU requests on **every** container.

## 6. HPA behaviour

- **Not-yet-ready Pods:** the initial readiness delay is 30 s and the CPU initialization period is 5 min (`horizontal-pod-autoscale.md:167-202`).
- **Missing metrics** are treated as 100% of target on scale-down and 0% on scale-up. Not-yet-ready Pods count as 0% on scale-up. If the recomputed ratio reverses direction or falls within tolerance, nothing happens. The status still reports the raw average (`horizontal-pod-autoscale.md:167-202`).
- **Default downscale stabilization** is 300 s. Scale-up has none, but each step is capped at 4 Pods or 100% per 15 s (`horizontal-pod-autoscale.md:455-486`).
- **Why scaling differs from the raw ratio:** the dampening, the tolerance and the stabilization window all change the result.
- **Prerequisite:** a metrics API, usually Metrics Server, deployed separately (`horizontal-pod-autoscale.md:89-121`).

Slow startup makes scale-up lag. Set `minReplicas` high enough to absorb peaks.

## 7. Least-privilege networking

- **Isolation is per direction.** A Pod is isolated for ingress or egress only when some policy selects it with that `policyType`. Allowed traffic is the union of the applicable policies, which are additive. A connection needs both the source's egress **and** the destination's ingress to allow it (`concepts/services-networking/network-policies.md:51-81`).
- **Default deny** is available as a pattern (`network-policies.md:234-242`).
- **DNS:** add an explicit DNS allow rule alongside the deny (`concepts/security/multi-tenancy.md:212-222`).
- **Plan:**
  - Default-deny ingress and egress.
  - Allow ingress to the API only from its known callers on the service port.
  - Allow API egress to the database's selector and port (pattern at `network-policies.md:120-140`).
  - Allow DNS egress.
- **Prerequisite:** a network plugin that implements NetworkPolicy. Without one the objects have no effect (`network-policies.md:45-49`).
- **Not established:** how policy changes affect existing connections. That is implementation-defined (`network-policies.md:464-472`).

## 8. Secrets

**base64 is not protection.** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and anyone who can create Pods, or even Deployments, in a namespace can read every Secret in it (`concepts/configuration/secret.md:1-53`).

Required steps:
- Enable encryption at rest (`secret.md:1-53`; `tasks/administer-cluster/securing-a-cluster.md:251-265`).
- Once encryption is verified, remove the `identity` provider so nothing is read back as plaintext (`tasks/administer-cluster/encrypt-data.md:617-634`).
- Use least-privilege RBAC. Remember that `list` and `watch` reveal Secret contents just like `get` (`concepts/security/rbac-good-practices.md:93-98`).
- Isolate by namespace. Privileged containers can read every Secret on their node (`secret.md:667-674`).
- Consider an external secret store (`secret.md:1-53`).
- Take the Secret manifests out of Git: base64 in Git is effectively plaintext (inference from the above).

## 9. Storage reclaim policy

- **Dynamically provisioned PVs inherit** the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
- **Existing PVs:** the class's fields are used "when a PersistentVolume … needs to be dynamically provisioned" (`storage-classes.md:20-50`). The docs say a misconfigured class means "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). Changing the class's policy is therefore **not documented to change existing PVs**; patch each PV's `persistentVolumeReclaimPolicy` (`reference/kubernetes-api/config-and-storage-resources/persistent-volume-v1.md:83-120`).
- **Delete** removes the PV and the backing storage asset (`persistent-volumes.md:201-210`).
- **Retain** keeps the PV as "Released". Cleanup and reuse are manual (`persistent-volumes.md:180-199`).
- **Deleting a PVC** releases its PV, and the reclaim policy then applies.
- **StatefulSets:** deleting or scaling down a StatefulSet does **not** delete its PVCs by default. `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`, both defaulting to `Retain`) changes that, and requires the `StatefulSetAutoDeletePVC` feature gate. It does not apply to node-failure replacements (`concepts/workloads/controllers/statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-157`).

**Recommendation:** use `Retain` for the database's data.

## 10. Prioritized checklist

1. **Secrets:** enable and verify encryption at rest, scope RBAC (including `list`/`watch` and Pod creation), and take the Secrets out of Git (Q8).
2. **Storage:** set `Retain` on the database PVs, patch any PVs that already exist, and review the StatefulSet PVC retention policy (Q9).
3. **Network:** confirm the network plugin supports NetworkPolicy, apply default-deny plus allows for callers, the database and DNS, and test both ends of each connection (Q7).
4. **Resources:** set CPU and memory requests on every container, confirm Metrics Server is running, and keep memory limit equal to request (Q5, Q6).
5. **Probes:** startup budget ≥ measured worst-case startup; readiness checks dependencies; liveness stays local (Q3).
6. **Termination:** grace period ≥ preStop + longest request; run a load test through a rollout (Q4).
7. **Rollout and PDB:** `maxUnavailable: 0`, `maxSurge: 1`, a PDB that still allows evictions at the HPA minimum, and `AlwaysAllow` (Q1).
8. **Spreading:** zone constraint with `maxSkew: 1`; choose `DoNotSchedule` vs `ScheduleAnyway`; run a zone-failure drill (Q2).

**Limits these docs do not guarantee, which you still need to validate:**
- That in-flight long requests finish inside the grace period (Q4).
- The external load balancer's draining behaviour and timing (Q4).
- Capacity during a zone outage, and spread after scale-down or with zero-node zones (Q2).
- That drain tools actually use the Eviction API (Q1).
- Database connection limits and failover behaviour.
- Whether the CNI cuts existing connections when policies change (Q7).
- The HPA's reaction time under slow startup (Q6).