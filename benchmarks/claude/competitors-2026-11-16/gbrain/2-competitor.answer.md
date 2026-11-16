# Decision memo: production readiness of the six-replica API

**Recommendation:** don't approve the design as proposed. The PDB and rollout settings conflict with each other. A 30-second grace period is not shown to be safe for long requests. Default-allow networking and base64 Secrets in Git do not protect anything. Every finding below is labelled **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, or **[N]** not established by the docs. All paths are relative to `docs/`.

## 1. PDB `minAvailable: 5`

- **Node failure:** **[G]** A PDB cannot prevent involuntary disruptions, although they count against the budget (`concepts/workloads/pods/disruptions.md:130-131`, examples at 26-34). If a node holding two replicas fails, availability drops to 4 regardless of the PDB.
- **Node drain:** **[G]** `kubectl drain` goes through the Eviction API. A rejected eviction is retried until the drain succeeds or times out (`disruptions.md:107-116`). With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time (same logic as 118-121). If one replica is already down or still starting, drains block (195-197). **[P]** Cluster tooling has to use the Eviction API. Deleting Pods or Deployments bypasses PDBs (62-65).
- **Rolling update:** **[G]** Deployments are *not limited* by PDBs during rolling upgrades. Those Pods still count against the budget (`disruptions.md:133-136`). So `maxUnavailable: 2` can take availability down to 4, and a drain at the same moment would be refused.
- **Recommendation [C]:** use `maxUnavailable: 0` and `maxSurge: 1` (allowed, because only one of the two may be 0, `concepts/workloads/controllers/deployment.md:1191-1211`). Consider `unhealthyPodEvictionPolicy: AlwaysAllow` so a misbehaving Pod doesn't stall drains (`disruptions.md:138-141`). Set HPA `minReplicas ≥ 6`, because the PDB's intended count follows `.spec.replicas` (126-128). Don't set `.spec.replicas` in the manifest while an HPA manages scaling (`deployment.md:1135-1140`).

## 2. Zone spreading

- **[C]** Use `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1`, `whenUnsatisfiable: DoNotSchedule`, and `matchLabelKeys: [pod-template-hash]` so each revision is spread independently. Add a second hostname constraint with `ScheduleAnyway`.
- **[G] What the fields mean:**
  - `maxSkew` is the maximum allowed difference from the global minimum when `DoNotSchedule` is set. `ScheduleAnyway` only prefers placements that reduce skew (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`, 124-126).
  - `topologyKey` names a node label, and each value of it is a domain (117-122). Use the well-known label keys (206-214).
  - Multiple constraints are combined with AND (192-194). `matchLabelKeys` covers revisions (134-160).
- **Zone unavailable:** **[G]** Removing Pods does not rebalance them (607-611). Domains are discovered from existing nodes, so a zone with zero nodes is not counted (614-619). **[N]** The docs don't say exactly whether `DoNotSchedule` leaves replacement Pods Pending during a partial zone outage. Test this. With `ScheduleAnyway`, the scheduler still places the Pod and only prefers lower skew (126).

## 3. Probes for slow startup

- **[C]** Add a `startupProbe` on the same endpoint as liveness. Set `failureThreshold × periodSeconds` to cover the *worst-case* startup time, and leave the liveness defaults alone (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `concepts/workloads/pods/pod-lifecycle.md:544-557`).
- **[C]** Give readiness its own endpoint (`pod-lifecycle.md:520-528`).
- **[G] When things happen:**
  - All other probes are disabled until the startup probe succeeds (`pod-lifecycle.md:492-497`).
  - A failing startup or liveness probe kills the container, which is then subject to the restart policy (480-483, 495-496).
  - A failing readiness probe removes the Pod from Service endpoints. Traffic stops, but there is no restart (485-490).
  - Readiness runs for the container's whole lifecycle (`configure-...-probes.md:360-368`).
- **[N]** Don't make liveness depend on the database. The docs only say readiness *may* check backends (`pod-lifecycle.md:524-528`).

## 4. Termination

**[G] Order of events:**
1. Deletion sets the grace-period deadline (`pod-lifecycle.md:584-589`).
2. `preStop` runs *inside* that grace period. If it is still running when the period ends, the kubelet grants a one-off 2-second extension (591-601).
3. SIGTERM (or the image's STOPSIGNAL) goes to each container (572, 603-610).
4. When the period expires, SIGKILL is sent (573, 636-639).
5. At the same time as shutdown starts, endpoints are marked terminating with `ready=false`. They are not removed immediately (612-632).

Evictions from drains also honour `terminationGracePeriodSeconds` (`disruptions.md:143-145`).

**Is 30 seconds enough? [N]** Nothing guarantees it, and it is only the default (`pod-lifecycle.md:594`). **[C]** Set the grace period to `preStop` time plus the longest request plus a margin. The application must also stop accepting new work when it receives SIGTERM.

## 5. Resources

- **[G] CPU:** A CPU limit is enforced by throttling and is a hard ceiling. Memory limits are enforced reactively by OOM kills (`concepts/configuration/manage-resources-containers.md:43-53`, 252-265). A CPU request works as a weighting under contention and is used for scheduling (230-241, 255-257). A limit without a request is copied as the request (63-67).
- **[G] HPA:** If any container lacks a CPU request, CPU utilization is undefined and the HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:99-102`).
- **[C]** Set CPU requests on *every* container. Base the memory limit on measured peak usage.

## 6. HPA behaviour

- **[G] Missing metrics:** The Pod is set aside. The controller then assumes 100% of target for a scale-down and 0% for a scale-up (`horizontal-pod-autoscale.md:160-161`, 183-186).
- **[G] Not-yet-ready Pods:** These are set aside for CPU and treated as 0% on scale-up. Two windows apply: the 30-second initial-readiness delay and the 5-minute CPU initialization period (163-178, 188-191).
- **[G] Why scaling differs from the raw ratio:**
  - The 0.1 tolerance (145-147).
  - A recalculated ratio that reverses direction cancels the action (193-197).
  - The status shows the unadjusted value (199-202).
  - With multiple metrics, the largest recommendation wins (204-211).
  - The default 5-minute downscale stabilization picks the highest recommendation in that window (213-218).
- **[P]** Metrics Server has to be installed (113-118).

## 7. Least-privilege networking

- **[P]** NetworkPolicy has no effect unless the CNI plugin implements it (`concepts/services-networking/network-policies.md:45-49`, 92-95).
- **[G] How policies work:**
  - Pods are non-isolated by default. A policy that selects a Pod with `Ingress` or `Egress` in `policyTypes` isolates that direction, and the allowed set is the union of all applicable policies (59-77).
  - A connection needs the source's egress *and* the destination's ingress to allow it (79-81).
  - Traffic from the Pod's own node is always allowed (35-36, 70-71).
  - Behaviour for protocols other than TCP/UDP/SCTP is undefined (275-279).
- **[C] Policies to apply:**
  - Namespace default-deny for both directions (254-262).
  - Allow ingress to the API port from the ingress or client namespace only.
  - Allow API egress to the database port.
  - Allow ingress on the database side from the API Pods.
  - Allow egress to cluster DNS.
- **[N]** The page I reviewed has no DNS recipe. That default-deny egress blocks DNS lookups is my inference from 236-242, not something the page states, so test it.

## 8. Secrets

- **[G]** Base64 is not protection. By default Secrets are stored *unencrypted* in etcd. Anyone with API or etcd access can read them, and so can anyone who can create a Pod or Deployment in the namespace (`concepts/configuration/secret.md:35-40`).
- **[C] Required steps:**
  - Encryption at rest (`secret.md:44`; `tasks/administer-cluster/encrypt-data.md:14-24`). It covers API data only, not copies in Git or mounted volumes (21-32).
  - Least-privilege RBAC: namespace-scoped RoleBindings and no wildcards (`concepts/security/rbac-good-practices.md:25-36`). Note that `list` and `watch` also reveal Secret contents (95-98).
  - Limit who can create workloads. That permission implicitly grants access to the namespace's Secrets and ServiceAccounts (100-108, 117-120).
  - Consider an external secret store (`secret.md:48`).
- **[C]** Remove plaintext-equivalent Secrets from Git and rotate them.

## 9. Storage reclaim policy

- **[G]** A StorageClass's `reclaimPolicy` applies to PVs at dynamic provisioning and defaults to `Delete` (`concepts/storage/storage-classes.md:34-36`, 126-135).
- **[G]** Dynamically provisioned PVs inherit the class policy. To change it afterwards, you edit or patch the PV itself (`concepts/storage/persistent-volumes.md:205-210`).
- **[N]** The docs don't say that changing the class updates existing PVs. Treat each existing PV as unchanged and patch it explicitly.
- **[G] Retain vs Delete:** With `Retain`, deleting the PVC leaves the PV "Released" and its data in place for manual cleanup (185-199). With `Delete`, both the PV and the external storage asset are removed (201-205).
- **[G] PVC deletion vs StatefulSet deletion/scaling:** Deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). The `whenDeleted` and `whenScaled` settings default to `Retain` and apply only to deletion or scale-down, not to Pod replacement after node failure (395-423).
- **[N]** An API Deployment shouldn't own database volumes. Confirm the storage design separately.

## 10. Prioritized rollout and validation checklist

1. Move Secrets out of Git and rotate them. Enable encryption at rest. Restrict RBAC for Secrets and workload creation. (§8)
2. Confirm the CNI enforces NetworkPolicy. Apply default-deny plus explicit allows (clients→API, API→DB, API→DNS, DB ingress), then test from both ends. (§7)
3. Set PVs holding database data to `Retain` and verify each PV individually. (§9)
4. Add CPU and memory requests and a memory limit, install Metrics Server, set HPA `minReplicas ≥ 6`, and remove `.spec.replicas` from the manifest. (§5, §6)
5. Add startup, readiness and liveness probes sized to the measured worst-case startup. (§3)
6. Rollout settings: `maxUnavailable: 0`, `maxSurge: 1`, PDB `minAvailable: 5` with `AlwaysAllow`. (§1)
7. Add zone spread with `maxSkew: 1` and `DoNotSchedule`, plus a hostname constraint with `ScheduleAnyway`. (§2)
8. Raise the grace period above `preStop` plus the longest request, and implement SIGTERM draining in the application. (§4)
9. Run game days: drain a node during a rollout, fail a node, take out a zone, and run an HPA load test.

**Limits these documents don't guarantee and that need testing:**
- That requests finish within the grace period, and how the application behaves on SIGTERM.
- The worst-case startup time that the probe thresholds depend on.
- Whether the CNI enforces NetworkPolicy, and how it handles DNS and protocols other than TCP/UDP.
- Whether each zone has spare capacity for surge and replacement Pods, and how Pending Pods behave when a zone fails.
- Whether cluster or provider automation uses the Eviction API.
- How many connections the database can take when the HPA scales up. The docs don't address this.