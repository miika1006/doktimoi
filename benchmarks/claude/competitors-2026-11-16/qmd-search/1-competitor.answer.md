# Decision memo: production readiness of the six-replica API Deployment

**Scope and sources.** This review uses only the local Kubernetes v1.32 corpus. All paths below are relative to `docs/`, and line ranges are inclusive. Each finding is labelled **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, or **[N]** not established by the docs.

**Verdict:** Not ready to ship as proposed. Four items must change before production: the rollout's `maxUnavailable: 2` conflicts with `minAvailable: 5`, the grace period has not been checked against how long requests run, networking is open, and Secrets in Git are only base64-encoded. Storage also needs an explicit decision on the reclaim policy.

---

### 1. PDB `minAvailable: 5`

- **Node failure:** **[G]** A PDB cannot prevent involuntary disruptions; they only count against the budget (`concepts/workloads/pods/disruptions.md:130-131`). Hardware or VM loss and kernel panics are involuntary (`disruptions.md:26-34`). The budget "can only protect against voluntary evictions" (`tasks/run-application/configure-pdb.md:150-154`). Losing one node can take the app below five.
- **Node drain:** **[G]** `kubectl drain` goes through the Eviction API, which respects the PDB. Failed evictions are retried until they succeed or time out (`disruptions.md:107-121`). With six Ready Pods, one eviction is allowed at a time. The drain blocks until the replacement Pod becomes Ready, and slow startup makes that wait longer (`disruptions.md:195-197, 225-232`). "Healthy" means the Pod's Ready condition is True (`configure-pdb.md:238-240`). **[N]** This only holds if the tooling uses eviction: deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:62-65`).
- **Rolling update:** **[G]** Pods taken down by a rollout count against the budget, but "Deployment and StatefulSet are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). With `maxUnavailable: 2`, availability can fall to 4 of 6 (`concepts/workloads/controllers/deployment.md:1191-1199`).
- **Recommendation [C]:** Set `maxUnavailable: 0` and `maxSurge: 1`. The two fields cannot both be 0 (`deployment.md:1191-1206`). Because HPA changes the replica count, express the PDB as `maxUnavailable: 1`. The docs recommend that form because it follows the controller's replica count (`configure-pdb.md:174-176`). Consider `unhealthyPodEvictionPolicy: AlwaysAllow` so stuck Pods do not block drains (`disruptions.md:138-141`, `configure-pdb.md:246-260`).

### 2. Zone spreading

- **[C]** Use `topologyKey: topology.kubernetes.io/zone` and `maxSkew: 1`. Use `matchLabelKeys: [pod-template-hash]` so the spread is calculated per revision during rollouts (`concepts/scheduling-eviction/topology-spread-constraints.md:117-160, 206-209`).
- **What the fields mean [G]:** With `DoNotSchedule`, `maxSkew` is the maximum allowed difference from the global minimum across eligible domains. With `ScheduleAnyway`, the scheduler only prefers placements that reduce skew (`topology-spread-constraints.md:82-93`). `DoNotSchedule` is the default and leaves a Pod unscheduled if placing it would violate the constraint (`:124-126`).
- **Zone unavailable:** **[G]** Domains are discovered from the nodes that exist. A zone with no nodes is not considered (`:614-619`). Spreading is not maintained after Pods are removed, for example on scale-down (`:607-611`). **[N]** The docs do not describe exactly how replacements are scheduled when a zone loses all its nodes. Test this. `DoNotSchedule` together with `minDomains: 3` (`:107-115`) can leave Pods Pending. `ScheduleAnyway` favours availability over balance.

### 3. Probes for slow startup

- **[G]** A startup probe disables the other probes until it succeeds. If it fails, the container is killed and its restart policy applies (`concepts/workloads/pods/pod-lifecycle.md:492-497`). Size it so that `failureThreshold × periodSeconds` covers the worst-case startup time. For example, 30 × 10 gives 300 s, after which liveness takes over (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `pod-lifecycle.md:552-557`).
- **When traffic stops [G]:** When readiness fails, the Pod's IP is removed from the Service endpoints (`pod-lifecycle.md:485-490`). Readiness keeps running for the container's whole lifetime (`configure-liveness-readiness-startup-probes.md:360-362`).
- **When a container restarts [G]:** When liveness fails, the container is killed and restarted (`pod-lifecycle.md:479-483`).
- **[C]** Keep the liveness probe local to the process. Put database dependency checks only in the readiness probe (`pod-lifecycle.md:524-528`). This keeps a database outage from restarting every replica.

### 4. Termination

- **[G] Order of events:** The Pod is marked Terminating. The `preStop` hook runs inside the grace period, which defaults to 30 s, with a one-off 2 s extension. Then SIGTERM (or the image's STOPSIGNAL) is sent. When the grace period runs out, SIGKILL is sent (`pod-lifecycle.md:572-603, 636-645`).
- **[G] Endpoints:** At the same time, the endpoint is marked terminating with `ready=false`. Load balancers stop sending it regular traffic, and `serving` shows whether it can still finish work (`pod-lifecycle.md:612-632`).
- **Is 30 s enough? [N]** Nothing guarantees that 30 s finishes long requests. If preStop needs longer, you must raise `terminationGracePeriodSeconds` (`pod-lifecycle.md:598-601`). **[C]** Set it above (preStop delay + p99 request time + shutdown time), and measure those numbers.

### 5. Resources

- **[G]** CPU limits are enforced by throttling. Containers are not killed for using too much CPU (`concepts/configuration/manage-resources-containers.md:43-46, 252-257, 275-276`). Memory limits are enforced reactively by OOM kills (`:48-53, 261-265`). If only a limit is set, it is copied into the request (`:63-67`). The scheduler places Pods by their requests (`:232-241`).
- **[G] HPA without CPU requests:** Utilization is calculated against the request. If any container lacks a CPU request, utilization is undefined and HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102, 255-274`).
- **[C]** Set CPU and memory requests on every container, including sidecars. Set a memory limit. Decide deliberately whether a CPU limit is worth the throttling risk on latency-sensitive long requests.

### 6. HPA behaviour

- **[G] Basic loop:** HPA runs every 15 s by default and skips changes within a 0.1 tolerance (`horizontal-pod-autoscale.md:76-80, 141-147`). Pods being deleted are ignored, and failed Pods are discarded (`:156-158`).
- **[G] Missing metrics and unready Pods:** Pods without metrics are set aside. For CPU, Pods that are not yet ready are also set aside. That decision is controlled by an initial readiness delay of 30 s and a CPU initialization period of 5 min (`:160-178`). The ratio is then recomputed conservatively. Missing Pods count as 100% of the target on scale-down and 0% on scale-up, and not-ready Pods count as 0% on scale-up. If the recomputed ratio reverses direction or falls within tolerance, nothing happens (`:183-197`). The status reports the raw value (`:199-202`).
- **[G] Downscale stabilization:** The highest recommendation within a 5-minute window is used, so scale-downs happen gradually (`:213-218`).
- **[N]** Slow startup means new capacity arrives late. Scale-up speed has to be tested under load.

### 7. Least-privilege networking

- **[P]** NetworkPolicy only works if the CNI implements it. Without one, a policy object has no effect (`concepts/services-networking/network-policies.md:45-49`).
- **[G] Isolation:** Ingress and egress isolation are separate. A Pod becomes isolated in a direction once any policy with that `policyType` selects it. Allowed connections are the union of all matching rules, and reply traffic is allowed implicitly (`:51-77`).
- **[G] Both ends:** A connection needs egress allowed at the source and ingress allowed at the destination (`:79-81`). Traffic from the Pod's own node is always allowed (`:35-36, 70-72`).
- **[C] Plan:**
  1. Apply namespace default-deny for both ingress and egress (`:254-262`).
  2. Allow ingress to the API port from the ingress or gateway Pods.
  3. Allow egress to the database port and to cluster DNS.
  4. On the database side, allow ingress from the API Pods.
- **[N] DNS:** These docs do not spell out a DNS rule. Allowing DNS egress follows from the egress isolation semantics and has to be tested.
- **[N] Other limits:** Behaviour with SNAT/LoadBalancer source IPs is implementation-defined (`:196-206`). Policies take effect eventually, so Pods may start unprotected or without connectivity (`:362-394`).

### 8. Secrets

- **[G]** Base64 is not protection. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them. Anyone who can create a Pod, or indirectly a Deployment, in the namespace can read every Secret in it (`concepts/configuration/secret.md:35-40`).
- **[C]** Enable encryption at rest. Apply least-privilege RBAC on Secrets *and* on Pod and workload creation. Limit Secret access to the containers that need it. Consider an external secret store (`secret.md:42-48`).
- **[N]** Committing base64 Secrets to Git puts plaintext-equivalent credentials into Git history. The docs do not establish any Git-side mitigation, so keep plaintext Secrets out of Git.

### 9. Storage reclaim policy

- **[G]** Dynamically provisioned PVs take their reclaim policy from the StorageClass when they are created. The class defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:205-210`). Changing the class later does not rewrite existing PVs. They must be patched one by one (`persistent-volumes.md:207-210`).
- **[G] Retain vs Delete:** With `Retain`, the PV is kept as "Released" after the PVC is deleted, and the data has to be reclaimed manually (`persistent-volumes.md:185-199`). With `Delete`, both the PV and the backing storage asset are removed (`:201-205`).
- **[G] PVC deletion vs StatefulSet deletion or scaling:** Deleting or scaling down a StatefulSet does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`) only applies to deletion or scale-down, not to Pod replacement after a node failure (`statefulset.md:395-423`). Deleting a PVC is what triggers the PV's reclaim policy.
- **[C]** Use `Retain` for database data and patch any existing PVs explicitly.

### 10. Prioritized rollout and validation checklist

1. **Credentials (P1):** Move Secrets out of Git and rotate them. Enable encryption at rest. Tighten RBAC on Secrets and Pod creation (§8).
2. **Storage (P1):** Set the database PVs and StorageClass to `Retain`, and confirm the result with `kubectl get pv` (§9).
3. **Rollout (P1):** Set `maxSurge: 1`, `maxUnavailable: 0`, and PDB `maxUnavailable: 1` with `AlwaysAllow`. Test a drain while the app is under load (§1).
4. **Probes (P1):** Startup probe sized to the measured worst-case startup. Readiness includes dependencies; liveness stays local (§3).
5. **Termination (P1):** preStop plus a grace period above the measured request duration. Verify behaviour against EndpointSlice `serving`/`terminating` (§4).
6. **Resources and HPA (P2):** Set requests on all containers. Load-test the scale-up delay given slow startup and the 5-minute downscale window (§5–6).
7. **Zones (P2):** Zone spread with `maxSkew: 1`. Run a zone-loss game day (§2).
8. **Network (P2):** Confirm the CNI enforces NetworkPolicy. Roll out default-deny, then the allow rules including DNS and the database. Test connectivity from both ends (§7).

**Limits that need application or cluster validation (not guaranteed by these docs):**

- That 30 s, or any grace period, finishes the longest requests (`pod-lifecycle.md:598-601`).
- That the CNI enforces NetworkPolicy, how quickly policies take effect, and how SNAT affects source IPs (`network-policies.md:45-49, 196-206, 380-394`).
- That a PDB can hold five replicas through node or zone failure. It cannot (`configure-pdb.md:150-154`).
- Pending behaviour and spreading after a zone outage (`topology-spread-constraints.md:607-619`).
- How fast HPA scales up when Pods start slowly (`horizontal-pod-autoscale.md:163-197`).
- That cluster maintenance tooling uses the Eviction API rather than deleting Pods (`disruptions.md:62-65, 81-89`).
- The database's own failover and consistency during these events. Nothing in these documents addresses it.