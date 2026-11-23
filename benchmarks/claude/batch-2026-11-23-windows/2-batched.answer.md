# Decision memo: six-replica API rollout on Kubernetes v1.32

**Verdict: not approved as proposed.** These parts of the design conflict with the documentation: a PDB of `minAvailable: 5` combined with `maxUnavailable: 2`, the default-allow network, Secrets stored in Git as base64 only, and the unexamined default reclaim policy. Each item below is labelled **G** (a documented guarantee), **C** (a configuration choice), **P** (a prerequisite) or **N** (something the docs do not establish). All paths are under `docs/`.

---

### 1. PDB `minAvailable: 5`

- **Node failure (involuntary):** "cannot be prevented by PDBs; however they do count against the budget" (G; `concepts/workloads/pods/disruptions.md:130-131`). Five available replicas are **not** guaranteed.
- **Node drain (voluntary, through the Eviction API):** this case is enforced. `kubectl drain` retries rejected evictions until they succeed or time out (G; `disruptions.md:107-121`). With 6 replicas and a minimum of 5, only one eviction can proceed at a time. If a replica is still starting slowly, the drain blocks. By default the drain waits for unhealthy Pods to become healthy; the docs recommend `unhealthyPodEvictionPolicy: AlwaysAllow` (C; `disruptions.md:138-141`).
- **Rolling update:** Pods taken down by a rollout count against the budget, but "Deployment and StatefulSet are not limited by PDBs when doing rolling upgrades" (G; `disruptions.md:133-136`). With `maxUnavailable: 2`, availability can fall to 4 (`concepts/workloads/controllers/deployment.md:1191-1199`).
- **Recommendation (C):** set `maxUnavailable: 0` with `maxSurge: 1` or `2`. Both fields cannot be 0 at the same time (`deployment.md:1194, 1203-1206`). Add `minReadySeconds` and `progressDeadlineSeconds` (`deployment.md:1314-1325`). Make sure there is room in the cluster for surge Pods (`deployment.md:329-330`).

### 2. Spreading replicas across zones

- `topologyKey: topology.kubernetes.io/zone` makes each zone label value one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-120`).
- `maxSkew: 1` limits how far any zone may exceed the *global minimum* (`:82-93`). With 6 replicas that means 2/2/2.
- `DoNotSchedule` is the default and leaves a violating Pod unscheduled. `ScheduleAnyway` schedules it anyway and only prefers placements that reduce the skew (`:124-126`).
- **If a zone becomes unavailable:**
  - The scheduler only knows about zones that currently have nodes (N/limitation; `:614-619`).
  - Removing Pods does not rebalance the remaining ones (`:607-611`).
  - Nodes missing the key are bypassed (`:480-490`).
  - With `DoNotSchedule`, replacements can stay Pending when skew would be violated. Setting `minDomains: 3` makes this behaviour explicit (`:95-115`).
- **Recommendation:**
  - Zone constraint: `maxSkew: 1` with `DoNotSchedule` if the team prefers Pending Pods to concentration in fewer zones; otherwise `ScheduleAnyway` to keep capacity.
  - Hostname: add a second constraint on hostname with `ScheduleAnyway` (pattern at `:536-546`).

### 3. Probes for slow startup

- **startupProbe:** use the same check as liveness, with `failureThreshold × periodSeconds` at least the worst-case startup time. If it never succeeds, the container is killed (example: 30×10 = 300 s) (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). Until it succeeds, all other probes are disabled (G; `concepts/workloads/pods/pod-lifecycle.md:494-497`). Liveness and readiness delays only begin after startup succeeds (`configure-liveness-…md:398-402`).
- **readinessProbe:** it runs for the container's whole life. When it fails, the Pod is removed from Service endpoints, so **traffic stops** and the container is **not** restarted (`configure-liveness-…md:349-362`; `pod-lifecycle.md:487-490`). Use it to check dependencies such as the database (`pod-lifecycle.md:521-527`).
- **livenessProbe:** a failure means the kubelet **kills and restarts** the container (`pod-lifecycle.md:481-483`). Keep it focused on the process itself so a slow database does not cause restart loops (N: the thresholds need application testing).

### 4. Termination order

1. The Pod is marked Terminating, and the grace-period clock starts (`pod-lifecycle.md:584-589`).
2. **preStop** runs. It **consumes the same grace period**. If it overruns, there is one 2-second extension (`:591-601`).
3. SIGTERM is sent to PID 1 in each container, in arbitrary order unless sidecars are used (`:603-610`).
4. **In parallel**, the control plane marks the endpoints terminating with `ready: false`, so load balancers stop sending new regular traffic. `serving` can still signal draining (`:612-632`).
5. When the grace period expires, the runtime sends SIGKILL (`:636-639`). The default grace period is 30 s (`:129`, `:594`).

**Thirty seconds is not guaranteed** to let long requests finish. Set `terminationGracePeriodSeconds` to be at least preStop + longest request + margin (C/N).

### 5. Resources

- CPU limits are enforced by **throttling**, as a hard limit. Memory limits are enforced by the kernel with **OOM kills**, reactively and only under memory pressure (G; `concepts/configuration/manage-resources-containers.md:43-53`).
- CPU requests act as a weight under contention and are used for scheduling (`:252-261`).
- A limit with no request copies the limit into the request (`:64-66`).
- For HPA: if any container lacks the relevant request, CPU utilization is undefined and **the HPA takes no action** for that metric (G; `tasks/run-application/horizontal-pod-autoscale.md:90-102`).
- **Recommendation:** every container sets a CPU request and a memory request plus limit. Decide separately whether a CPU limit is wanted, since throttling can slow long requests (N).

### 6. HPA behaviour

- Pods with missing metrics are set aside. They are then assumed to use 100% of target when scaling down and 0% when scaling up (`horizontal-pod-autoscale.md:160-161, 183-186`).
- Not-yet-ready Pods are set aside and treated as 0% when scaling up. This relies on `initial-readiness-delay` (30 s) and `cpu-initialization-period` (5 min) (`:163-178, 188-191`).
- There is a 0.1 tolerance. A recomputed ratio that reverses direction means no action (`:145-147, 193-197`).
- The HPA status reports the original, uncorrected utilization (`:199-202`).
- The downscale stabilization window is 5 minutes and uses the highest recommendation within that window (`:213-218, 480-483`).
- Scale-up has no stabilization by default (`:484-485`).
- Metrics Server must be installed separately (P; `:113-118`).
- **Why scaling can differ from the raw ratio:** slow startup means new Pods dampen the scale-up while they are not yet ready.

### 7. Least-privilege networking

- Pods are non-isolated by default in each direction. Any policy that selects a Pod and lists `Ingress` or `Egress` in `policyTypes` isolates that direction (`concepts/services-networking/network-policies.md:53-73`).
- Policies are **additive**: the result is the union, and order does not matter (`:75-77`).
- A connection needs **both** egress allowed at the source **and** ingress allowed at the destination (`:79-81`).
- **Recommendation:**
  - Start with default-deny for ingress and egress (`:219-259`).
  - Allow ingress to the API only from its clients.
  - Allow egress from the API to the database's Pod selector or IP block on the database port.
  - If the database runs in the cluster, it also needs a matching ingress policy.
- **Prerequisite:** the CNI plugin must enforce NetworkPolicy, otherwise the objects "will have no effect" (P; `:16, 47-49`). Enforcement may lag behind Pod start (`:362-380`).
- **DNS:** the supplied documentation has no DNS-egress guidance (N). Once egress isolation is in place, the team must explicitly allow and test egress to the cluster DNS service.

### 8. Secrets

- Base64 values are "obscured but not secret" (`concepts/configuration/secret.md:306`).
- Secrets are stored unencrypted in etcd by default (`secret.md:36-37`). The default `identity` provider "does not provide any confidentiality protection" (`tasks/administer-cluster/encrypt-data.md:55-66, 310`).
- **Required steps:**
  - Enable encryption at rest, with KMS envelope encryption preferred (`encrypt-data.md:322-324`).
  - Use least-privilege RBAC (`secret.md:42-48`).
  - Note that `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:93-98`).
- **Creating Pods matters:** anyone who can create a Pod, or a Deployment, in the namespace can read every Secret there (`secret.md:38-40`). They also gain the API access of any ServiceAccount in that namespace (`rbac-good-practices.md:100-108`).
- Committing base64 Secrets to Git is equivalent to committing plaintext. Use an external store (`secret.md:48`).

### 9. Reclaim policy

- The reclaim policy is copied from the StorageClass to dynamically provisioned PVs when they are created, and defaults to `Delete`. Manually created PVs keep the policy they were assigned (`concepts/storage/storage-classes.md:128-135`).
- The docs show existing PVs keeping their policy and say they "must be edited or patched after creation" (`concepts/storage/persistent-volumes.md:205-210`). **Changing the StorageClass is therefore not shown to affect existing PVs (N/inferred).** Patch each existing PV.
- **Retain:** deleting the PVC leaves the PV "Released" with its data. Reclaiming it is manual (`persistent-volumes.md:185-199`).
- **Delete:** deleting the PVC removes both the PV and the backing storage asset (`:201-206`).
- Deleting or scaling down a StatefulSet does **not** delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52`). `persistentVolumeClaimRetentionPolicy` with `whenDeleted`/`whenScaled` defaults to `Retain` (`:391-423`).
- Deleting a PVC is a separate act, and that is when the reclaim policy applies.
- **Recommendation:** database data uses `Retain` and backups (N: backups are not covered).

### 10. Prioritized checklist

1. **Secrets:** enable encryption at rest, remove Secrets from Git, and audit RBAC for `get`/`list`/`watch` on Secrets and for Pod-creation rights (Q8).
2. **Storage:** set `Retain` on the database StorageClass and patch existing PVs (Q9).
3. **Networking:** confirm the CNI enforces policy. Apply default-deny plus allow rules for clients, the database and DNS, then test both ends of each connection (Q7).
4. **Resources:** set requests on every container and confirm Metrics Server is installed (Q5–6).
5. **Probes:** measure worst-case startup and size the startupProbe to it. Keep readiness and liveness separate (Q3).
6. **Termination:** set the grace period to at least preStop + longest request. Test with in-flight requests (Q4).
7. **Rollout and drain:** use `maxUnavailable: 0`/`maxSurge: 1`, `minReadySeconds`, and a PDB with `AlwaysAllow`. Practise a drain while a Pod is still starting (Q1).
8. **Zone spread:** use the zone constraint plus a hostname constraint. Rehearse losing a zone and check whether replacements stay Pending or run hot (Q2).

**Limits the docs do not guarantee and that still need validation:**

- Five replicas during node or zone failure. The PDB cannot prevent involuntary disruption (`disruptions.md:130-131`).
- Long requests finishing within the grace period (`pod-lifecycle.md:636-639`).
- Policy enforcement and its timing, which depend on the CNI (`network-policies.md:47-49, 362-380`).
- DNS egress requirements, which these docs never cover.
- Capacity in each zone for surge Pods and for rescheduling after a zone loss (`topology-spread-constraints.md:607-619`).
- Database connection limits as the HPA adds replicas.
- Probe thresholds under real load.

---

Doc gaps: DNS-egress guidance and explicit wording on changing an existing StorageClass's reclaim policy are both missing from the supplied docs. Q7 and Q9 mark these as not established rather than guessing. If you want a shareable link for the team, I can publish this as a page.