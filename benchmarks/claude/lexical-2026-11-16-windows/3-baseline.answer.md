# Decision memo: API Deployment production readiness (Kubernetes v1.32)

**Verdict: do not approve as proposed.** The PDB and rollout settings contradict each other. The 30-second grace period is not shown to cover long requests. Networking, Secret handling and storage defaults do not protect the service or its data. All paths below are relative to `docs/`.

Each finding is labelled: **[G]** a documented guarantee, **[C]** a configuration choice, **[P]** a prerequisite, **[N]** something these documents do not establish.

---

### 1. Does `minAvailable: 5` guarantee five available replicas?

No, not in any of the three cases.

- **Node failure.** **[G]** PDBs cannot prevent involuntary disruptions, although those disruptions do count against the budget (`concepts/workloads/pods/disruptions.md:130-131`). If a node holding two replicas fails, availability drops to 4.
- **Node drain.** **[G]** `kubectl drain` uses the Eviction API, which respects PDBs and retries rejected evictions until a timeout (`disruptions.md:107-121`). With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time. A drain blocks while any replica is unready (`disruptions.md:138-141`). **[C]** Consider `AlwaysAllow` as the unhealthy Pod eviction policy (same lines).
- **Rolling update.** **[G]** Workload controllers "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). `maxUnavailable: 2` allows availability to fall to 4 (`concepts/workloads/controllers/deployment.md:1191-1199`).

**Recommendation [C]:** use `maxUnavailable: 0` and `maxSurge: 1`. Both may not be 0 at once (`deployment.md:1194, 1205`). Also set `minReadySeconds` (`:1325-1328`) and a `progressDeadlineSeconds` larger than the worst-case startup time. It defaults to 600 and must exceed `minReadySeconds` (`:1314-1321`). Rollout surges need spare capacity (`deployment.md:329-330`).

### 2. How should replicas be spread across zones?

**[C]** Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1`. Nodes with the same label value form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:117-120`, example at `:527-529`).

- **`maxSkew` with `DoNotSchedule`** caps the difference between any domain and the global minimum. **`DoNotSchedule`** (the default) leaves a Pod unscheduled when the constraint can't be met. **`ScheduleAnyway`** schedules it anyway and only prefers domains that reduce skew (`:82-93, 124-126`).
- **[C]** Add `matchLabelKeys: [pod-template-hash]` so that each revision is spread on its own during rollouts (`:134-163`).

**When a zone is unavailable:**
- **[G]** Constraints are not re-enforced when Pods are removed (`:607-611`).
- **[G]** Domains are discovered only from existing nodes, so a zone with zero nodes is invisible to the scheduler (`:614-619`).
- **[N]** The docs do not describe a zone outage step by step. With `DoNotSchedule`, replacement Pods may stay Pending. With `ScheduleAnyway`, they land in the surviving zones.
- Losing one zone takes 2 of 6 replicas, which already breaks the "five available" goal (see Q1).

### 3. Which probes fit slow startup?

**[C]** Use three probes:
- **`startupProbe`** on the liveness endpoint, with `failureThreshold × periodSeconds` covering the worst-case startup (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `concepts/workloads/pods/pod-lifecycle.md:544-557`).
- **`livenessProbe`** that checks only the process's own health.
- **`readinessProbe`** on a separate readiness endpoint (`pod-lifecycle.md:520-528`).

What happens when:
- **When the other probes begin [G]:** liveness and readiness are disabled until the startup probe succeeds (`pod-lifecycle.md:492-497`; probe task `:398-400`).
- **When traffic stops [G]:** after `failureThreshold` consecutive readiness failures, the Pod's `Ready` condition becomes false. The container keeps running, and the endpoints controller removes its IP from the Service (`probe task:412-422`; `pod-lifecycle.md:485-490`).
- **When a container restarts [G]:** after `failureThreshold` consecutive startup or liveness failures, the kubelet restarts the container and honours the grace period (`probe task:415-418`).

**[N]** The docs suggest a readiness probe may check required back-ends. Whether checking the shared database could mark all six replicas unready at the same time is an application decision.

### 4. Termination order and the 30-second grace period

The sequence (`pod-lifecycle.md:559-645`):

1. **[G]** The Pod is marked Terminating and the grace-period clock starts (`:584-589`).
2. **[G]** `preStop` runs first, inside the grace period. If it is still running when the period expires, the kubelet grants a one-time 2-second extension (`:591-601`).
3. **[G]** SIGTERM (or the image's `STOPSIGNAL`) goes to process 1 in each container (`:572, 603-604`).
4. **[G]** At the same time, the control plane starts removing the Pod from the Service. Terminating endpoints stay in EndpointSlices with `ready=false`, and their actual readiness is shown in the `serving` condition (`:612-632`).
5. **[G]** When the grace period expires, SIGKILL is sent to remaining processes (`:573, 637-639`).

**Is 30 seconds guaranteed to finish requests?** No. The default is 30 s (`:594`), and the docs say to raise it when needed (`:599-600`). **[N]** How fast load balancers stop sending traffic, and how long requests actually last, must be measured.

### 5. CPU requests, limits and memory limits

- **CPU limits [G]:** enforced by throttling. CPU overuse never kills a container (`concepts/configuration/manage-resources-containers.md:43-46, 252-254, 275-276`).
- **CPU requests [G]:** act as a weighting when CPU is contended (`:255-257`).
- **Memory limits [G]:** enforced reactively by OOM kills (`:48-53, 261-265`). A Pod that exceeds its memory request on a node short of memory is likely to be evicted (`:271-273`).
- **HPA [G]:** utilization is calculated as a percentage of the request. If any container lacks a CPU request, utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:90-101`).
- **[C]** Set CPU requests on every container, and set memory requests and limits.

### 6. HPA behaviour

- **[P]** The HPA needs the `metrics.k8s.io` API, usually served by Metrics Server, which is installed separately (`horizontal-pod-autoscale.md:113-118`).
- **The raw ratio [G]:** `desired = ceil(current × currentMetric / target)`. No action is taken when the ratio is within the 0.1 tolerance (`:131-147`).
- **Pods that are set aside [G]:** Pods with a deletion timestamp are ignored and failed Pods are dropped. Pods with missing metrics, and Pods that are not yet ready, are set aside (`:153-178`). The defaults are a 30 s initial-readiness delay and a 5 min CPU initialization period.
- **Recalculation [G]:**
  - Missing Pods count as 100% of target on scale-down and 0% on scale-up.
  - Not-yet-ready Pods count as 0% on scale-up.
  - If the recalculated ratio reverses direction or falls within tolerance, nothing happens (`:183-197`).
- **Multiple metrics [G]:** a metric that can't be fetched blocks scale-down (`:204-211`).
- **Downscale stabilization [G]:** the HPA uses the highest recommendation from the last 300 s. Scale-up has no stabilization window (`:213-218, 480-484`).
- **Why scaling differs from the raw ratio:** the tolerance, the conservative recalculation and the stabilization window. The reported utilization is the original, unadjusted value (`:199-202`).
- **[N]** With slow startup, new Pods won't help for minutes. Size headroom and `minReplicas` from load tests.

### 7. Least-privilege networking

- **[P]** Policies need a network plugin that enforces them. Without one, they have no effect (`concepts/services-networking/network-policies.md:16, 47-49`).
- **Isolation [G]:** a Pod is isolated for ingress or egress only when some policy selects it with that direction in `policyTypes` (`:56-73`).
- **Additive policies [G]:** allowed traffic is the union of all applicable policies (`:75-77`).
- **Both ends [G]:** the source's egress and the destination's ingress must both allow a connection (`:79-81`).
- **Node traffic [G]:** traffic from the Pod's own node is always allowed into an ingress-isolated Pod (`:70-71`).
- **Protocols [G]:** deny-all is guaranteed only for TCP, UDP and SCTP (`:275-279`).
- **Timing [N]:** a new policy may take some time to be enforced (`:362-380`).
- **Plan [C]:** start with a namespace default deny for both directions (`:214-268`). Then allow ingress from the load balancer or ingress source to the API port, and egress from the API to the database port. The database side must also allow that ingress.
- **DNS [N]:** this page never mentions DNS. Once egress is denied, the DNS egress rule and the DNS server's labels must be found and tested in this cluster.

### 8. Is base64 enough for Secrets?

No. Base64 is "obscured but not secret" (`concepts/configuration/secret.md:306-307`). Committing these values to Git exposes them; the docs do not cover Git.

- **[G]** Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them (`secret.md:36-37`).
- **[C]** The minimum steps are encryption at rest, least-privilege RBAC, restricting Secret access to specific containers, and considering an external secret store (`secret.md:42-48`).
- **[G]** The default `identity` provider gives no confidentiality (`tasks/administer-cluster/encrypt-data.md:64-70, 224-235`).
- **[P]** Existing Secrets are encrypted only after they are rewritten, for example with `kubectl replace` (`encrypt-data.md:596-603`).
- **RBAC [G]:** `list` and `watch` reveal Secret contents just as `get` does (`concepts/security/rbac-good-practices.md:93-98`).
- **Why Pod creation matters [G]:** anyone who can create Pods, or a Deployment, can mount any Secret in the namespace and act as any ServiceAccount there (`secret.md:38-40`; `rbac-good-practices.md:100-108`).

### 9. StorageClass reclaim policy

- **Changing the class [G]:** dynamically provisioned PVs inherit the class's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`; `reference/kubernetes-api/config-and-storage-resources/storage-class-v1.md:93-95`).
- **Existing PVs:** the docs say that if the class doesn't match expectations, "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:205-210`). **[N]** They do not state directly what editing the class does to existing PVs. Treat it as having no effect and patch existing PVs explicitly.
- **`Retain` [G]:** after the PVC is deleted, the PV becomes "released" and keeps its data. Reclaiming it is manual, and the storage asset survives even if the PV is deleted (`persistent-volumes.md:185-199`).
- **`Delete` [G]:** removes both the PV and the external storage asset (`:201-205`).
- **StatefulSet deletion or scaling is separate from PVC deletion [G]:** deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). The optional `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`, default `Retain`) controls this, and its docs say it requires the `StatefulSetAutoDeletePVC` feature gate (`statefulset.md:389-415`). Once a PVC is deleted, the PV's reclaim policy decides what happens to the data.
- **[C]** Use `Retain` for database data.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** remove them from Git and rotate them. Enable encryption at rest and rewrite existing Secrets. Tighten RBAC, including who can create Pods (Q8).
2. **Storage:** set `Retain` on the StorageClass and patch existing PVs (Q9).
3. **Rollout:** `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds`, and a sized `progressDeadlineSeconds` (Q1).
4. **Probes:** startup, liveness and readiness as in Q3.
5. **Termination:** a `preStop` hook and a grace period above the longest request (Q4).
6. **Resources:** requests and limits on every container (Q5). Confirm the metrics API, `minReplicas` and the HPA behaviour settings (Q6).
7. **Zones:** zone spread with `matchLabelKeys`, and consider 9 replicas so a zone loss leaves at least 6 (Q2).
8. **Networking:** confirm the CNI enforces policies, then apply default deny plus explicit allows, including DNS (Q7).
9. **Validate:** drain a node, run a rollout under load, and run a simulated zone loss, checking availability at each step.

**Limits these documents do not guarantee, which need validation:**
- Load-balancer and endpoint propagation time compared with the grace period (Q4).
- The actual length of the longest request (Q4).
- The worst-case startup time used to size the startup probe (Q3).
- How quickly and completely the CNI enforces policies, plus the DNS rule (Q7).
- How scheduling behaves with zone-level `DoNotSchedule` when a zone fails (Q2).
- How the database copes with failover and connections while API replicas churn.
- Whether there is enough spare capacity for surge Pods and for losing a zone.