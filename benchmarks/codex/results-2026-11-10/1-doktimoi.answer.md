**Decision memo — revise before production approval.** The proposed fields provide useful controls, but they do not establish five-replica availability, successful request draining, or database durability. The recommendations below distinguish documented behavior from configuration choices and validation requirements. All citations are local paths relative to the supplied `docs/` directory.

1. **PDB, failures, drains, and updates.** `minAvailable: 5` does not guarantee five available replicas during node failure: involuntary disruptions cannot be prevented, although they count against the budget. During a drain using the Eviction API, the PDB constrains voluntary evictions; with six healthy replicas, one can be evicted before further evictions must wait. Direct deletions bypass this protection. Deployment rolling updates also bypass PDB enforcement, although unavailable rollout Pods count against the budget.

   Replace `maxUnavailable: 2`, which permits availability to fall to four, with `maxUnavailable: 1`, `maxSurge: 1`; consider zero unavailable if surge capacity permits. These constrain rollout behavior, not simultaneous failures.  
   Sources: `concepts/workloads/pods/disruptions.md:100-141`; `concepts/workloads/controllers/deployment.md:1189-1211`.

2. **Zone placement and outage tradeoffs.** Configure a Pod topology spread constraint selecting all API replicas, with `topologyKey: topology.kubernetes.io/zone` and `maxSkew: 1`. Correct node labels and eligible capacity are prerequisites. With three usable zones, this targets two replicas per zone.

   Under `DoNotSchedule`, skew limits the difference between the target domain’s matching-Pod count and the global minimum. `ScheduleAnyway` makes reducing skew a scheduling preference, allowing imbalance. An unavailable zone does not imply automatic redistribution: eligibility and remaining capacity matter. Explicit `minDomains: 3` makes the minimum zero when fewer than three domains are eligible, potentially blocking replacements in already populated zones. Choose strict spreading or degraded-zone scheduling deliberately. Losing two of six evenly spread replicas leaves four.  
   Source: `concepts/scheduling-eviction/topology-spread-constraints.md:82-140`.

3. **Probes for slow startup.** Use a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Readiness and liveness probes begin only after startup succeeds. Exhausting startup failures kills the container, with restart governed by `restartPolicy`.

   Readiness should indicate whether the API can accept useful requests, including necessary database access; failed readiness removes the Pod from Service load-balancer backends without itself requiring restart. Use liveness for unrecoverable process failure, such as deadlock. Avoid making a temporary database outage a reason to restart every API replica. That separation is a design recommendation; probe semantics cannot establish that the application’s checks are correct.  
   Sources: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:13-43`, `:311-347`.

4. **Termination and long requests.** The grace-period clock starts **before** `preStop`. The hook therefore consumes shutdown time; afterward the runtime normally sends SIGTERM to process 1. Image stop-signal configuration can alter that signal. Remaining processes receive SIGKILL when grace expires; an overlong hook receives only a small, one-off two-second extension.

   Endpoint updates happen concurrently with shutdown. Terminating endpoints are not immediately removed from EndpointSlices, but have `ready: false` for regular traffic; `serving` supports draining-aware consumers. Thirty seconds is not a request-completion guarantee. Measure hook duration, request duration, and routing propagation, then configure sufficient grace and application draining.  
   Sources: `reference/kubernetes-api/workload-resources/pod-v1.md:1006-1008`; `concepts/workloads/pods/pod-lifecycle.md:560-640`.

5. **Resource requests, limits, and HPA prerequisites.** Set realistic CPU requests for every relevant container. Requests guide placement and CPU allocation under contention; they are not ceilings. CPU limits impose throttling, which can lengthen requests. Memory limits instead trigger reactive OOM enforcement: exceeding the limit may cause a process kill, not immediate throttling or guaranteed immediate termination.

   CPU-utilization HPA measures usage relative to requests. If relevant requests are missing from some containers, Pod utilization is undefined and HPA does not act on that metric. Inspect admitted Pod configuration: when a limit exists without a request or admission default, Kubernetes copies the limit into the request.  
   Sources: `concepts/configuration/manage-resources-containers.md:15-66`, `:252-269`; `tasks/run-application/horizontal-pod-autoscale.md:89-102`.

6. **Why HPA differs from the raw ratio.** The basic calculation rounds up current replicas multiplied by current/desired metric value, but ignores terminating and failed Pods and sets aside missing metrics and relevant not-yet-ready CPU samples. Missing metrics are conservatively treated as 100% of target for downscaling and 0% for upscaling. Not-yet-ready Pods further dampen scale-up using 0%.

   If recalculation reverses direction or falls within tolerance, scaling stops. Default tolerance is 10%; readiness-delay and CPU-initialization windows default to 30 seconds and five minutes. Downscale stabilization selects the highest recommendation from the preceding five-minute default window. Reported utilization excludes these conservative adjustments, so status alone need not explain the action.  
   Sources: `tasks/run-application/horizontal-pod-autoscale.md:129-202`, `:213-218`.

7. **Least-privilege networking.** Establish default-deny ingress and egress, then allow only approved callers to the API, API connections to the database’s required port, DNS queries to the cluster resolver, and explicitly identified operational dependencies. Scope rules with appropriate Pod and namespace selectors.

   Ingress and egress isolation are independent. Policies combine additively: a restrictive policy cannot override an existing allow-all rule. For Pod-to-Pod communication, both source egress and destination ingress must permit the connection; allowed reply traffic is implicit. A NetworkPolicy-capable networking plugin is a prerequisite—creating policy objects alone has no effect. Validate actual resolver destinations and enforcement in this cluster.  
   Sources: `concepts/services-networking/network-policies.md:46-81`, `:224-232`; `concepts/security/multi-tenancy.md:208-225`.

8. **Secrets and Git.** Base64 is reversible encoding, not confidentiality; reject base64-only Secrets in Git. The documentation explicitly describes encoded credentials as “obscured but not secret.” Kubernetes Secrets are stored unencrypted in etcd by default.

   Enable encryption at rest, apply least-privilege RBAC, and expose each Secret only to containers that require it. Review workload-creation permissions alongside direct Secret access: someone authorized to create Pods in a namespace can use that ability to read its Secrets, including indirectly through Deployment creation. Encryption at rest does not cure excessive API permissions or protect an encoded copy committed to Git.  
   Sources: `concepts/configuration/secret.md:32-48`, `:304-307`.

9. **Storage lifecycle and data retention.** A dynamically provisioned PV inherits its StorageClass reclaim policy, defaulting to `Delete`. Changing the class’s policy does not retroactively rewrite existing PVs; inspect and explicitly patch those PVs where needed.

   With `Retain`, deleting a PVC leaves its PV released and its data requiring manual reclamation. With supported `Delete` implementations, reclamation removes both the PV and backing storage. StatefulSet deletion or scale-down is a separate decision: claim retention defaults to `Retain`; optional `whenDeleted` and `whenScaled` policies can delete generated PVCs, subject to the documented feature prerequisite. PVC deletion then engages PV reclamation. Neither retention mechanism constitutes a backup.  
   Sources: `concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:185-210`; `concepts/workloads/controllers/statefulset.md:387-425`.

10. **Prioritized rollout and validation checklist.** First, remove the credential-exposure pattern, enable encryption and scoped RBAC, verify network-policy enforcement, and inspect existing database PV policies. Second, implement probes and draining, resource requests, compatible rollout settings, and an explicit zone-outage placement choice. Third, validate metrics availability and configure HPA bounds consistent with the intended six-replica baseline; Metrics Server is normally a separately installed prerequisite.

   Before release, exercise a rolling update, node drain, zone outage, database interruption, long-request shutdown, and PVC lifecycle in a representative environment. Acceptance must establish at least these undocumented application-specific limits: worst-case startup time; request-drain completion time; surviving-zone and database capacity; and storage recovery/durability. Also test CPU throttling, OOM behavior, and HPA response under missing metrics. These tests turn configurable mechanisms into evidence for this deployment.  
   Sources: `tasks/run-application/horizontal-pod-autoscale.md:113-118`; `concepts/workloads/pods/disruptions.md:126-135`; `concepts/workloads/pods/pod-lifecycle.md:611-640`; `concepts/storage/persistent-volumes.md:185-210`.