# Decision memo: API Deployment production readiness (Kubernetes v1.32 docs)

**Verdict: Do not approve as proposed.** Four parts of the design conflict with what the docs say: the PDB together with `maxUnavailable: 2`, the default-allow network, base64 Secrets committed to Git, and the assumption that 30 seconds is always enough. The other parts are workable once the settings below are added and tested. Each finding is labelled **[G]** (guaranteed by the docs), **[C]** (a configuration choice), **[P]** (a prerequisite) or **[N]** (not established by these docs). All paths are relative to `docs/`.

---

### 1. Does `minAvailable: 5` guarantee five available replicas?

**No.**

- **Node failure.** **[G]** A node failure is an involuntary disruption. A PDB cannot prevent it, although the lost Pods do count against the budget (`concepts/workloads/pods/disruptions.md:26-34, 130-131`). The docs say plainly that a budget "does not truly guarantee" the number of Pods that stay up (`tasks/run-application/configure-pdb.md:148-155`).
  - With two replicas per zone, losing one zone leaves four, which is below five.
- **Node drain.** **[G]** `kubectl drain` uses the Eviction API, so the PDB is enforced. Evictions are allowed only while at least five Pods stay healthy, meaning Ready (`configure-pdb.md:131-132, 238-240`). Rejected evictions are retried until a timeout (`disruptions.md:107-121`).
  - With six healthy Pods, one eviction is allowed at a time. If any Pod is unready, the drain stalls.
  - **[C]** Set `unhealthyPodEvictionPolicy: AlwaysAllow` so that Pods in CrashLoopBackOff cannot block a drain (`configure-pdb.md:254-273`; `disruptions.md:138-139`).
- **Rolling update.** **[G]** A Deployment is **not limited** by its PDB during a rolling update. Pods removed by the update still use up the budget (`disruptions.md:133-136`).
  - `maxUnavailable: 2` lets availability drop to four (`concepts/workloads/controllers/deployment.md:1191-1199`). That breaks the intent of the PDB and blocks any drain running at the same time.
  - Deleting Pods or Deployments directly also bypasses the PDB (`disruptions.md:62-65`).

**Recommendation [C]:**
- Rollout: `maxUnavailable: 0` and `maxSurge: 1`, which is valid because only one of the two may be 0 (`deployment.md:1194, 1203-1206`). Add `minReadySeconds` so a new Pod must stay Ready for a while before it counts as available (`deployment.md:1323-1328`).
- PDB: replace it with `maxUnavailable: 1`. If HPA scales the Deployment down to five replicas, a fixed `minAvailable: 5` would allow zero evictions (`configure-pdb.md:157-158`).

### 2. Zone spreading

**[G]**
- `topologyKey` names a node label. Each distinct label value is one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- With `DoNotSchedule`, `maxSkew` is the largest allowed gap between a domain's matching Pods and the global minimum. With `ScheduleAnyway`, the scheduler only prefers placements that reduce skew (`:82-93`).
- `DoNotSchedule` is the default and leaves the Pod unscheduled. `ScheduleAnyway` places it anyway (`:124-126`).

**[C]** Use `topology.kubernetes.io/zone` with `maxSkew: 1`, plus `matchLabelKeys: [pod-template-hash]` so the spread is calculated per revision during rollouts (`:134-159`). Add a hostname constraint as well.

**When a zone is unavailable:**
- **[G]** `nodeTaintsPolicy` defaults to Ignore, so tainted nodes still count in the skew calculation (`:179-185`). Under `DoNotSchedule`, replacement Pods may therefore stay Pending.
- **[G]** The node controller's eviction rate depends on zone health (`concepts/architecture/nodes.md:237-259`).
- **[G]** Spread is not maintained when Pods are removed, for example on scale-down. A zone with no nodes is not counted as a domain at all (`topology-spread-constraints.md:605-623`).

**Recommendation:** use `ScheduleAnyway` for the zone constraint, or accept the Pending risk, and test it.

### 3. Probes for slow startup

**[G]**
- **Startup probe.** While it is defined, all other probes are disabled until it succeeds. If it fails, the container is killed and restarted under its restart policy (`concepts/workloads/pods/pod-lifecycle.md:492-497`). Size `failureThreshold × periodSeconds` to cover the worst-case startup time; for example 30 × 10 gives 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **Liveness and readiness delays** do not start counting until the startup probe has succeeded (`…probes.md:398-402`).
- **Readiness failure** removes the Pod from Service endpoints, so traffic stops, but the container keeps running. **Liveness failure** restarts the container (`pod-lifecycle.md:479-490`; `…probes.md:412-422`).
- Readiness runs for the container's whole life, and it does not depend on liveness (`…probes.md:360-368`).

**[C]**
- Startup and liveness probes should check the same cheap endpoint (`pod-lifecycle.md:552-557`).
- Readiness may include backend checks such as the database (`:524-528`).
- Keep the database out of liveness. That is my inference: the docs describe liveness as a check on the app itself.

### 4. Termination

**[G]**
- Deletion records a grace period, which defaults to 30 s. The kubelet runs `preStop` first. If the hook is still running when the grace period ends, it gets a one-off 2 s extension, and the docs say you must raise `terminationGracePeriodSeconds` if the hook needs longer (`pod-lifecycle.md:581-601`).
- The kubelet then sends TERM, or the image's STOPSIGNAL. When the grace period expires, it sends SIGKILL (`:572-577, 603-610, 636-644`).
- Meanwhile the endpoints of the terminating Pod stay in the EndpointSlice with `ready=false`, and draining logic can read the `serving` condition (`:612-632`; `concepts/services-networking/endpoint-slices.md:89-115`).
- A deleted Pod becomes unready automatically (`pod-lifecycle.md:536-542`).

**Is 30 s enough? [N]** Nothing guarantees it. The `preStop` hook and request draining both come out of the same 30 s. Set the grace period above the longest request plus the drain delay, and measure it. A probe-level `terminationGracePeriodSeconds` can shorten liveness kills (`…probes.md:523-563`).

### 5. Resources

**[G]**
- **CPU limit:** enforced by throttling. It is a hard cap, and the container is not killed for using too much CPU (`concepts/configuration/manage-resources-containers.md:43-46, 252-257, 275-276`).
- **Memory limit:** enforced reactively by the OOM killer (`:48-53, 261-265`).
- **Memory request:** a container that uses more than its request risks eviction when the node runs short of memory (`:271-273`).
- **Limit without a request:** the limit is copied as the request (`:64-66`).
- **HPA:** utilization is calculated against the request. If any container lacks a CPU request, utilization is undefined and HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`).

**[C]** Set a CPU request on every container, including sidecars. Set a memory request and a memory limit. A CPU limit is optional; measure its throttling effect on long requests.

### 6. HPA behaviour

**[G]**
- The base formula is `ceil(current × ratio)`, with a ±0.1 tolerance (`horizontal-pod-autoscale.md:131-147`).
- Pods being deleted and failed Pods are ignored. Pods with missing metrics, or not yet ready, are set aside (`:153-178`).
- When recalculating, missing Pods are assumed to use 100% on scale-down and 0% on scale-up. Not-yet-ready Pods are assumed to use 0% on scale-up. If that reverses the scaling direction, or lands inside the tolerance, nothing happens (`:183-197`).
- Status reports the raw value (`:199-202`).
- Downscaling takes the highest recommendation within a 5-minute window, which defaults to 300 s. Scale-up has no window (`:213-218, 480-486`).
- With slow startup, scale-ups are damped by design.

**[P]** The Metrics Server has to be installed (`:113-118`).

### 7. Networking (least privilege)

**[G]**
- Pods are not isolated by default. A Pod becomes isolated in a direction once any policy selects it with that direction in `policyTypes` (`concepts/services-networking/network-policies.md:59-73`).
- Policies add together, and both the source's egress and the destination's ingress must allow a connection (`:75-81`).
- Default-deny for both directions is shown at `:254-262`.

**[P]** The network plugin must enforce NetworkPolicy, or policies "have no effect" (`:45-49`).

**[N]** Behaviour for protocols other than TCP, UDP and SCTP is undefined (`:275-279`). When enforcement takes effect is not visible through the API (`:362-384`).

**[C]** Apply default-deny, then allow:
- ingress from the ingress or load balancer source to the app port;
- egress from the API to the database Pods or CIDR;
- ingress on the database side as well;
- egress to DNS. kube-dns listens on 53/UDP and 53/TCP (`tasks/administer-cluster/dns-debugging-resolution.md:168`).

The NetworkPolicy page does not mention DNS. Allowing it is my inference from egress isolation.

### 8. Secrets

**base64 is not protection.** **[G]** The docs call it "obscured but not secret" (`concepts/configuration/secret.md:306`).
- Secrets are stored unencrypted in etcd by default.
- Anyone allowed to create Pods, or indirectly Deployments, in the namespace can read every Secret in it (`secret.md:35-48`; `concepts/security/rbac-good-practices.md:100-105`).
- `list` and `watch` permissions also reveal Secret contents (`rbac-good-practices.md:93-98`).

**[P/C]**
- Enable encryption at rest with a non-`identity` first provider; `identity` gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:55-73, 310-311`). Prefer KMS, because a locally stored key does not protect against a compromised host (`:317-330`).
- Re-write the existing Secrets so they get encrypted (`:590-603`).
- Use separate namespaces (`secret.md:667-673`).
- Remove plaintext from Git. The docs do not cover Git; this follows from the base64 finding.

### 9. Storage reclaim policy

**[G]**
- Dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which defaults to `Delete`. Changing it on existing PVs means editing or patching each PV (`concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:201-210`).
- **[N]** The docs do not say that changing a StorageClass updates PVs that already exist. Assume it does not.
- **Retain:** deleting the PVC leaves the PV "Released", with the data and the storage asset kept for manual reclamation (`persistent-volumes.md:185-199`).
- **Delete:** deleting the PVC removes both the PV and the backend asset (`:201-205`).
- **StatefulSets:** deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-53`). `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default Retain) covers only those two events, not replacing a Pod after a node failure (`:387-423`).
- The database volume is still deleted if its PVC is deleted while the policy is `Delete`.

**[C]** Use `Retain` for the database and `WaitForFirstConsumer` for zonal storage (`storage-classes.md:177-187`).

### 10. Prioritized rollout and validation checklist

1. **Secrets:** enable KMS encryption at rest, rewrite existing Secrets, purge base64 from Git, and restrict RBAC for get/list/watch and workload creation (Q8).
2. **Storage:** patch the database PVs to `Retain` and verify each one individually (Q9).
3. **CPU requests:** add them to every container and confirm the Metrics Server is present (Q5, Q6).
4. **Probes:** startup, liveness and readiness probes sized from measured startup time (Q3).
5. **Rollout and PDB:** `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds`; PDB `maxUnavailable: 1` with `AlwaysAllow`; HPA `minReplicas` of at least 6 (Q1).
6. **Spreading:** zone and hostname constraints with `matchLabelKeys` (Q2).
7. **Termination:** a `preStop` drain and a grace period set from measurements (Q4).
8. **Network:** default-deny plus explicit allows, applied to staging first (Q7).
9. **Game days:** a node drain, a zone outage, a rollout during load, and an HPA spike.

**Limits that need application or cluster validation (not guaranteed by these docs):**
- **[N]** Whether the CNI enforces NetworkPolicy, how quickly, and how it treats protocols other than TCP, UDP and SCTP (Q7).
- **[N]** Whether the grace period covers the longest requests and database connection draining, and whether the load balancers honour `serving` (Q4).
- **[N]** Whether surviving zones have capacity for rescheduled Pods, and whether node autoscaling understands topology. A zone with zero nodes is invisible to the scheduler (Q2).
- **[N]** Availability during a zone loss. Two Pods per zone means four survivors, which is below the five the team wants (Q1). Either accept that or move to nine replicas, after testing capacity.
- **[N]** How the database tolerates connection churn and how its backups and restores behave. These docs do not cover either.