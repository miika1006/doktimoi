# Decision memo: production readiness review of the multi-zone API Deployment

**Scope.** This review uses only the supplied Kubernetes v1.32 docs. Paths are relative to `docs/` and line ranges point to the source files. I label each point as **G** (documented guarantee), **C** (configuration choice), **P** (prerequisite) or **N** (the docs don't establish it).

**Verdict:** Not ready as proposed. The rollout settings conflict with each other. The design also has no spread, probe or drain configuration, and three of its defaults (open networking, Secrets as plain base64 in Git, and the `Delete` reclaim policy) are unsafe.

---

### 1. Does the PDB guarantee five available replicas?
No. It doesn't hold in any of the three cases.
- **Node failure:** This is an involuntary disruption. **G:** a PDB cannot prevent it, although the lost Pods still count against the budget (`concepts/workloads/pods/disruptions.md:26-34, 130-131`).
- **Node drain:** **G:** `kubectl drain` uses the Eviction API, which respects the PDB. Rejected evictions are retried until the Pods are gone or a timeout is reached (`disruptions.md:107-121`). **N:** this only holds if the tooling uses eviction. Deleting Pods or Deployments directly bypasses PDBs (`disruptions.md:62-65`). The docs recommend `unhealthyPodEvictionPolicy: AlwaysAllow` so that misbehaving Pods don't block a drain (`disruptions.md:138-141`).
- **Rolling update:** **G:** Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2` and 6 replicas, availability can drop to 4 (`concepts/workloads/controllers/deployment.md:1191-1199`).
- **Recommendation (C):** Set `maxUnavailable: 0` and `maxSurge: 1` (allowed as long as both are not 0; `deployment.md:1194, 1203-1206`). Keep `minAvailable: 5`, or use `maxUnavailable: 1` on the PDB (`tasks/run-application/configure-pdb.md:76-80, 87-90`). Note that with 6 replicas and `minAvailable: 5`, a drain can evict only one Pod at a time, and only while all six are healthy.

### 2. Zone spreading
- **C:** Use `topologyKey: topology.kubernetes.io/zone` with `maxSkew: 1`. `maxSkew` is the largest allowed difference between a domain's matching Pod count and the global minimum (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93, 117-122`).
- `DoNotSchedule` is the default. It leaves a Pod Pending rather than break the constraint. `ScheduleAnyway` schedules the Pod anyway and only prefers placements that reduce skew (`:124-126`).
- `minDomains` works only with `DoNotSchedule`. When there are fewer eligible domains than `minDomains`, the global minimum is treated as 0 (`:107-115`).
- Add `matchLabelKeys: [pod-template-hash]` so the skew is calculated per revision during rollouts (`:134-160`).
- **N / limits:** The docs don't guarantee the spread after Pods are removed (`:607-611`). The scheduler only knows about zones that currently have nodes (`:614-623`). A whole-zone outage is an involuntary disruption that the PDB doesn't stop (Q1). With `DoNotSchedule`, the replacement Pods can stay Pending. The docs don't say how quickly capacity recovers.

### 3. Probes for slow startup
- **startupProbe:** **G:** All other probes are disabled until it succeeds. If it fails, the container is killed and restarted according to the restart policy (`concepts/workloads/pods/pod-lifecycle.md:492-497`). Size `failureThreshold × periodSeconds` to cover the worst-case startup time; for example 30 × 10 s gives 300 s. Once the startup probe succeeds, liveness takes over (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `pod-lifecycle.md:544-557`).
- **readinessProbe:** **G:** When it fails, the Pod's IP is removed from the Service endpoints, so traffic stops but the container is not restarted (`pod-lifecycle.md:485-490`). It runs for the container's whole lifecycle (`configure-liveness-readiness-startup-probes.md:351-362`). It can also check required back ends such as the database (`pod-lifecycle.md:524-528`).
- **livenessProbe:** **G:** When it fails, the kubelet kills the container and restarts it (`pod-lifecycle.md:479-483`). Keep it fast and independent of the database. Readiness and liveness don't depend on each other (`configure-liveness-readiness-startup-probes.md:364-368`).

### 4. Termination order. Is 30 s guaranteed to be enough?
No. The order is as follows.
1. The Pod is marked Terminating and the grace-period clock starts. The `preStop` hook runs inside that period, not in addition to it. If `preStop` is still running when the period ends, the kubelet adds one 2 s extension (`pod-lifecycle.md:584-601`).
2. SIGTERM, or the image's STOPSIGNAL, is sent to each container in no guaranteed order (`:572, 603-610`).
3. In parallel, the control plane marks the endpoints as terminating with `ready=false`, while `serving` still reflects actual readiness (`:612-632`).
4. When the grace period expires, SIGKILL is sent (`:573-577, 636-639`).
Eviction honours `terminationGracePeriodSeconds` (`disruptions.md:143-145`). **N:** Whether 30 s is enough depends on how long the application's requests and drain take, and the docs don't establish that. Measure the longest request time, then set the grace period to cover `preStop` plus the drain.

### 5. Resources
- Requests are used for scheduling and are reserved for the container. A container can use more than its request (`concepts/configuration/manage-resources-containers.md:18-34`).
- CPU limits are enforced by throttling. Memory limits are enforced reactively: when the kernel detects memory pressure, it may OOM-kill the container (`:43-53`).
- If you set a limit with no request, Kubernetes copies the limit and uses it as the request (`:63-67`).
- **G:** HPA calculates utilization as a percentage of the request. If any container lacks a CPU request, CPU utilization is undefined and the autoscaler does nothing for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102, 257-260`).
- **C:** Set CPU and memory requests on every container, including sidecars, and set a memory limit. **N:** the right CPU limit value has to come from load testing.

### 6. HPA behaviour
- Desired replicas = `ceil(current × current/target)`, with a tolerance of 0.1 (`horizontal-pod-autoscale.md:131-147`).
- Pods being deleted are ignored and failed Pods are discarded (`:153-158`).
- Pods with missing metrics are set aside. During a scale-down they are assumed to use 100% of the target, and during a scale-up 0% (`:160-161, 183-186`).
- Pods that are not yet ready are set aside and assumed to use 0%. This is controlled by the `initial-readiness-delay` setting (30 s) and the `cpu-initialization-period` setting (5 min) (`:163-178, 188-191`).
- If the adjusted ratio reverses direction or falls within the tolerance, the HPA does nothing (`:193-197`).
- The status shows the original unadjusted value (`:199-202`).
- Downscale stabilization picks the highest recommendation from the last 5 minutes (`:213-218`).
- **P:** The metrics API (usually Metrics Server) must be installed (`:113-118`).
- Because the startup is slow, scaling up can lag behind the raw ratio.

### 7. Least-privilege networking
- **P:** A CNI plugin that implements NetworkPolicy is required. Without one, policies have no effect (`concepts/services-networking/network-policies.md:45-49`).
- **G:** Pods are non-isolated by default. A policy that selects a Pod and lists `Ingress` or `Egress` in `policyTypes` isolates that direction. Policies are additive (a union), and reply traffic is allowed implicitly (`:53-77`).
- Both ends must allow a connection: egress on the source and ingress on the destination (`:79-81`).
- Traffic from the Pod's own node is always allowed (`:35-36, 70-72`).
- **C:**
  - Add a default-deny policy for both ingress and egress.
  - Allow ingress from the client or ingress tier only on the API port.
  - Allow egress to the database on its port.
  - If the database is in the cluster, give it a matching ingress allow.
- **DNS:** Once egress is isolated, everything not listed is blocked, so DNS must be allowed explicitly. **N:** The pages I reviewed don't give DNS-specific selectors or ports.

### 8. Secrets
Base64 is not protection.
- **G:** By default, Secrets are stored unencrypted in etcd. Anyone with API or etcd access can read them (`concepts/configuration/secret.md:35-37`).
- **G:** Anyone who can create a Pod in the namespace, even indirectly by creating a Deployment, can read every Secret in that namespace (`:38-40`).
- **Required steps:** enable encryption at rest, apply least-privilege RBAC, restrict Secret access to specific containers, and consider an external Secret store (`:42-48`).
- Encryption only applies to Secrets created or updated after the API server is restarted with it, so existing Secrets must be rewritten (`tasks/administer-cluster/encrypt-data.md`, "Ensure all relevant data are encrypted" section).
- Committing base64 Secrets to Git puts them outside all of these controls. Rotate those credentials.

### 9. Storage reclaim
- **G:** A StorageClass's `reclaimPolicy` (default `Delete`) applies to PVs when they are dynamically provisioned (`concepts/storage/storage-classes.md:126-135`).
- Existing PVs are not changed when the class changes. They have to be edited or patched (`concepts/storage/persistent-volumes.md:205-210`).
- **Retain:** After the PVC is deleted, the PV is "Released" and the data stays. Reclaiming it is manual (`:185-199`).
- **Delete:** Deletes both the PV and the external storage asset (`:201-205`).
- **StatefulSets:**
  - Deleting a StatefulSet or scaling it down does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`).
  - `persistentVolumeClaimRetentionPolicy` sets `whenDeleted` and `whenScaled` to `Retain` (the default) or `Delete`. It only applies when the StatefulSet is deleted or scaled down, not when a Pod is replaced after a node failure (`statefulset.md:395-423`).
- Deleting a PVC is the step that triggers the PV's reclaim policy (`persistent-volumes.md:180-183`).
- **C:** For database volumes, use `Retain`, and patch the existing PVs.

### 10. Prioritized checklist
1. Rotate the Secrets, remove them from Git, enable encryption at rest and rewrite existing Secrets, and tighten RBAC, including who can create Pods and Deployments (Q8).
2. Patch the database PVs to `Retain` and set the StorageClass to `Retain` (Q9).
3. Set the Deployment to `maxUnavailable: 0` and `maxSurge: 1`. Configure the PDB with `minAvailable: 5` (or `maxUnavailable: 1`) and `AlwaysAllow` (Q1).
4. Add zone spreading with `maxSkew: 1`, `DoNotSchedule` and `matchLabelKeys` (Q2).
5. Add startup, readiness and liveness probes (Q3), plus `preStop` and a measured grace period (Q4).
6. Set requests on all containers and a memory limit, then configure the HPA (Q5–6).
7. Confirm the CNI enforces NetworkPolicy, then apply default-deny with explicit allows, including DNS (Q7).
8. Validate in staging with a node drain, a zone failover test, a rollout under load, and an HPA scale-up during slow startup.

**Limits these docs don't guarantee, which still need validation:**
- (a) Whether in-flight long requests finish within the grace period (Q4).
- (b) That five replicas stay available during involuntary or zone failures, and how quickly capacity recovers (Q1, Q2).
- (c) That the CNI actually enforces the policies, and the DNS rules it needs (Q7).
- (d) The right CPU and memory values and the HPA's response time with slow startup (Q5–6).
- (e) The database's own consistency during failover. The docs don't cover it.