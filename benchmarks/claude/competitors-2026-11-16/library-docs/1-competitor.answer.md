I have the sources I need and am writing the memo now.

# Decision memo: API Deployment production review (Kubernetes v1.32 docs)

**Verdict: not ready for production as proposed.** The PDB and the rollout settings contradict each other. The 30-second grace period is not shown to be long enough for long requests. Networking and Secrets have no protection. The database storage could be deleted. All paths below are relative to `docs/`.

Labels used: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

---

**1. PDB minAvailable: 5**

- **Node failure.** **[G]** A PDB cannot prevent involuntary disruptions, though they still count against the budget (`concepts/workloads/pods/disruptions.md:130-131`). Hardware loss, network partition and node-pressure eviction are all involuntary (`:26-34`). The kubelet ignores the PDB during node-pressure eviction (`concepts/scheduling-eviction/node-pressure-eviction.md`, found by search). **Result: no guarantee.**
- **Node drain.** **[G]** Drain goes through the Eviction API, which honours the PDB. Rejected evictions are retried until a timeout (`disruptions.md:107-116`). With 6 replicas, 5 required means one eviction at a time (`:118-121`).
  - Deleting Pods or Deployments directly bypasses the PDB (`:62-65`).
  - **[C]** Set `unhealthyPodEvictionPolicy: AlwaysAllow`. Otherwise one unhealthy Pod can stall the drain (`:138-141`).
- **Rolling update.** **[G]** A Deployment is not limited by the PDB during rolling updates (`:133-136`). With maxUnavailable 2, availability may drop to 4 of 6 (`concepts/workloads/controllers/deployment.md:1191-1199`). That breaks the "5" the PDB implies.
- **Recommended rollout:** `maxUnavailable: 0`, `maxSurge: 1`. The two cannot both be 0 (`deployment.md:1203-1206`).
  - **[N]** Surge Pods need spare capacity. These docs don't establish that it exists.
  - The PDB counts against `.spec.replicas` (`disruptions.md:126-128`), and the HPA changes that field. Keep HPA `minReplicas ≥ 6`, or use a percentage budget.

**2. Spreading across zones**

- **[C]** Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1`. This places Pods 2/2/2.
- **What the fields mean** (`concepts/scheduling-eviction/topology-spread-constraints.md`):
  - `maxSkew` is the largest allowed difference from the global minimum (`:82-93`).
  - `topologyKey` is the node label that defines each domain (`:117-122`).
  - `DoNotSchedule` (the default) leaves a Pod unscheduled if placing it would break the constraint. `ScheduleAnyway` places it anyway and only prefers lower skew (`:124-126`).
- **[C]** Add `matchLabelKeys: [pod-template-hash]` so skew is counted per revision during rollouts (`:142-160`). Optionally set `minDomains: 3` (`:107-115`).
- **When a zone is unavailable:**
  - **[G]** Zones are known only from nodes that currently exist (`:614-619`).
  - **[G]** Spread is not maintained when Pods are removed (`:607-608`).
  - **[N]** The docs do not describe a whole-zone outage directly. Inferred from `:124-126`: with `DoNotSchedule`, replacement Pods may stay Pending. With `ScheduleAnyway`, they pile into the surviving zones.
  - **Decision:** use `DoNotSchedule` for the spread itself, and plan headroom for the loss of one zone.

**3. Probes for slow startup** (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md`)

- **Startup probe.** **[G]** Liveness and readiness probes do not start until the startup probe succeeds (`:31-35`, `:398-402`).
  - **[C]** Size `failureThreshold × periodSeconds` to the worst-case startup time (`:313-318`).
  - If the startup probe never succeeds, the container is killed and handled by `restartPolicy` (`:342-347`).
- **Readiness probe: when traffic stops.** **[G]** A container that is not ready gets no Service traffic (`:23-29`, `:356-358`). Readiness runs for the container's whole life (`:360-362`).
- **Liveness probe: when a container restarts.** **[G]** Liveness failure restarts the container (`:13-17`).
  - Use it only for unrecoverable states such as deadlock, because a bad liveness probe can cause cascading failures (`:37-48`).
  - **[C]** Use a higher `failureThreshold` than readiness, so the Pod goes unready before it is killed (`:19-21`).
  - Liveness and readiness do not depend on each other (`:364-368`).

**4. Termination** (`concepts/workloads/pods/pod-lifecycle.md`)

- **Order of events:**
  1. The Pod is marked Terminating with a deadline (`:584-589`).
  2. `preStop` runs. **[G]** The grace-period clock already covers `preStop`; only a one-off 2-second extension is allowed (`:591-601`).
  3. SIGTERM is sent, with no guaranteed order across containers (`:572`, `:603-610`).
  4. When the period expires, SIGKILL is sent (`:573-575`, `:636-645`).
- **Service endpoints.** At the same time, the control plane evaluates removing the Pod from its EndpointSlices. Terminating endpoints are reported `ready: false`, so load balancers stop regular traffic. The `serving` condition can be used for draining (`:612-632`).
- **Is 30 seconds guaranteed to finish requests? No.** 30 seconds is only the default (`:594`). **[N]** Whether the slowest request finishes inside the grace period minus `preStop` time must be measured. **[C]** Raise `terminationGracePeriodSeconds` to cover it.

**5. Resources** (`concepts/configuration/manage-resources-containers.md`)

- **Requests** drive scheduling and are reserved for the container (`:18-23`). A container can use more than its request (`:29-34`).
- **CPU limit:** **[G]** enforced by throttling (`:43-46`).
- **Memory limit:** **[G]** enforced reactively with OOM kills (`:48-53`).
- **Limit without a request:** the request is copied from the limit (`:63-67`).
- **HPA without CPU requests:** **[G]** utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`). **[C]** Set CPU requests on every container.

**6. HPA behaviour** (`horizontal-pod-autoscale.md`)

- **Base formula:** `ceil(current × metric ratio)` (`:131-139`), skipped when within the 0.1 tolerance (`:145-147`).
- **Ignored Pods:** Pods being deleted are ignored and failed Pods are discarded (`:156-158`).
- **Missing metrics and not-yet-ready Pods:** set aside (`:160-165`).
  - "Not yet ready" is decided with a 30-second readiness delay and a 5-minute CPU initialization period (`:167-178`). This matters for slow startup.
  - The average is then recomputed conservatively: missing Pods count as 100% on scale-down and 0% on scale-up, and not-yet-ready Pods as 0% (`:183-191`).
  - If the result reverses direction or falls within tolerance, nothing happens (`:193-197`).
- **Downscale stabilization:** the HPA picks the highest recommendation from a 5-minute window (`:213-218`).
- **Why scaling differs from the raw ratio:** the tolerance, the set-aside Pods, the window, and multi-metric rules (`:204-211`). Also, status reports the original unadjusted value (`:199-202`).
- **[P]** Metrics Server must be installed separately (`:113-118`).

**7. Network policy** (`concepts/services-networking/network-policies.md`)

- **[P]** Policies need a CNI plugin that implements them. Without one they have no effect (`:45-49`, `:92-95`).
- **Isolation:** **[G]** Ingress and egress isolation start once a policy selecting the Pod lists that direction. Reply traffic is implicitly allowed (`:51-73`).
- **Additive policies:** allowances combine and never conflict (`:75-77`).
- **Both ends of a connection:** the source's egress and the destination's ingress must both allow it (`:79-81`).
- **[C]** Apply default-deny for ingress and egress in the namespace (`:254-262`). Then add allows for:
  - Service/ingress clients → API port
  - API → database port
  - API → DNS
- **DNS:** **[N]** No dedicated DNS rule was found. Default-deny egress blocks all egress (`:236-242`), so DNS needs an explicit allow.
- **Other limits:** node-originated traffic is always allowed (`:35-36`). Only TCP, UDP and SCTP denial is guaranteed (`:275-279`).

**8. Secrets** (`concepts/configuration/secret.md`)

- **Base64 is not protection.** **[G]** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them (`:35-37`).
- **Required steps** (`:42-48`):
  - encryption at rest
  - least-privilege RBAC
  - restricting Secret access to specific containers
  - optionally an external store
- **Why Pod creation matters:** anyone who can create a Pod, or a Deployment, in the namespace can read every Secret there (`:38-40`). Restrict `create` on workloads as tightly as `get` on Secrets.
- **Git:** **[N]** Base64 Secrets committed to Git sit outside all of these controls. Use an external store (`:48`).

**9. Storage reclaim**

- **[G]** Dynamically provisioned PVs take the StorageClass `reclaimPolicy` when they are created. The default is `Delete` (`concepts/storage/storage-classes.md:126-135`).
- **Changing the StorageClass later:** the docs say existing PVs must be edited or patched individually (`concepts/storage/persistent-volumes.md:203-210`). So changing the class does not protect volumes that already exist. **[N]** The docs don't spell out that changing the class has no effect on existing PVs; this is inferred from the patch requirement.
- **Retain vs Delete:**
  - **Retain:** after the PVC is deleted, the PV is "Released" and the data stays. Reclaiming it is manual (`:185-199`).
  - **Delete:** removes both the PV and the external storage asset (`:201-206`).
- **PVC deletion vs StatefulSet deletion/scaling:**
  - PVC deletion triggers the reclaim policy (`:180-183`).
  - StatefulSet deletion or scale-down is governed by `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`) (`concepts/workloads/controllers/statefulset.md:391-423`).
  - Node-failure replacements keep their PVC (`:417-421`).
  - **[P]** The `StatefulSetAutoDeletePVC` feature gate must be enabled (`:392-394`).
- **Decision:** use `Retain` for database volumes and patch any PVs that already exist.

**10. Prioritized checklist**

1. Move Secrets out of Git. Enable encryption at rest and RBAC, including limits on Pod/Deployment creation (Q8).
2. Set `reclaimPolicy: Retain` and patch existing database PVs (Q9).
3. Set the rollout to `maxUnavailable: 0`, `maxSurge: 1`. Add the PDB with `AlwaysAllow`, and keep HPA `minReplicas ≥ 6` (Q1).
4. Add the startup, readiness and liveness probes. Measure the worst-case startup time (Q3).
5. Add `preStop` and raise the grace period above measured request time (Q4).
6. Set CPU and memory requests and a memory limit. Verify Metrics Server is running (Q5–6).
7. Add the zone spread constraint (Q2).
8. Confirm the CNI enforces NetworkPolicy, then apply default-deny plus allows including DNS. Test both ends of each connection (Q7).
9. Validate with a test drain, a test rollout, and a simulated loss of one zone.

**Limits that still need validation (not guaranteed by these docs):**

- **[N]** Whether in-flight requests finish within the grace period (Q4).
- **[N]** Whether capacity is enough for the surge Pod and for one lost zone (Q1, Q2). A PDB does not stop involuntary loss.
- **[N]** That the CNI enforces policy, including on non-TCP/UDP/SCTP protocols (Q7).
- **[N]** That the HPA reacts fast enough given the 5-minute CPU initialization period and the downscale window (Q6).
- **[N]** That the database tolerates connections being dropped during SIGKILL or failover. The docs say nothing about this application behaviour.

**Sources not opened:** `node-pressure-eviction.md` was cited from its search snippet only. A separate task page on changing a PV's reclaim policy was not found at the path I tried, so Q9 relies on `persistent-volumes.md`.