I have all the sources I need. Here is the memo.

---

# Decision memo: API Deployment production review (Kubernetes v1.32 docs)

**Verdict:** Do not approve the design as proposed. Three parts conflict with each other: `minAvailable: 5` on six replicas, a rollout with `maxUnavailable: 2`, and spreading across three zones. Two other parts are unsafe as configured: Secrets kept in Git as base64, and the default reclaim policy on the storage. All paths below are relative to `docs/`.

Labels: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

## 1. PDB guarantees

- **Node failure:** not protected. **[G]** "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:130-131`). A node can fail while the app is already at the minimum (`tasks/run-application/configure-pdb.md:148-155`).
- **Node drain:** protected, but only for drains that go through the Eviction API (`disruptions.md:107-116`). Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:62-65`). With six replicas and `minAvailable: 5`, only one eviction is allowed at a time. "Healthy" means Ready (`configure-pdb.md:131-132, 236-240`), so slow startup makes every drain step slower. **[P]** Confirm that your provider respects PDBs (`configure-pdb.md` prerequisites).
- **Rolling update:** not limited by the PDB. Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). `maxUnavailable: 2` therefore allows only four available Pods.
- **Recommendation [C]:** set `maxUnavailable: 0` and `maxSurge: 1`. maxSurge can be non-zero when maxUnavailable is 0 (`concepts/workloads/controllers/deployment.md:1191-1206`). For the PDB, use `maxUnavailable: 1`, which adjusts as the replica count changes (`configure-pdb.md:174-176`). Also consider `unhealthyPodEvictionPolicy: AlwaysAllow` (`disruptions.md:138-141`).

## 2. Zone spreading

- **maxSkew:** with `DoNotSchedule`, the largest allowed difference between a zone's matching Pods and the global minimum (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`).
- **topologyKey:** the node label that defines a domain. Use `topology.kubernetes.io/zone` (`:117-122`).
- **DoNotSchedule vs ScheduleAnyway:** `DoNotSchedule` leaves the Pod unscheduled. `ScheduleAnyway` schedules it anyway and only prefers placements that reduce skew (`:124-126`).
- **Recommendation [C]:** `maxSkew: 1`, the zone key, `DoNotSchedule`, and `matchLabelKeys: [pod-template-hash]` so each rollout revision is counted on its own (`:134-139`).
- **When a zone is unavailable:**
  - Losing one zone removes two of the six Pods, leaving four, which is below `minAvailable: 5`. This is an involuntary disruption, so the PDB cannot prevent it.
  - With `DoNotSchedule`, replacement Pods can stay Pending if skew would be violated.
  - **[N]** The scheduler only knows zones that currently have nodes (`:614-623`).
  - **[N]** Removing Pods can leave the spread unbalanced (`:607-611`).

## 3. Probes for slow startup

- **[C]** Add a `startupProbe` where `failureThreshold × periodSeconds` covers the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **[G]** Liveness and readiness probes do not start until the startup probe succeeds (`:31-35`, `:398-402`). If the startup probe never succeeds, the container is killed (`:346-347`).
- **Traffic stops** when readiness fails: Ready becomes false and the container keeps running (`:419-422`). A not-ready Pod is removed from Service load balancers (`:23-29`).
- **A restart happens** after `failureThreshold` consecutive liveness failures (`:412-418`).
- Readiness runs for the whole container lifetime (`:360-362`).
- Use a readiness check for database reachability, not liveness. A liveness failure restarts the container and can cascade (`:37-50`).

## 4. Termination

- **[G] Order of events:**
  1. The Pod is marked Terminating.
  2. preStop runs (`concepts/workloads/pods/pod-lifecycle.md:584-597`).
  3. SIGTERM is sent (`:603-610`).
  4. In parallel, the endpoint is marked terminating with `ready=false` (`:612-628`).
  5. SIGKILL is sent when the grace period expires (`:636-640`).
- The grace-period clock starts **before** preStop runs (`reference/kubernetes-api/workload-resources/pod-v1.md`, lifecycle.preStop). preStop time therefore uses up the 30 seconds, plus at most a one-off 2-second extension (`pod-lifecycle.md:596-601`).
- **30 seconds is not guaranteed** to finish long requests. **[C]** Size `terminationGracePeriodSeconds` from the measured p99 request duration plus preStop time. **[N]** How fast load balancers stop sending traffic is not stated.

## 5. Resources

- **[G]** Exceeding the CPU limit causes throttling, not termination (`concepts/configuration/manage-resources-containers.md:43-46, 252-254`).
- **[G]** Exceeding the memory limit can cause an OOM kill, enforced reactively (`:48-53, 261-264`).
- **[G]** The CPU request sets the share of CPU under contention (`:255-257`) and is what the scheduler places by (`:230-236`).
- If only a limit is set, the request defaults to the limit (`:63-67`).
- **[G]** If a container has no CPU request, utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`). **[C]** Set a CPU request on every container, including sidecars.

## 6. HPA behaviour

- Pods that are being deleted or have failed are ignored (`horizontal-pod-autoscale.md:153-158`).
- Pods with missing metrics, and Pods that are not yet ready, are set aside (`:160-178`).
- The ratio is then recalculated conservatively:
  - Missing metrics count as 100% of target when scaling down and 0% when scaling up.
  - Not-yet-ready Pods count as 0% when scaling up.
  - If the result reverses direction or falls within the 0.1 tolerance, nothing happens (`:141-147, 183-197`).
- The reported utilization stays the raw value (`:199-202`).
- The default downscale stabilization window is 5 minutes and uses the highest recommendation within it (`:213-218`).
- Actual scaling can differ from the raw ratio because of: set-aside Pods, tolerance, stabilization, and the 30 s / 5 min readiness windows (`:167-178`), which interact with slow startup.
- **[C]** Set `minReplicas ≥ 6` so the HPA cannot shrink the app below the PDB headroom. **[P]** Metrics Server must be installed (`:113-118`).

## 7. Least-privilege networking

- **[G]** Pods are non-isolated by default. Any policy that selects a Pod for a direction isolates it in that direction, and policies add together as a union (`concepts/services-networking/network-policies.md:51-77`).
- **[G]** A connection needs both the source's egress policy and the destination's ingress policy to allow it (`:79-81`).
- **[C] Plan:**
  1. Default-deny ingress and egress (`:214-242`, plus the deny-all section that follows).
  2. Allow ingress from the client tier on the API port.
  3. Allow egress to the database's selector and port.
  4. Allow ingress on the database side as well.
  5. Allow egress for DNS.
- **[N]** These docs do not give DNS-specific policy details; check your cluster DNS service and ports.
- **[P]** Without a network plugin that enforces NetworkPolicy, the policies have no effect (`:45-49, 92-95`).
- **[N]** Whether NAT happens before or after policy evaluation depends on the plugin (`:196-206`).

## 8. Secrets

- **Base64 is not protection.** Base64 values are "obscured but not secret" (`concepts/configuration/secret.md`, Docker config caution). Secrets are stored unencrypted in etcd by default (`secret.md:35-40`; `tasks/administer-cluster/encrypt-data.md:55-66`). Storing them in Git as base64 is equivalent to plaintext.
- **[C] Steps:**
  - Enable encryption at rest with a non-`identity` provider first in the list. Then rewrite all existing Secrets so they are encrypted (`encrypt-data.md:58-73`).
  - Least-privilege RBAC: namespace-scoped RoleBindings and no wildcards (`concepts/security/rbac-good-practices.md:25-45`). `list` and `watch` reveal Secret contents just as `get` does (`:93-98`).
- **Pod creation matters:** anyone who can create Pods or Deployments in a namespace can read every Secret there, and can run as any service account in it (`secret.md:38-40`; `rbac-good-practices.md:100-119`).

## 9. Storage reclaim

- **[G]** Dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
  - **Retain:** deleting the PVC leaves the PV "released". Cleanup is manual (`concepts/storage/persistent-volumes.md:185-199`).
  - **Delete:** deleting the PVC removes the PV and the backing storage asset (`:201-210`).
- **Changing the StorageClass:** the docs say a PV "must be edited or patched after it is created" if the class does not match expectations (`:207-210`). This implies a class change does not reach existing PVs. **[N]** No retroactive behaviour is stated, and the linked task page is not in this corpus.
- **StatefulSet:** `persistentVolumeClaimRetentionPolicy` `whenDeleted` / `whenScaled` defaults to `Retain`. It applies only when the StatefulSet is deleted or scaled down, not when a Pod fails (`concepts/workloads/controllers/statefulset.md:387-423`).
- If you delete a PVC yourself, its PV's reclaim policy decides what happens to the data.

## 10. Prioritized checklist

1. Change the rollout to `maxSurge: 1, maxUnavailable: 0`, the PDB to `maxUnavailable: 1`, and the HPA `minReplicas` to ≥ 6.
2. Add a zone spread constraint (maxSkew 1, DoNotSchedule, pod-template-hash). Size capacity so that losing one zone still leaves enough Pods.
3. Add startup, readiness and liveness probes, measured against real startup time.
4. Set grace period ≥ preStop time + p99 request duration. Test the drain under load.
5. Set CPU and memory requests on all containers. Set a memory limit. Decide on a CPU limit only after testing for throttling.
6. Enable encryption at rest, remove plaintext Secrets from Git, and audit RBAC (Secrets and Pod creation).
7. Apply default-deny plus explicit allows (API, database, DNS). Verify that the plugin enforces them.
8. Use a `Retain` StorageClass for database volumes. Patch existing PVs and confirm the change.

**Limits that still need validation, not guaranteed by these docs:**
- The PDB cannot protect against node or zone failure.
- Drain progress with slow startup.
- Whether 30 s (or any value) is enough for long requests, and how quickly load balancers stop sending traffic.
- How autoscaled node pools handle zones with no nodes.
- Whether the CNI enforces NetworkPolicy, and how it handles DNS and NAT.
- Whether existing PVs keep their old reclaim policy.
- Database connection limits when the HPA scales out (not covered by the docs at all).