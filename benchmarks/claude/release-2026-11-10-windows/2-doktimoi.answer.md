# Decision memo: production API on Kubernetes v1.32

**Recommendation: do not approve the design as proposed.** Several of its settings conflict with each other or are unsafe. Rolling updates with `maxUnavailable: 2` break the five-replica target. Default-allow networking and base64 Secrets kept in Git give no real protection. And because `minAvailable: 5` is a PodDisruptionBudget (PDB), it does not cover node failure or Deployment rollouts. Paths are relative to `docs/`. Each point is labelled **[G]** (documented guarantee), **[C]** (configuration choice), **[P]** (prerequisite) or **[N]** (the docs do not establish this).

## 1. Does the PDB keep five replicas available?

- **Node failure: no.** A PDB "does not truly guarantee" the count, because a node can fail while the budget is already at its minimum; it "can only protect against voluntary evictions" [G] (`tasks/run-application/configure-pdb.md:148-156`). Hardware loss, VM deletion and network partition count as involuntary disruptions (`concepts/workloads/pods/disruptions.md:21-35`).
- **Node drain: yes, within limits.** A drain is a voluntary disruption that goes through the Eviction API (`disruptions.md:43-46`). With six replicas and `minAvailable: 5`, only one Pod can be evicted at a time. Evicted Pods are terminated gracefully (`disruptions.md:143-145`). Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:58-61`). Setting `minAvailable` equal to the replica count would block drains entirely (`configure-pdb.md:158-162`). The docs recommend the `AlwaysAllow` unhealthy-Pod eviction policy (`disruptions.md:138-141`).
- **Rolling update: no.** Deployments "are not limited by PDBs when doing rolling upgrades", although Pods taken down by the rollout still count against the budget (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can drop to 4 of 6 (`concepts/workloads/controllers/deployment.md:1189-1199`).

**Recommendation [C]:** use `maxUnavailable: 0` and `maxSurge: 1`. Both fields cannot be 0 at the same time (`deployment.md:1189-1205`). Consider writing the PDB as `maxUnavailable: 1`, which the docs recommend because it follows replica-count changes (`configure-pdb.md:174-176`).

## 2. Spreading replicas across zones

- `topologyKey` names a node label. Nodes that share the label's value form one domain [G] (`concepts/scheduling-eviction/topology-spread-constraints.md:116-121`).
- `maxSkew` is the largest allowed difference between a domain's matching Pod count and the global minimum (`reference/kubernetes-api/workload-resources/pod-v1.md:209-263`, excerpt). Raising it loosens placement (`topology-spread-constraints.md:345-350`).
- `DoNotSchedule` (the default) leaves a Pod unscheduled if it would break the constraint. `ScheduleAnyway` schedules it and only prefers placements with lower skew, and that preference is weighed against other scoring (`topology-spread-constraints.md:123-126`, `:350-354`). `minDomains` works only with `DoNotSchedule`. When fewer eligible domains exist than `minDomains`, the global minimum is treated as 0 (`:95-115`).
- **Zone unavailable [N]/[G]:** the scheduler learns which zones exist only from existing nodes. A zone scaled to zero nodes is not considered until it has a node again (`:605-623`). Spread is also not maintained when Pods are removed (`:607-608`).

**Choice [C]:** zone key with `maxSkew: 1`. Use `DoNotSchedule` with `minDomains: 3` only if you accept Pending Pods during a zone outage. Otherwise use `ScheduleAnyway`.

## 3. Probes for slow startup

- A **startup probe** disables the other probes until it succeeds. If it fails, the kubelet restarts the container (`concepts/workloads/pods/pod-lifecycle.md:474-500`). Set `failureThreshold × periodSeconds` to cover the worst-case startup time; the example gives 30 × 10 = 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). Liveness and readiness delays start only after the startup probe succeeds (`:398-402`).
- **Readiness failure stops traffic:** the Pod's IP is removed from the endpoints of the Services that match it, and the container keeps running (`pod-lifecycle.md:485-490`; `probes.md:418-422`).
- **Liveness failure restarts the container** after `failureThreshold` failures in a row (default 3), honouring `terminationGracePeriodSeconds` (`probes.md:413-417`).

[N] The docs give no correct threshold values for this application; you have to measure startup time.

## 4. Termination order and the 30-second grace period

The Pod is marked Terminating with a deadline. The `preStop` hook runs inside that grace period, which defaults to 30 s, plus at most a one-off 2-second extension. If `preStop` needs longer, you must raise the grace period (`pod-lifecycle.md:584-603`). SIGTERM is sent next, in arbitrary order across containers (`:605-610`). At the same time, the control plane evaluates whether to remove the Pod from EndpointSlices. Terminating endpoints report `ready: false`, and `serving` shows the Pod's real readiness (`:612-632`). When the period expires, SIGKILL goes to any processes still running (`:636-641`).

**30 s is not guaranteed to be enough [N].** Nothing in the docs ties it to request duration. Set it from your measured longest request plus the `preStop` time.

## 5. Resources, throttling and OOM

- Containers may use more than their request when the node has capacity. Limits are enforced by the kernel through cgroups (`concepts/configuration/manage-resources-containers.md:27-42`).
- A CPU limit means throttling, a hard cap. A memory limit means an OOM kill, applied reactively and only under memory pressure (`:44-56`).
- If you set a limit without a request, the request is copied from the limit (`:63-67`).
- **HPA:** utilization is measured as a percentage of the request. If any container lacks a request, utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-103`). Metrics Server is a separate add-on **[P]** (`:115-119`).

## 6. HPA behaviour

- **Missing metrics:** the average is recomputed assuming 100% of target on scale-down and 0% on scale-up (`horizontal-pod-autoscale.md:183-187`).
- **Not-yet-ready Pods:** assumed to use 0% on scale-up. Readiness windows default to 30 s and 5 min (`:167-179`, `:189-192`).
- **Scale direction:** if the recomputed ratio reverses direction or falls within tolerance, the HPA does nothing. Status still reports the raw average (`:194-202`).
- **Default limits:** downscale stabilization is 300 s. Scale-up is capped at 4 Pods or 100% per 15 s (`:455-486`).

So the result can differ from the raw ratio. Slow startup makes this worse, because new Pods stay not-ready longer.

## 7. Least-privilege networking

- Pods are non-isolated by default in both directions. A policy that selects a Pod with `Ingress` or `Egress` in `policyTypes` isolates it in that direction. Allowed rules from all matching policies combine as a union, and reply traffic is implicitly allowed (`concepts/services-networking/network-policies.md:51-77`).
- A connection needs both egress on the source and ingress on the destination (`:79-81`). An ingress-isolated Pod still accepts traffic from its own node (`:68-71`).
- Start from default deny for ingress and egress (`:234-262`). Then allow the ingress source to the API, API egress to the database, and database ingress from the API.
- **[P]** Policies only work if the network plugin supports NetworkPolicy. Without one they have no effect (`:45-49`).
- **[N]** An exact search of the networking page found no DNS-specific guidance. You must add DNS egress yourself and test it.

## 8. Secrets

Base64 is not protection. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and **anyone who can create a Pod, or indirectly a Deployment, in the namespace can read any Secret there** (`concepts/configuration/secret.md:34-53`). Required steps: encryption at rest, least-privilege RBAC on Secrets, limiting which containers get Secrets, and optionally an external secret store (same lines). Base64 values in Git are effectively plaintext [inference from the same passage]. Keep them out of Git.

## 9. Storage reclaim policy

- Dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`; `reference/kubernetes-api/config-and-storage-resources/storage-class-v1.md:95-97`).
- **Existing PVs:** they keep the policy they were assigned at creation. To change it afterwards, edit or patch the PV (`concepts/storage/persistent-volumes.md:201-210`). [Inference: changing the class does not rewrite existing PVs. No passage states this retroactive case explicitly.]
- **Retain:** after the PVC is deleted, the PV becomes "Released" and keeps its data. Cleanup is manual, and the storage asset survives deletion of the PV object (`:185-199`).
- **Delete:** removes both the PV and the external storage asset (`:201-205`).
- **PVC deletion vs StatefulSet deletion or scale-down:** deleting a PVC triggers the reclaim policy. StatefulSet deletion and scale-down are governed separately by `persistentVolumeClaimRetentionPolicy`, which defaults to `Retain` for both. Node-failure replacement Pods keep their PVCs (`concepts/workloads/controllers/statefulset.md:387-436`; `stateful-set-v1.md:130-141`).
- **[P]** That page says the field needs the `StatefulSetAutoDeletePVC` feature gate.
- **[N]** The design calls the database "stateful" but never says whether it is a StatefulSet. Confirm this.

**Recommendation:** use `Retain` for database volumes.

## 10. Prioritized rollout and validation checklist

1. Move Secrets out of Git. Enable encryption at rest. Restrict Secret access and Pod/Deployment creation with RBAC (§8).
2. Confirm the CNI supports NetworkPolicy. Apply default deny, then explicit allows, including DNS (§7).
3. Set database volumes to `Retain`: patch existing PVs and verify the StatefulSet retention policy (§9).
4. Set the rollout to `maxSurge: 1`, `maxUnavailable: 0`. Change the PDB to `maxUnavailable: 1` with `AlwaysAllow` (§1).
5. Add a startup probe sized for worst-case startup, plus readiness and liveness probes (§3).
6. Set the grace period and `preStop` from measured request duration (§4).
7. Add CPU requests and a memory limit. Confirm Metrics Server is running. Tune HPA behaviour (§5–6).
8. Add zone spread and run a test that removes a zone (§2).
9. Rehearse a drain and a rollout while watching availability and the EndpointSlice `serving` condition.

**Limits these documents do not guarantee; validate them yourself:**
- Whether the longest requests finish within the grace period (§4).
- Real worst-case startup time and probe thresholds (§3).
- How the app behaves during a zone outage and whether the node autoscaler respects zones (`topology-spread-constraints.md:614-623`).
- Exact DNS egress rules for your CNI (§7).
- How the database handles failover and connection drain.
- Whether the HPA sizing absorbs a lost zone, or a drain during a rollout (§1).
- How the PDB and rollout interact under involuntary failures.