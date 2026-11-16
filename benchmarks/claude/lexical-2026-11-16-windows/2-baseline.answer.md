# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs only)

**Verdict:** Do not approve as proposed. Four parts conflict with what the docs say: minAvailable 5 combined with maxUnavailable 2, base64-only Secrets in Git, default-allow networking, and an unexamined `Delete` reclaim default. Other parts depend on settings the design doesn't specify yet: CPU requests, probes and grace period. Paths below are relative to `docs/`. Each point is labelled: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by the docs.

## 1. PDB minAvailable: 5

- **Node failure:** **[G]** A PDB cannot prevent involuntary disruptions, though they do count against the budget (`concepts/workloads/pods/disruptions.md:130-131`). A node can fail while the app is already at the minimum, which drops availability below it (`tasks/run-application/configure-pdb.md:148-155`). Not guaranteed.
- **Node drain:** **[G]** `kubectl drain` goes through the Eviction API, which respects PDBs and retries rejected evictions (`disruptions.md:107-116`). With 6 replicas and minAvailable 5, only one Pod can be evicted at a time (`disruptions.md:118-121`). **[P]** This holds only if the tooling uses eviction. Deleting Pods or Deployments bypasses the PDB (`disruptions.md:62-65`).
- **Rolling update:** **[G]** Rolling updates count against the budget, but Deployments are *not limited* by PDBs (`disruptions.md:133-136`). With maxUnavailable 2, the controller may drop to 4 available (`concepts/workloads/controllers/deployment.md:1191-1199`), which breaks the intent of minAvailable 5.
- **Recommendation [C]:** Use `maxUnavailable: 0, maxSurge: 1` (allowed because maxSurge is non-zero, `deployment.md:1194,1203-1206`), and set `minReadySeconds` and `progressDeadlineSeconds` (`deployment.md:1314-1325`). Consider `unhealthyPodEvictionPolicy: AlwaysAllow` (`disruptions.md:138-141`). Expect drains to proceed one Pod at a time.

## 2. Zone spread

**[C]** Use `topologySpreadConstraints` with `topologyKey: topology.kubernetes.io/zone` and `maxSkew: 1` (2/2/2). How the fields work:
- `maxSkew` is the largest allowed difference from the global minimum when `DoNotSchedule` is set. Under `ScheduleAnyway` it only biases scoring (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`).
- `topologyKey` names a node label. Each distinct key/value pair is one domain (`:117-122`).
- `DoNotSchedule` is the default and refuses placement. `ScheduleAnyway` places the Pod while minimizing skew (`:124-126`).
- `minDomains` works only together with `DoNotSchedule` (`:107-115`).

**When a zone is unavailable:**
- **[N]/[G]** With `DoNotSchedule`, replacement Pods can stay Pending if placing them would exceed the skew. The fixes are a larger maxSkew or `ScheduleAnyway` (`:345-350, 422-423`).
- **[G]** Domains are known only from existing nodes, so a zone scaled to zero nodes is invisible (`:615-622`).
- **[G]** Scale-downs can leave the spread unbalanced (`:607-608`).

**Recommendation:** zone spread with `ScheduleAnyway`, or `DoNotSchedule` with `minDomains: 3` if you accept Pending Pods. Add a hostname constraint (`:539-546`).

## 3. Probes for slow startup

- **[G] Startup probe:** While it exists, all other probes are disabled until it succeeds. If it fails, the container is killed and restarted under its restart policy (`concepts/workloads/pods/pod-lifecycle.md:492-497`). **[C]** Point it at the liveness endpoint, with `failureThreshold × periodSeconds` longer than the worst-case startup (`:546-557`).
- **[G] Readiness probe:** When it fails, the Pod is removed from the Service endpoints, so traffic stops but the container keeps running. Readiness counts as Failure before the initial delay (`:485-490, 512-518`). It can also check backend dependencies such as the database (`:524-528`).
- **[G] Liveness probe:** When it fails, the container is killed and restarted (`:479-483`). Keep it cheap and don't include database checks in it.
- Readiness and liveness begin only after the startup probe has succeeded.

## 4. Termination

**[G] Order of events:**
1. The Pod is marked Terminating with its grace period (`pod-lifecycle.md:584-589`).
2. The preStop hook runs. If it is still running when the grace period expires, the kubelet grants a one-off 2-second extension (`:591-601`).
3. TERM is sent to PID 1 in each container, in arbitrary order (`:603-610`).
4. At the same time as step 2, the endpoint controllers mark the Pod as terminating. Its endpoints get `ready=false` and a `serving` condition, so regular traffic stops (`:612-632`).
5. When the grace period expires, SIGKILL is sent (`:572-573, 636-639`).

The preStop hook runs inside the same grace period, so a long preStop leaves less time after TERM (`:599-600`).

**Is 30 seconds enough? [N]** No. 30 seconds is only the default (`:594`), and nothing in the docs guarantees that long requests finish within it. **[C]** Set `terminationGracePeriodSeconds` to at least the longest request time plus the preStop delay, then confirm it by testing. Eviction honors this value (`disruptions.md:143-145`).

## 5. Resources

- **[G] CPU limit:** enforced by throttling, and the container is never killed for CPU use (`concepts/configuration/manage-resources-containers.md:43-46, 252-254, 275-276`).
- **[G] Memory limit:** enforced reactively by OOM kills. Exceeding the memory request under node pressure makes eviction likely (`:48-54, 262-273`).
- **[G] CPU request:** acts as a weight under contention (`:255-257`).
- **[G] Effect on HPA:** utilization is measured against the request. If any container lacks a CPU request, utilization is undefined and the HPA takes no action (`tasks/run-application/horizontal-pod-autoscale.md:88-101`).
- **[C]** Set CPU and memory requests on every container, including sidecars. A CPU limit may throttle long requests, so test it under load.

## 6. HPA behaviour

- **[G] Missing metrics and not-ready Pods:** Pods with missing metrics, and Pods that are not yet ready, are set aside. Pods with a deletion timestamp are ignored and failed Pods are discarded. Missing metrics are then filled in as 100% of target on scale-down and 0% on scale-up. Not-ready Pods count as 0% on scale-up (`horizontal-pod-autoscale.md:153-191`).
- **[G] Readiness timing:** set by the initial-readiness delay (default 30 s) and the CPU initialization period (default 5 min) (`:166-178`).
- **[G] Why scaling can differ from the raw ratio:** no action within the 0.1 tolerance (`:140-147`). No action if the adjusted ratio reverses direction (`:193-197`). The status shows the unadjusted value (`:199-202`).
- **[G] Downscale stabilization:** the highest recommendation in a 300-second window wins, and scale-up has no window (`:212-218, 480-486`).
- **Interaction with slow startup:** new Pods dampen scale-up until they are ready. Size `minReplicas` with that in mind.

## 7. Network policy

- **[P]** Enforcement requires a network plugin that supports NetworkPolicy (`concepts/services-networking/network-policies.md:16, 47`).
- **[G] Isolation:** Pods are non-isolated by default. A policy that selects a Pod and lists a direction isolates the Pod for that direction (`:55-73`).
- **[G] Policies are additive:** they combine as a union, with no deny rules or ordering (`:75-77`).
- **[G] Both ends must allow:** source egress and destination ingress must both permit a connection (`:79-81`).
- **[C] Least privilege:**
  - Default-deny ingress and egress (`:214-260`).
  - Allow ingress only from the clients or ingress layer.
  - Allow egress to the database port, plus a matching ingress rule on the database Pods.
  - Allow egress to cluster DNS.
- **[N] DNS:** The NetworkPolicy docs I searched say nothing about DNS. The need for an explicit DNS egress allow follows only from egress isolation (`:62-63`) plus the fact that Pods resolve Services through DNS (`concepts/services-networking/dns-pod-service.md:15-21`). Test it.
- **[G]** Policy takes effect after a delay with no time guarantee (`network-policies.md:362-381`).

## 8. Secrets

**[G]** No. Base64 is an encoding (`concepts/configuration/secret.md:306`: "obscured but not secret"). Secrets are stored unencrypted in etcd by default (`secret.md:36-37`). **Committing base64 values to Git is therefore storing plaintext credentials.**

Required steps:
- Enable encryption at rest (`secret.md:42-48`). The default `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:64-66, 234-235, 310`).
- Grant least-privilege RBAC. `get` or `list` on Secrets exposes their contents (`concepts/security/rbac-good-practices.md:93-98`).
- Restrict Pod creation as well. Anyone who can create Pods or Deployments in the namespace can read every Secret there and act as any service account (`secret.md:38-40`, `rbac-good-practices.md:100-108`).
- **[C]** Keep secret values out of Git. Consider an external store (`secret.md:48`).

## 9. Storage reclaim policy

- **[G]** Dynamically provisioned PVs take the class `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`; `concepts/storage/persistent-volumes.md:203-210`).
- **[N]** The docs do not say whether editing the class changes PVs that already exist. They point to editing or patching each PV instead (`persistent-volumes.md:206-210`). Treat existing PVs as unchanged and patch them one by one.
- **[G] Delete vs Retain when a PVC is deleted:** `Delete` removes both the PV and the backend storage asset (`persistent-volumes.md:203-205`). `Retain` leaves the PV "Released", and the data stays until an admin reclaims it manually (`:185-200`).
- **[G] StatefulSets:** deleting or scaling down a StatefulSet does *not* delete its PVCs by default (`concepts/workloads/controllers/statefulset.md:52-54`). The optional `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`) can delete them, and it requires the `StatefulSetAutoDeletePVC` feature gate (`statefulset.md:391-412`). Once a PVC is gone, the PV's reclaim policy decides what happens to the data.
- **[C]** Use `Retain` for database volumes.

## 10. Prioritized rollout checklist

1. Remove Secrets from Git and rotate them. Enable and verify encryption at rest. Audit who can read Secrets and who can create workloads (Q8).
2. Set `Retain` on the database StorageClass and patch existing PVs. Check the StatefulSet retention policy (Q9).
3. Set requests on all containers and test any CPU limit under load (Q5). Configure HPA `minReplicas` ≥ 6 and review the stabilization windows (Q6).
4. Add the startup, readiness and liveness probes from Q3.
5. Set the rollout to `maxUnavailable: 0, maxSurge: 1` with `progressDeadlineSeconds`. Keep minAvailable 5, or use `maxUnavailable: 1`, plus AlwaysAllow (Q1).
6. Add zone and hostname spread constraints (Q2).
7. Add a preStop hook and a grace period sized from measured request times (Q4).
8. Confirm the CNI enforces NetworkPolicy. Apply default-deny, then the DNS, database and client allows, testing in staging (Q7).
9. Validate with a drain test, a zone-failure test, a rollout under load and an HPA load test.

**Still needs application or cluster validation (not guaranteed by these docs):**
- That long requests finish inside the grace period and the app handles SIGTERM correctly (Q4).
- Availability during node or zone failure: the PDB gives no protection there, and spread Pods can stay Pending (Q1, Q2).
- CNI enforcement and how long policy takes to apply, including DNS reachability (Q7).
- That surge Pods and HPA scale-up fit in cluster capacity in every zone.
- Whether platform automation drains through eviction or deletes Pods directly.
- Database failover and connection-draining behaviour. The docs don't cover these.