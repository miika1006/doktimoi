**Decision memo — revise before production approval.** The proposed fields do not collectively guarantee availability, request completion, confidentiality, or database durability. The recommendations below distinguish documented behavior from configuration choices and validation requirements.

Citations use paths relative to the supplied `docs/` directory, followed by original source line ranges.

1. **PDB and rollout availability**

   `minAvailable: 5` does **not** guarantee five available replicas during node failure: involuntary disruptions cannot be prevented and count against the budget. During a normal `kubectl drain`, the Eviction API respects the PDB, rejecting and retrying evictions that would violate it. This depends on using eviction-aware tooling; direct deletion bypasses that protection. Deployment rolling updates are **not constrained by PDBs**, although their unavailable Pods count against the budget.  
   Sources: `concepts/workloads/pods/disruptions.md:100–145`.

   With six desired replicas, `maxUnavailable: 2` permits rollout availability to fall to four. Recommend `maxUnavailable: 1`, `maxSurge: 1`, and sufficient surge capacity; `maxUnavailable: 0` is a more conservative alternative. These govern rollout behavior, not concurrent failures. Configure HPA’s minimum to preserve the intended six-replica baseline.  
   Source: `concepts/workloads/controllers/deployment.md:1184–1212`.

2. **Zone placement and outage behavior**

   Configure a matching application `labelSelector`, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`. Nodes with the same topology-label value form a domain. With three eligible, adequately provisioned zones, this supports a balanced 2/2/2 placement. For `DoNotSchedule`, skew is the difference between the target domain’s matching-Pod count and the global minimum. `ScheduleAnyway` instead prefers placements that reduce skew, without enforcing that bound.  
   Source: `concepts/scheduling-eviction/topology-spread-constraints.md:76–133`.

   Choose hard spreading only with an explicit outage tradeoff. With `minDomains: 3`, fewer than three eligible domains makes the global minimum zero; replacements can remain Pending. Without it, the default is one, potentially allowing redistribution across remaining eligible domains. Eligibility depends on affinity and taint policies—not merely whether a zone is operational. Soft spreading favors replacement availability but sacrifices guaranteed balance. Losing two Pods in a balanced zone immediately leaves four; spreading does not guarantee five survivors.  
   Sources: same document, `95–125`, `167–190`.

3. **Probes for slow startup**

   Use a startup probe with a failure budget covering measured worst-case initialization. Until it succeeds, readiness and liveness probes are disabled. Startup or liveness failure triggers container termination and the configured restart policy; readiness failure removes the Pod from matching Service endpoints without itself restarting the container.  
   Sources: `concepts/workloads/pods/pod-lifecycle.md:475–497`, `544–557`.

   Readiness should indicate ability to serve useful requests, including required database availability. Liveness should assess the application’s own health so a database outage does not automatically become a restart storm. Service traffic becomes eligible after readiness succeeds; readiness is not proof that every request will succeed. Probe thresholds and dependency checks require application testing.  
   Source: `concepts/workloads/pods/pod-lifecycle.md:512–533`.

4. **Termination and long requests**

   The grace-period countdown starts **before** `preStop`; the hook consumes that budget. The kubelet runs the hook, then requests TERM delivery to the container’s main process. Runtime/image stop-signal behavior can differ. An unfinished hook can receive a one-off two-second extension; remaining processes are forcibly killed with SIGKILL when termination expires.  
   Sources: `reference/kubernetes-api/workload-resources/pod-v1.md:1006–1008`; `concepts/workloads/pods/pod-lifecycle.md:572–609`, `635–639`.

   Endpoint changes happen concurrently with shutdown. Terminating endpoints are not immediately removed from EndpointSlices, but have `ready: false` for regular traffic; `serving` supports draining-aware consumers. Thirty seconds does **not** guarantee completion of long requests. Select a grace period covering measured hook execution, connection draining, and application shutdown, and verify signal handling and traffic-path behavior.  
   Source: `concepts/workloads/pods/pod-lifecycle.md:611–639`.

5. **Resource requests, limits, and HPA**

   CPU requests inform scheduling capacity checks and typically CPU weighting under contention; they are not consumption ceilings. Containers can exceed requests when resources are available. CPU limits impose throttling. Memory limits operate differently: enforcement is reactive through OOM killing, so exceeding a memory limit need not cause an immediate kill.  
   Sources: `concepts/configuration/manage-resources-containers.md:27–52`, `230–257`.

   Set measured CPU requests for every relevant container. Utilization-based HPA divides CPU usage by requests; missing relevant requests make Pod utilization undefined and prevent action for that metric. Inspect admitted configuration: when a limit exists without a request or admission default, Kubernetes copies the limit into the request. Size limits through load testing, especially for latency-sensitive long requests.  
   Sources: `tasks/run-application/horizontal-pod-autoscale.md:89–101`; `concepts/configuration/manage-resources-containers.md:62–67`.

6. **HPA’s conservative adjustments**

   The basic calculation is current replicas multiplied by current/desired metric value, rounded upward, with default tolerance of 0.1. Deleting and failed Pods are excluded; missing metrics and qualifying not-yet-ready CPU Pods are set aside. Missing metrics are conservatively assumed at 100% of target during downscale and 0% during upscale. Not-yet-ready Pods also dampen an otherwise indicated upscale.  
   Source: `tasks/run-application/horizontal-pod-autoscale.md:130–190`.

   If recalculation reverses direction or falls within tolerance, scaling stops. Readiness interpretation uses configurable defaults of 30 seconds and a five-minute CPU initialization period. Downscale stabilization defaults to five minutes, selecting the highest recommendation in that window. Consequently, scaling can differ from both the raw ratio and displayed utilization. Validate this interaction with slow startup.  
   Source: same document, `167–218`.

7. **Least-privilege networking**

   Establish default-deny ingress and egress, then permit approved callers to the API, API-to-database traffic on its required port, and necessary infrastructure traffic. Isolation is independent in each direction. Policies are additive unions: a broad existing allow cannot be overridden by another deny policy. For Pod-to-Pod connections, source egress and destination ingress must both permit traffic; replies are implicitly allowed. Node-origin traffic has a documented ingress exception.  
   Source: `concepts/services-networking/network-policies.md:45–81`.

   Explicitly allow DNS to the actual cluster resolver, including required UDP/TCP 53 traffic. Verify resolver placement and selectors. A NetworkPolicy-capable networking implementation is a prerequisite; objects alone do nothing. Test enforcement and Service/NAT behavior in this cluster.  
   Sources: `tasks/administer-cluster/dns-debugging-resolution.md:158–174`; `concepts/services-networking/network-policies.md:45–49`, `190–203`.

8. **Secrets protection**

   Reject base64-encoded credentials in Git as a confidentiality control: the documentation describes base64 authentication data as obscured, not secret. Enable Secret encryption at rest; Secrets otherwise default to unencrypted storage in etcd. Apply least-privilege RBAC and restrict exposure to containers that need credentials.  
   Source: `concepts/configuration/secret.md:35–48`, `306`.

   Pod-creation permission is also sensitive: someone authorized to create Pods in a namespace can read its Secrets through those Pods, including indirectly through Deployment creation. Review workload-creation permissions alongside direct Secret access. Cluster encryption does not protect a credential copied into Git.  
   Source: same document, `36–40`.

9. **Storage reclamation and claim retention**

   Dynamically provisioned PVs inherit the StorageClass reclaim policy at creation; its default is `Delete`. Changing the class is not a retroactive update of existing PV policies: inspect and explicitly patch existing PVs where needed.  
   Sources: `concepts/storage/storage-classes.md:126–135`; `concepts/storage/persistent-volumes.md:203–210`.

   After PVC deletion, `Retain` leaves the PV released with data requiring manual reclamation. Supported `Delete` implementations remove both PV and backing storage. StatefulSet deletion/scaling is separate: template PVCs default to retention, while `whenDeleted` and `whenScaled` can request their deletion, subsequently invoking PV reclamation behavior. Do not confuse these two retention layers.  
   Sources: `concepts/storage/persistent-volumes.md:185–210`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130–144`.

10. **Prioritized rollout and validation checklist**

   - **First:** remove Git-held credentials, verify encryption/RBAC and workload permissions, then test network isolation including database and DNS access. Sources: Secret `35–48`; NetworkPolicy `45–81`.
   - **Second:** establish startup/readiness/liveness behavior, resource requests, HPA settings, and measured shutdown timing. Validate startup duration, sustained-load latency, database saturation, and long-request completion; these documents establish no application-specific safe values. Sources: Pod lifecycle `475–557`, `591–639`; HPA `167–218`.
   - **Third:** stage the compatible rollout, drain, node-failure, and zone-outage exercises. Verify surge capacity, placement, and endpoint behavior. Five-replica survival under arbitrary failure remains unguaranteed. Sources: disruptions `100–145`; topology spreading `95–125`.
   - **Before database deployment:** inspect actual PV policies and rehearse deletion and recovery. Dynamic provisioning alone establishes neither database consistency nor recoverability; validate storage-driver behavior and backups separately. Source: persistent volumes `185–210`.