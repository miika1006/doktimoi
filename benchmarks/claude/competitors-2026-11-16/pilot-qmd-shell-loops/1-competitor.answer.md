# Decision memo: production readiness of the API Deployment (Kubernetes v1.32 docs)

**Verdict: not ready as proposed.** Four parts of the design fail on what the docs say. The rollout settings conflict with the PDB. Default-allow networking leaves every Pod open. Secrets stored as base64 in Git are not protected. And dynamically provisioned storage reclaims with `Delete` by default.

All paths are relative to `docs/`. Each point is labelled: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

---

### 1. PDB `minAvailable: 5` across three cases

- **Node failure:** not protected. "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:130-131`). A budget "does not truly guarantee" the count. A node can fail while the set is already at its minimum (`tasks/run-application/configure-pdb.md:148-155`). **[G, negative]**
- **Node drain:** protected only when the tool uses the Eviction API. `kubectl drain` does this and retries rejected evictions (`disruptions.md:107-116`). With `minAvailable: 5` of 6, only one eviction succeeds at a time (`configure-pdb.md:131-132`; `disruptions.md:118-121`). Deleting Pods or Deployments directly skips the PDB (`disruptions.md:62-65`). The docs recommend `unhealthyPodEvictionPolicy: AlwaysAllow` so a drain is not blocked by unhealthy Pods (`disruptions.md:138-141`). **[G only with Eviction API] [C]**
- **Rolling update:** not protected. Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2`, the Deployment may go down to 4 available Pods, which breaks the intent of the budget (`concepts/workloads/controllers/deployment.md:1191-1199`). **[G, negative]**

**Recommendation [C]:** set `maxUnavailable: 0` and `maxSurge: 1`. `maxSurge` cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1194, 1203-1206`). Don't raise the PDB to 6: requiring zero voluntary evictions means a drain never completes (`configure-pdb.md:157-160`).

### 2. Zone spreading

Use `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1`, a `labelSelector` that matches the app, and `matchLabelKeys: [pod-template-hash]`. That key keeps old and new revisions from being counted together during a rollout (`concepts/scheduling-eviction/topology-spread-constraints.md:117-120, 128-160`).

- **`maxSkew`** with `DoNotSchedule` is the largest allowed difference from the *global minimum*. With `ScheduleAnyway`, it only gives priority to placements that reduce skew (`:82-93`). **[G]**
- **`DoNotSchedule`** (the default) leaves a Pod unscheduled. **`ScheduleAnyway`** still schedules it and prefers nodes that lower the skew (`:124-126`). **[G]**
- **Zone unavailable:** the scheduler learns domains only from nodes that exist (`:614-623`). Nothing guarantees the constraint stays satisfied after Pods are removed (`:607-611`).
  - `nodeTaintsPolicy` defaults to Ignore, so tainted nodes still count as domains (`:179-185`).
  - What happens in an outage is **[N]**. My inference: under `DoNotSchedule`, replacement Pods may stay Pending while a degraded zone still counts as a domain. Test a zone outage before choosing `DoNotSchedule` over `ScheduleAnyway`.

### 3. Probes for slow startup

- **Startup probe:** use the same check as liveness. Size `failureThreshold × periodSeconds` to cover the worst-case startup, for example 30 × 10 s = 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-345`; `concepts/workloads/pods/pod-lifecycle.md:552-557`). **[C]**
- **When the other probes begin:** all other probes are disabled until the startup probe succeeds. If the startup probe fails, the container is killed and restarted under its restart policy (`pod-lifecycle.md:492-497`). **[G]**
- **When traffic stops:** when readiness fails, the Pod's IP is removed from the endpoints of matching Services. Readiness starts as `Failure` before the initial delay (`:485-490`). A readiness probe can also check backends such as the database (`:524-528`). **[G]**
- **When a container restarts:** when liveness fails, the kubelet kills the container (`:480-483`). **[G]**
- **Caution:** don't make liveness depend on the database. Readiness is the place to check backends (`:524-528`).

### 4. Termination order

1. The Pod is marked terminating and the grace-period clock starts. The kubelet runs `preStop`; the default grace period is 30 s (`pod-lifecycle.md:584-597`).
2. At the same time, the control plane evaluates removing the Pod from EndpointSlices. Terminating endpoints stay listed with `ready: false` and a `serving` condition, so load balancers stop sending them regular traffic (`:612-632`; `concepts/services-networking/endpoint-slices.md:113-116`).
3. After `preStop`, the kubelet sends TERM to PID 1. Container order is arbitrary unless sidecars are used (`pod-lifecycle.md:603-610`).
4. When the grace period expires, the kubelet sends SIGKILL. If `preStop` overruns, there is one 2 s extension (`:596-597, 636-645`).

**Is 30 s enough? [N]** The `preStop` time counts against the same clock, and the docs say to raise `terminationGracePeriodSeconds` if `preStop` needs longer (`:598-601`). Nothing in the docs guarantees long requests finish. Set the grace period above the 99th-percentile request duration plus the `preStop` delay, and measure it.

### 5. Resources

- **Requests** drive scheduling and are reserved for the container (`concepts/configuration/manage-resources-containers.md:18-23`). A container may use more than its request (`:29-34`).
- **CPU limit:** a hard limit enforced by **throttling** (`:43-46`).
- **Memory limit:** enforced reactively by **OOM kill** under memory pressure (`:48-53`).
- **HPA:** if any container lacks a CPU request, Pod CPU utilization is undefined and the HPA **takes no action** on that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`). **[G]**

Set CPU requests on every container. A low CPU limit on a slow-starting app may stretch startup through throttling **[N, validate]**.

### 6. HPA behaviour

- **Missing metrics:** these Pods are set aside. The average is then recomputed as if they used 100% of target on scale-down and 0% on scale-up (`horizontal-pod-autoscale.md:160-161, 183-186`).
- **Not-yet-ready Pods:** for CPU, unready Pods are set aside. On scale-up, they are assumed to use 0% (`:163-178, 188-191`).
- **Readiness windows:** the initial-readiness delay is 30 s and the CPU-initialization period is 5 min (`:172-178`). Slow startup interacts with both.
- **Why scaling differs from the raw ratio:**
  - A tolerance of 0.1 skips small changes (`:145-147`).
  - The scale is cancelled if the recomputed ratio reverses direction (`:193-197`).
  - The reported status shows the original value, not the recomputed one (`:199-202`).
  - **Default downscale stabilization is 5 min:** the HPA takes the highest recommendation in that window (`:213-218`). **[G]**
- **Prerequisite:** the Metrics Server must be deployed separately (`:113-118`). **[P]**

### 7. Least-privilege networking

- **Default is open:** with no policies, all traffic is allowed (`concepts/services-networking/network-policies.md:210-212`).
- **Isolation:** a Pod becomes isolated for ingress or egress once any policy with that `policyType` selects it. Reply traffic is implicitly allowed (`:53-73`).
- **Policies are additive:** applicable policies combine as a union, and evaluation order does not matter (`:75-77`).
- **Both ends must allow:** source egress *and* destination ingress (`:79-81`).
- **Plan [C]:** apply default-deny for ingress and egress (`:254-262`). Then allow:
  - ingress from the Service's clients,
  - API egress to the database port,
  - database ingress from the API,
  - DNS egress.
- **DNS [N]:** the docs I retrieved have no DNS example. Once egress is isolated, name lookups need an explicit allow; this follows from `:62-64`.
- **CNI [P]:** without a CNI that implements NetworkPolicy, policies "will have no effect" (`:47-49`). Only TCP, UDP and SCTP are guaranteed; ICMP behaviour is undefined (`:266-279`).

### 8. Secrets

**Base64 is not protection.** It is "obscured but not secret" (`concepts/configuration/secret.md:306-307`). Kubernetes stores Secrets unencrypted in etcd by default (`:35-37`).

- Enable encryption at rest **[P]** (`tasks/administer-cluster/encrypt-data.md:13-15`). Prefer KMS v2; v1 is deprecated (`tasks/administer-cluster/kms-provider.md:10-12`).
- Use least-privilege RBAC and restrict Secrets to specific containers (`secret.md:42-48`).
- **Pod-create permission matters:** anyone who can create a Pod, or even a Deployment, in a namespace can read every Secret in that namespace (`:38-40`).
- Remove the base64 Secrets from Git. Consider an external secret store (`:48`).

### 9. Storage reclaim

- **StorageClass change:** a dynamically provisioned PV takes its class's `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-132`). The policy applies at provisioning time (`:34-36`).
  - Changing it on the class does not change existing PVs. Those must be patched one by one (`concepts/storage/persistent-volumes.md:205-210`).
  - The linked task page is not in this corpus **[N]**.
- **Delete:** removes the PV and the external storage asset (`persistent-volumes.md:201-205`).
- **Retain:** the PV becomes "Released", and the administrator cleans up by hand (`:185-199`).
- **PVC deletion vs StatefulSet deletion/scaling:**
  - Deleting a PVC can delete the volume, depending on the policy (`tutorials/stateful-application/cassandra.md:241-247`).
  - Deleting or scaling down a StatefulSet does *not* delete volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`).
  - `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, both defaulting to `Retain`) changes that. It needs the `StatefulSetAutoDeletePVC` feature gate **[P]** and applies only to deletion or scale-down, not to node failure (`statefulset.md:389-423`).
- **Recommendation:** use `Retain` for the database's PVs.

### 10. Prioritized checklist

1. **Secrets:** take them out of Git, confirm encryption at rest, and audit RBAC, including who can create Pods/Deployments (Q8).
2. **Storage:** set the database PVs to `Retain` by patching existing PVs, and fix the class for new ones. Verify backup and restore (Q9; `concepts/security/cloud-native-security.md:154-156`).
3. **Networking:** confirm the CNI supports NetworkPolicy. Apply default-deny, then the allow-list including DNS. Test both ends of each connection (Q7).
4. **Resources:** set CPU and memory requests on every container, then create the HPA and confirm the Metrics Server works (Q5–6).
5. **Probes:** add startup, readiness and liveness probes sized from measured startup times (Q3).
6. **Rollout:** set `maxUnavailable: 0` and `maxSurge: 1`, and keep `minAvailable: 5` with `unhealthyPodEvictionPolicy: AlwaysAllow` (Q1).
7. **Zone spreading:** add topology spread with `matchLabelKeys`, then run a zone-outage game day (Q2).
8. **Termination:** add a `preStop` hook and set the grace period above the longest request (Q4). Run drain and rollout tests under load.

**Limits that still need validation (not guaranteed by these docs):**

- Whether requests finish within the grace period (Q4).
- Scheduling behaviour under `DoNotSchedule` during a partial zone outage (Q2).
- That the platform's drain and autoscaling tools actually use the Eviction API (`disruptions.md:58-60, 107-109`).
- CNI enforcement, including DNS and non-TCP/UDP traffic (Q7).
- Database failover and connection behaviour, and the effect of CPU throttling on startup.