# Decision memo: production API on Kubernetes v1.32

**Verdict: Do not approve the design as proposed.** Four parts conflict with what the supplied docs say: the PDB/rollout pairing, the 30-second grace period for long requests, base64 Secrets in Git, and default-allow networking. The storage reclaim policy also needs an explicit decision. Paths are relative to `docs/`.

---

### 1. Does the PDB guarantee five available replicas?

No, not in any of the three cases.

- **Node failure.** This is an involuntary disruption (`concepts/workloads/pods/disruptions.md:21-35`). The docs state that PDBs cannot prevent involuntary disruptions, although those losses still count against the budget (`disruptions.md:130-131`). If a zone fails and takes two Pods, you are at four.
- **Node drain.** `kubectl drain` uses the Eviction API, which respects the PDB. It retries rejected evictions until the Pods are gone or a timeout is reached (`disruptions.md:107-116`). With 6 replicas and `minAvailable: 5`, only one eviction is allowed at a time (`disruptions.md:118-121`). One caveat: deleting Pods or Deployments directly bypasses PDBs (`disruptions.md:57-60`).
- **Rolling update.** Pods taken down by a rollout count against the budget, but Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can drop to 4 during a rollout (`concepts/workloads/controllers/deployment.md:1189-1200`).

**Recommendation:** use `maxUnavailable: 0` and `maxSurge: 1`. That combination is valid as long as both are not 0 (`deployment.md:1194,1205-1206`), and it keeps the minimum at the desired count. Add `unhealthyPodEvictionPolicy: AlwaysAllow` so a drain is not blocked by Pods that are already unhealthy (`disruptions.md:138-141`).

The docs do not establish that you will have spare capacity to schedule surge Pods. `tutorials/stateful-application/zookeeper.md:1150-1153` advises allocating extra capacity.

### 2. How should replicas be spread across zones?

- **topologyKey.** Use `topology.kubernetes.io/zone`. Nodes that share a label value form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:118-123`).
- **maxSkew.** Use `maxSkew: 1`. Under `DoNotSchedule`, maxSkew is the maximum difference between a zone's Pod count and the global minimum (`:82-91`).
- **DoNotSchedule vs ScheduleAnyway.** `DoNotSchedule` (the default) refuses placements that would break the constraint. `ScheduleAnyway` only prefers zones that reduce skew (`:125-127`), and that preference is weighed together with other scoring (`:351-354`).
- **minDomains.** Setting `minDomains: 3` (only valid with DoNotSchedule) makes the scheduler treat the global minimum as 0 when fewer zones are eligible (`:95-116`).

**When a zone is unavailable:** with `DoNotSchedule`, replacement Pods can stay `Pending` (`:295`, `:416`). The scheduler only knows about zones that currently have nodes, so a node group scaled to zero is invisible to it (`:614-622`). Constraints are also not re-enforced after Pods are removed, for example on scale-down (`:607-608`).

Without your own constraints, the built-in default for zones is only `maxSkew: 5` with ScheduleAnyway (`:537-546`).

**Recommendation:** zone spread with `DoNotSchedule` and `minDomains: 3`, plus a hostname spread with `ScheduleAnyway`. Accept that some replicas may be Pending during a zone outage.

### 3. Which probes fit slow startup?

- **startupProbe.** Use the same check as the liveness probe, with `failureThreshold × periodSeconds` covering the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). All other probes are disabled until it succeeds. If it fails, the container is killed (`concepts/workloads/pods/pod-lifecycle.md:494-499`), and readiness/liveness delays don't start until it passes (`probes…md:398-402`).
- **readinessProbe.** When it fails, traffic stops: the Pod's IP is removed from the Service endpoints (`pod-lifecycle.md:485-490`). The container is not restarted, probing continues, and the Pod's `Ready` condition becomes false (`probes…md:419-423`).
- **livenessProbe.** After `failureThreshold` consecutive failures (default 3), the container is restarted, honoring the grace period (`probes…md:413-418`).

Keep liveness checks local to the process. The docs do not establish whether health endpoints should depend on the database. That is an application decision.

### 4. Termination order — is 30 seconds enough?

Not guaranteed.

1. The Pod is marked Terminating and the grace-period clock starts **before** preStop runs (`reference/kubernetes-api/workload-resources/pod-v1.md:1700-1702`).
2. preStop runs inside that window. If it overruns, the kubelet grants a one-off extra 2 seconds (`pod-lifecycle.md:584-601`).
3. TERM is sent to PID 1 in each container (`:603-610`).
4. When the grace period expires, anything still running gets `SIGKILL` (`:636-640`).

In parallel, the Pod's endpoint is marked terminating with `ready=false`, so load balancers stop sending it regular traffic. `serving` shows whether it is still actually serving (`:612-631`).

The default is 30 seconds (`:593-594`). If your long requests plus preStop can exceed that, set `terminationGracePeriodSeconds` to cover them (`:598-601`). The real worst-case request duration, and whether your app handles SIGTERM correctly, have to be measured.

### 5. CPU and memory resources

- **CPU limits** are enforced by throttling, a hard cap (`concepts/configuration/manage-resources-containers.md:42-46`). They "can have unintended effects on auto-scaling" (`concepts/security/security-checklist.md:142-148`).
- **Memory limits** are enforced by OOM kill, reactively and only under memory pressure (`manage-resources-containers.md:48-54`). A memory limit above the request can expose the whole node to OOM (`security-checklist.md:150-152`).
- **Limit without request:** if you set only a limit, the limit is copied as the request (`manage-resources-containers.md:63-67`).
- **Missing CPU requests and HPA:** HPA computes utilization as a percentage of the request. If any container lacks a CPU request, utilization is undefined and **the HPA takes no action** (`tasks/run-application/horizontal-pod-autoscale.md:89-103`).

**Recommendation:** set CPU requests on every container, and set memory request equal to limit.

### 6. HPA behaviour

- Pods that are not yet ready, and pods with missing metrics, are set aside. Missing pods are then counted as 100% usage on scale-down and 0% on scale-up. Not-yet-ready pods count as 0% on scale-up. If the recomputed ratio reverses direction or falls within tolerance, no scaling happens (`horizontal-pod-autoscale.md:184-197`).
- The status still reports the raw average (`:199-202`).
- A Pod is "not yet ready" based on the initial-readiness delay (default 30s) and the CPU initialization period (default 5 min) (`:167-179`). This matters for slow startup.
- The default scale-down stabilization window is 300 seconds. Scale-up is immediate, limited to +4 Pods or +100% per 15 seconds (`:455-486`).
- Metrics come from `metrics.k8s.io`, usually Metrics Server, which must be deployed separately (`:115-118`). That is a prerequisite.

### 7. Least-privilege networking

- Pods are non-isolated by default. Ingress and egress isolation are separate, each triggered by any policy that selects the Pod and lists that direction in `policyTypes` (`concepts/services-networking/network-policies.md:51-72`).
- Policies are additive: the allowed set is the union of all applicable policies (`:74-76`).
- A connection needs **both** egress allowed on the source and ingress allowed on the destination (`:78-80`).
- Start with default-deny egress (`:234-242`) and default-deny ingress. Then allow ingress from the client/ingress Pods to the API port, and egress from the API to the database port only (rule format: `:120-137`).
- **Prerequisite:** NetworkPolicy does nothing without a network plugin that implements it (`:45-49`).
- Whether policy changes affect existing connections is implementation-defined (`:464-472`).

DNS: I found no passage in this corpus on allowing DNS egress. Under default-deny egress, name lookups will fail unless you explicitly allow them, so add a DNS egress rule and test it. The required selector or port is not established here.

### 8. Is base64 enough for Secrets?

No. Secrets are stored unencrypted in etcd by default, and anyone with API or etcd access can read them (`concepts/configuration/secret.md:35-38`). The required steps are:

- encryption at rest;
- least-privilege RBAC;
- restricting Secret access to specific containers;
- considering an external secret store (`secret.md:39-53`).

**Pod creation matters too:** anyone allowed to create a Pod, or a Deployment, in a namespace can read every Secret there (`secret.md:38-40`). They can also use any ServiceAccount's API access in that namespace. Namespace boundaries are weak (`concepts/security/rbac-good-practices.md:100-120`).

Base64 Secret manifests in Git are effectively plaintext. Remove them and rotate those credentials.

### 9. StorageClass reclaim policy

- Dynamically provisioned PVs take their reclaim policy from the StorageClass at creation, and the default is `Delete` (`concepts/storage/storage-classes.md:126-135`).
- The docs say that if the class doesn't match expectations, "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). So changing the class should not be assumed to change existing PVs. Patch each PV. The docs I found do not say whether the class itself can be updated.
- **Delete** removes the PV object and the backing storage asset (`:201-205`).
- **Retain** keeps the PV in a "released" state after the PVC is deleted. An admin must clean it up and delete it by hand (`:185-199`).
- **PVC deletion** is what triggers the reclaim policy (`:180-183`).
- **StatefulSet deletion or scale-down** by default keeps its PVCs (`Retain`). `persistentVolumeClaimRetentionPolicy` can change that and requires the `StatefulSetAutoDeletePVC` feature gate. Node-failure replacements reuse the existing PVC (`concepts/workloads/controllers/statefulset.md:387-436`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-143`).

**Recommendation:** use `Retain` for database data.

### 10. Prioritized rollout and validation checklist

1. Rotate the credentials, remove Secret manifests from Git, enable encryption at rest, and tighten RBAC, including who can create Pods/Deployments (Q8).
2. Set `maxUnavailable: 0` and `maxSurge: 1`, keep `minAvailable: 5`, and set `unhealthyPodEvictionPolicy: AlwaysAllow` (Q1).
3. Add CPU and memory requests, set memory request = limit, reconsider CPU limits, and confirm Metrics Server is running (Q5, Q6).
4. Add startup, readiness and liveness probes, and size the startup budget from measurements (Q3).
5. Set `terminationGracePeriodSeconds` to at least the longest request plus preStop time, and test SIGTERM handling (Q4).
6. Add zone and hostname topology spread (Q2).
7. Apply default-deny NetworkPolicies plus explicit allows for the API port, the database, and DNS; first confirm the CNI enforces them (Q7).
8. Patch existing database PVs to `Retain` and set `reclaimPolicy: Retain` on the class (Q9).
9. Drain one node, run a rollout, and simulate a zone loss while monitoring availability.

**Limits that need application or cluster validation (the docs do not guarantee them):**

- Real request durations versus the grace period.
- Worst-case startup time.
- Spare capacity for surge and rescheduled Pods.
- Whether the CNI enforces NetworkPolicy, and how it treats existing connections.
- The DNS egress rule.
- Node-autoscaler awareness of all zones.
- Whether the database tolerates connection churn during rollouts.
- Backup and restore of the PVs.