# Decision memo: production review of the API Deployment (Kubernetes v1.32 docs)

**Recommendation: do not approve the design as proposed.** Four parts conflict with what the docs say: `maxUnavailable: 2` against `minAvailable: 5`, default-allow networking, base64 Secrets in Git, and the default `Delete` reclaim policy on storage. The 30 s grace period and the probe settings are configuration choices that still need testing. Paths below are relative to `docs/`.

Labels: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

### 1. Does the PDB keep five replicas available?
No. A PDB "limits the number of Pods … that are down simultaneously from voluntary disruptions" (`concepts/workloads/pods/disruptions.md:99-105`).
- **Node failure:** this is an involuntary disruption (`:26-34`). These "cannot be prevented by PDBs; however they do count against the budget" (`:130-131`) **[G]**.
- **Node drain:** this is voluntary (`:50`). `kubectl drain` uses the Eviction API, which can reject an eviction and retry until a timeout (`:111-116`). With 6 replicas and `minAvailable: 5`, one Pod can be evicted at a time (`:118-121`) **[G]**. This only holds if tools use the Eviction API; deleting Pods or Deployments bypasses PDBs (`:62-65`, `:107-109`) **[P]**. The docs recommend `AlwaysAllow` for the unhealthy-Pod eviction policy so an unhealthy app doesn't block a drain (`:138-141`) **[C]**.
- **Rolling update:** these Pods count against the budget, but Deployments "are not limited by PDBs when doing rolling upgrades" (`:133-136`). `maxUnavailable: 2` lets availability drop to 4 (`concepts/workloads/controllers/deployment.md:1191-1199`).

**Recommendation [C]:** use `maxUnavailable: 0` and `maxSurge: 1` (or 25%, which rounds up; `:1203-1211`). Both cannot be 0 (`:1194`, `:1205`). Also note that HPA changes `.spec.replicas`, so the budget is recalculated against the new replica count (`disruptions.md:126-128`).

### 2. Spreading replicas across zones
Set `topologyKey: topology.kubernetes.io/zone`. Nodes with the same label value form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-122`).
- **maxSkew** is the largest allowed difference between a zone's Pod count and the global minimum when using `DoNotSchedule`. With `ScheduleAnyway` it only sets preference (`:82-93`).
- **DoNotSchedule** (the default) leaves a Pod unscheduled rather than break the constraint. **ScheduleAnyway** schedules it anyway and just tries to keep skew low (`:124-126`).
- `minDomains` works only with `DoNotSchedule`. If fewer eligible domains exist than `minDomains`, the global minimum is treated as 0 (`:107-115`).

**When a zone goes down:** the docs don't describe zone failure directly **[N]**. They do say that removing Pods can leave the spread unbalanced, and that zones are only known from existing nodes. A zone scaled to zero nodes isn't counted until it has a node again (`:605-623`). With `DoNotSchedule` and maxSkew 1, replacement Pods may stay Pending.

**Recommendation [C]:** maxSkew 1. Use `DoNotSchedule` only after testing that it doesn't hurt capacity during a zone outage; otherwise use `ScheduleAnyway`.

### 3. Probes for slow startup
- **Startup probe:** while it is defined, all other probes are disabled until it succeeds. If it fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:492-497`). Size it so `failureThreshold × periodSeconds` covers the worst-case startup. In the example, 30 × 10 s gives 300 s, then liveness takes over (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`). Point it at the same endpoint as liveness and leave the liveness defaults alone (`pod-lifecycle.md:552-557`).
- **When traffic stops:** when readiness fails, the Pod's IP is removed from the Service endpoints. Before its initial delay, readiness defaults to `Failure` (`:485-490`). Readiness runs for the container's whole life (`probes…md:361`).
- **When a container restarts:** when liveness fails (`pod-lifecycle.md:479-483`).

**Recommendation [C]:** readiness may also check the database (`pod-lifecycle.md:524-528`). Liveness should check only the process itself, so a database outage doesn't restart every replica.

### 4. Termination order and the 30-second grace period
1. The Pod is marked Terminating and the grace-period deadline is recorded (`pod-lifecycle.md:584-589`).
2. `preStop` runs, then the kubelet sends TERM (`:591-604`).
3. At the same time, the endpoint controller acts. Terminating endpoints stay in the EndpointSlice with `ready: false`, so load balancers stop sending regular traffic. The `serving` condition is available for draining (`:612-632`).
4. When the grace period ends, remaining processes get SIGKILL (`:636-639`).

A `preStop` hook that runs past the deadline gets only one 2-second extension. If `preStop` needs more time, you must raise `terminationGracePeriodSeconds` (`:596-601`).

**Is 30 s enough? Not guaranteed [N].** 30 s is just the default (`:594`). The grace period must cover `preStop` plus the longest request. Measure that, and handle SIGTERM in the app.

### 5. Resources
- **CPU limits** are enforced by throttling: a hard ceiling, but the container isn't killed (`concepts/configuration/manage-resources-containers.md:43-46`, `:252-254`, `:275-276`).
- **Memory limits** are enforced reactively with OOM kills (`:48-53`, `:261-265`). Going over the memory *request* can lead to eviction when the node runs short of memory (`:271-273`).
- **CPU requests** weight CPU time when there is contention (`:255-257`), and the scheduler uses them (`:503`).
- **HPA:** if any container lacks a CPU request, CPU utilization is undefined and HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:99-102`). So every container, sidecars included, needs a CPU request **[P]**. Metrics Server must also be installed (`:113-118`) **[P]**.

### 6. HPA behaviour
The formula is `ceil(current × currentMetric/desiredMetric)`, with no action inside a 0.1 tolerance (`horizontal-pod-autoscale.md:131-147`). Before applying it:
- Pods being deleted and failed Pods are ignored.
- Pods with missing metrics are set aside. They count as 100% of target when scaling down and 0% when scaling up (`:153-161`, `:183-186`).
- For CPU, not-yet-ready Pods are also set aside (initial-readiness delay 30 s, CPU initialization period 5 min) and count as 0% on scale-up (`:163-178`, `:188-191`).
- If the recalculated ratio reverses direction or falls inside the tolerance, nothing happens (`:193-197`).
- The status shows the raw average, not the adjusted one (`:199-202`).

**Downscale stabilization:** HPA picks the highest recommendation from the last 5 minutes (`:213-218`). Slow startup therefore dampens scale-up. That interacts with the startup probe and with the PDB budget.

### 7. Least-privilege networking
Pods are non-isolated by default. A policy whose `policyTypes` includes Ingress or Egress isolates the Pods it selects in that direction. Policies are additive: the result is the union of what they allow, and order doesn't matter (`concepts/services-networking/network-policies.md:53-77`). A connection needs both the source's egress and the destination's ingress to allow it (`:79-81`).

**Plan [C]:**
1. Default-deny ingress and egress for the namespace (`:254-262`).
2. Allow ingress from the Service clients to the API.
3. Allow API egress to the database's port, plus a matching ingress rule on the database side.
4. Allow DNS egress. The supplied docs I searched don't mention DNS **[N]**. Under default-deny egress, name lookups fail unless an explicit egress rule allows them.

**[P]:** a network plugin that enforces NetworkPolicy is required; without one, policies have no effect (`:47-49`). Only TCP, UDP and SCTP are guaranteed (`:264-279`), and plugins apply policies with some delay (`:362-380`).

### 8. Secrets
Base64 is "obscured but not secret" (`concepts/configuration/secret.md:306`). Secrets are stored unencrypted in etcd by default (`:36-37`), so base64 Secrets in Git are effectively plaintext.
- **Encryption at rest [C]:** the default `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:64-66`, `:234-235`). Existing Secrets are encrypted only after you rewrite them (`:590-604`).
- **RBAC [C]:** grant least-privilege access to Secrets and separate workloads by namespace (`secret.md:44-48`, `:667-673`).
- **Pod creation:** anyone who can create Pods, or Deployments, in a namespace can read every Secret there (`secret.md:38-40`). They also get the API access of any ServiceAccount in that namespace (`concepts/security/rbac-good-practices.md:100-113`).

### 9. Storage reclaim policy
Dynamically provisioned PVs take the StorageClass's `reclaimPolicy` at creation, and it defaults to `Delete`. Manually created PVs keep the policy they were given (`concepts/storage/storage-classes.md:126-135`). The docs say to configure the class up front; "otherwise, the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:205-209`). So changing the class doesn't change existing PVs; patch each PV.
- **Retain:** after the PVC is deleted, the PV becomes Released and the data stays until someone reclaims it by hand (`:185-199`).
- **Delete:** removes both the PV and the backing storage asset (`:201-205`).
- **PVC deletion vs StatefulSet:** deleting a PVC triggers the reclaim policy. Deleting or scaling down a StatefulSet is controlled by `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`). That field needs the `StatefulSetAutoDeletePVC` feature gate and doesn't apply to node-failure replacements (`concepts/workloads/controllers/statefulset.md:387-423`).

**Recommendation [C]:** use `Retain` for database volumes.

### 10. Prioritized rollout and validation checklist
1. Move Secrets out of Git. Enable encryption at rest, rewrite existing Secrets, and restrict Secret and Pod-create RBAC (Q8).
2. Set `reclaimPolicy: Retain` on the database StorageClass and patch existing PVs (Q9).
3. Set `maxUnavailable: 0` and `maxSurge: 1`. Keep `minAvailable: 5` or switch to a percentage. Set the unhealthy-Pod eviction policy to `AlwaysAllow` (Q1).
4. Add CPU and memory requests to every container and install Metrics Server (Q5).
5. Add startup, readiness and liveness probes sized from measured startup times (Q3).
6. Add zone spread constraints (Q2).
7. Set `preStop` and a grace period from measured request durations (Q4).
8. Roll out default-deny policies plus allow rules, including DNS, and confirm the CNI enforces them (Q7).
9. Test: drain a node, run a rollout, simulate a zone loss, generate HPA load, and kill a Pod with in-flight requests.

**Limits these docs do not guarantee:**
- that the longest request finishes within the grace period;
- capacity and scheduling for replacement Pods when a zone is lost;
- that every eviction path (node autoscaler, provider maintenance) actually uses the Eviction API;
- that the CNI enforces policy and does so in time;
- how the database itself behaves during failover.

---
The doktimoi search script couldn't run: every Node command was blocked waiting for approval. I collected the evidence with Grep and Read on the same docs folder instead. Every line range above comes from passages I actually read.