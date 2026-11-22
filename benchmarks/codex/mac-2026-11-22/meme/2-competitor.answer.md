**Decision memo — revise before production approval.** The design needs coordinated availability, shutdown, security, and storage controls. Kubernetes documents their mechanisms, but does not establish application safety from the presence of API fields. All citations below refer to local files under the supplied `docs/` directory; ranges are source lines.

1. **The PDB does not guarantee five available replicas in all three cases.** Node failure is an involuntary disruption: PDBs cannot prevent it, although unavailable Pods count against the budget. During node drain, tools using the Eviction API respect the budget; with six healthy replicas, `minAvailable: 5` normally permits one eviction, then blocks further evictions until availability recovers. Direct deletion bypasses this protection. Deployment rolling updates count against the budget but are **not constrained by it**.  
   Sources: `docs/concepts/workloads/pods/disruptions.md:62–65, 99–145`.

   Proposed `maxUnavailable: 2` permits rollout availability to fall to four. Recommend `maxUnavailable: 1`, `maxSurge: 1`, with capacity for the extra Pod; `maxUnavailable: 0` is a more conservative option. These govern rollout behavior, not simultaneous failures.  
   Source: `docs/concepts/workloads/controllers/deployment.md:1183–1211`.

2. **Configure explicit zone spreading.** Use the API’s Pod selector, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`, aiming for two replicas per zone. `topologyKey` groups equally labeled nodes into domains. With `DoNotSchedule`, skew limits the difference between the target domain’s matching Pod count and the global minimum; violating placements remain Pending. `ScheduleAnyway` prefers placements reducing skew but permits imbalance.  
   Source: `docs/concepts/scheduling-eviction/topology-spread-constraints.md:78–130`.

   Choose the outage tradeoff explicitly. `minDomains: 3` with hard spreading makes the global minimum zero if fewer than three domains remain eligible, potentially blocking replacements. Without it, the default behaves as one minimum domain, allowing balancing across remaining eligible domains. Actual eligibility depends on node affinity and taint policies. A zone loss from a 2/2/2 layout immediately leaves four replicas. Spreading cannot guarantee five, and Pod removal need not preserve balance.  
   Source: same file, `95–122, 167–185, 605–619`.

3. **Gate slow startup with a startup probe.** Set `failureThreshold × periodSeconds` to cover measured worst-case initialization. Until startup succeeds, readiness and liveness probes do not begin. Startup failure reaching its threshold kills the container, subject to restart policy.  
   Source: `docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311–347`.

   Use readiness to represent ability to serve requests, including necessary database access; failure removes the Pod from Service backends without requiring a restart. Use liveness for unrecoverable local failure, such as deadlock, rather than ordinary database unavailability. Liveness failure kills the container and invokes restart policy. Probe thresholds and endpoint semantics require application testing.  
   Sources: `docs/concepts/workloads/pods/pod-lifecycle.md:479–497`; `docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:23–47, 349–367`.

4. **Thirty seconds does not guarantee request completion.** The grace-period clock begins **before** `preStop`; the hook consumes that budget. The kubelet runs the hook before requesting TERM delivery to the container’s main process. A still-running hook can receive a small, one-off two-second extension. Remaining processes receive SIGKILL when graceful shutdown expires. Some runtimes honor an image’s configured stop signal instead of TERM.  
   Sources: `docs/reference/kubernetes-api/workload-resources/pod-v1.md:1006–1008`; `docs/concepts/workloads/pods/pod-lifecycle.md:572–610, 636–640`.

   Endpoint updates occur concurrently with shutdown. Terminating endpoints remain represented temporarily, have `ready: false` for regular traffic, and expose `serving` for draining-aware consumers. Implement request draining and signal handling, then size grace time for hook execution plus outstanding work. These documents do not guarantee every long request completes.  
   Source: `docs/concepts/workloads/pods/pod-lifecycle.md:612–632`.

5. **Set measured resource requests and limits.** Requests drive scheduling capacity checks; CPU requests also typically determine relative CPU weighting under contention. A request is not a usage ceiling. CPU limits enforce throttling; memory limits are enforced reactively through OOM killing, rather than CPU-style throttling.  
   Source: `docs/concepts/configuration/manage-resources-containers.md:29–53, 230–265`.

   CPU-utilization HPA calculates usage relative to requests. If relevant requests are missing from some containers, Pod CPU utilization is undefined and HPA does not act for that metric. Inspect admitted Pods: a limit can become the request when no request or admission default exists. Explicitly size every relevant container, including sidecars.  
   Sources: `docs/tasks/run-application/horizontal-pod-autoscale.md:89–102`; `docs/concepts/configuration/manage-resources-containers.md:63–66`.

6. **Expect conservative HPA decisions.** The raw calculation is the ceiling of current replicas multiplied by current/desired metric value, but the controller ignores terminating and failed Pods and sets aside missing metrics and certain not-yet-ready CPU samples. Missing metrics are assumed at 100% of target for downscale and 0% for upscale; not-yet-ready Pods further dampen upscale using 0%. A reversed direction or ratio within tolerance produces no scaling. Default tolerance is 0.1.  
   Source: `docs/tasks/run-application/horizontal-pod-autoscale.md:129–202`.

   Default readiness delay is 30 seconds and CPU initialization period five minutes. Default downscale stabilization is five minutes, selecting the highest recommendation in the window. Verify the resource metrics API—usually supplied by separately installed Metrics Server—and controller settings.  
   Source: same file, `113–118, 167–178, 213–218`.

7. **Replace default allow with explicit isolation and allowances.** Establish default-deny ingress and egress, then allow authorized callers to API ports, API access to the database port, and required operational dependencies. Ingress and egress isolation are independent. Policies combine additively: an existing broad allowance remains effective. A Pod-to-Pod connection requires both source egress and destination ingress permission; permitted reply traffic is implicit.  
   Source: `docs/concepts/services-networking/network-policies.md:51–81`.

   Allow DNS egress to the actual cluster resolver, normally UDP and TCP port 53, and validate the deployed resolver topology. NetworkPolicy requires an enforcing network plugin; creating objects alone can have no effect.  
   Sources: `docs/tasks/administer-cluster/dns-debugging-resolution.md:158–174`; `docs/concepts/services-networking/network-policies.md:45–49`.

8. **Base64 Secrets in Git are insufficient protection.** Base64 is the Secret data representation, not a confidentiality control. Reject this repository practice. Secrets are stored unencrypted in etcd by default; enable encryption at rest, least-privilege RBAC, and access only from containers needing the credentials. Pod creation permission—including indirect creation through Deployments—can expose any Secret in that namespace, so restricting direct Secret reads alone is insufficient.  
   Source: `docs/concepts/configuration/secret.md:35–48, 448–457`.

   Verify encryption configuration and migration of existing data: enabling a provider does not prove previously stored resources were encrypted. This protection concerns API data, not Git copies or database volume contents.  
   Source: `docs/tasks/administer-cluster/encrypt-data.md:21–32, 53–73`.

9. **Existing PVs retain their own reclaim policies.** StorageClass policy supplies dynamically provisioned PVs’ policy; changing class configuration does not retrofit existing PVs. Inspect and edit or patch those PVs explicitly. `Retain` leaves a released PV and its data for manual reclamation after PVC deletion. Supported `Delete` removes both the PV and backing storage. The dynamic-provisioning default is `Delete`.  
   Sources: `docs/concepts/storage/storage-classes.md:126–135`; `docs/concepts/storage/persistent-volumes.md:178–210`.

   PVC deletion differs from StatefulSet deletion or scale-down. StatefulSet claim retention defaults to `Retain`; optional `whenDeleted` and `whenScaled` policies can delete template-created PVCs, subsequently triggering PV reclamation. Verify feature prerequisites. The API’s Deployment does not establish how the database is managed.  
   Source: `docs/concepts/workloads/controllers/statefulset.md:387–423`.

10. **Prioritize implementation and validation as follows.**
   
   - **First:** remove repository credentials, verify encryption and access controls, and establish tested database retention and recovery procedures.
   - **Second:** configure requests, startup/readiness/liveness probes, signal handling, and measured shutdown grace.
   - **Third:** deploy enforcing network policies and test allowed callers, database access, DNS, and denied paths.
   - **Fourth:** apply zone spreading, compatible rollout limits, and HPA settings; exercise rolling updates, drains, zone failure, and missing metrics.

   These checks follow the documented prerequisites and limitations above, especially `disruptions.md:130–145`, `pod-lifecycle.md:591–640`, and `horizontal-pod-autoscale.md:153–218` under their cited directories. Production acceptance still requires validation of **request completion**, **capacity and placement after zone loss**, **database recovery and data durability**, and **actual network-policy enforcement**. The cited mechanisms do not establish those outcomes.