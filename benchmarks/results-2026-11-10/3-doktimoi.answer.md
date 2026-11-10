**Decision: revise before production approval.** The proposed settings do not establish five-replica availability, completion of long requests, credential confidentiality, or database durability. The recommendations below distinguish documented controller behavior from configuration choices and validation requirements. All citations refer to local files beneath `docs/`.

1. **PDB protection depends on the disruption.**

   During **node failure**, `minAvailable: 5` cannot guarantee five available replicas: involuntary disruptions cannot be prevented, although they count against the budget. During **node drain**, a correctly selected PDB constrains eviction requests through the Eviction API; `kubectl drain` retries rejected evictions. This is conditional protection, not protection against direct deletion or simultaneous failures. During **Deployment rolling updates**, the Deployment is not constrained by the PDB.

   With six desired replicas, `maxUnavailable: 2` permits rollout availability to fall to four. Recommend `maxUnavailable: 1`, `maxSurge: 1`, with capacity for the extra Pod; use zero unavailable if stricter rollout protection is required. These settings govern rollout behavior, not independent failures.

   Sources: `concepts/workloads/pods/disruptions.md:92-141`; `concepts/workloads/controllers/deployment.md:1189-1211`.

2. **Spread deliberately, and choose an outage tradeoff.**

   Recommend a matching application `labelSelector`, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`, targeting two replicas per zone. The topology key groups nodes with identical label values into domains. Under `DoNotSchedule`, skew limits the difference between the target domain’s matching-Pod count and the global minimum; scheduling is refused when the constraint cannot be satisfied. `ScheduleAnyway` instead prefers placements reducing skew and allows imbalance.

   Zone unavailability does not imply automatic redistribution. Eligibility depends on selectors, affinity and taint handling. With `minDomains: 3`, fewer than three eligible domains makes the global minimum zero, potentially blocking replacements in surviving zones. Without it, the default is one. Choose strict spread or availability-first placement explicitly, and test the failure case. Losing a zone containing two replicas already leaves only four.

   Sources: `concepts/scheduling-eviction/topology-spread-constraints.md:82-130,163-180,209`.

3. **Separate startup, serving readiness, and recoverable failure.**

   Configure a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Until it succeeds, readiness and liveness probes are disabled. Repeated startup failure kills the container, subject to its restart policy.

   Recommend readiness that checks whether this instance can serve requests, including necessary database dependency conditions. Readiness failure removes the Pod from matching Service endpoints; it does not itself restart the container. Use liveness for conditions that restarting can repair, such as deadlock—not simply database unavailability. Liveness failure kills the container and invokes restart-policy behavior. Probe thresholds and application health semantics require measurement.

   Sources: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-367`; `concepts/workloads/pods/pod-lifecycle.md:475-510`.

4. **Thirty seconds is a budget, not a request-completion guarantee.**

   Termination records a deadline and grace period before local shutdown. The kubelet runs `preStop`, when configured and grace is nonzero, before requesting TERM delivery to process 1. Thus, the hook consumes the grace budget; it does not precede a fresh thirty-second application shutdown window. An overrun hook receives a small, one-off two-second extension. Remaining processes are forcibly killed with SIGKILL when grace expires.

   Endpoint processing occurs concurrently: terminating endpoints remain represented temporarily but have `ready: false`, excluding regular traffic; `serving` supports draining decisions. Recommend an application shutdown handler and a measured grace period covering hook execution and outstanding requests. The documentation does not guarantee that thirty seconds completes them.

   Source: `concepts/workloads/pods/pod-lifecycle.md:581-645`.

5. **Size resources for scheduling, performance, and autoscaling.**

   CPU requests inform scheduling and reserved resources; they are not CPU ceilings. Containers can exceed requests when resources are available. CPU limits impose throttling. Memory limits instead use reactive OOM killing: exceeding the limit can cause termination, rather than CPU-style throttling, and enforcement need not be immediate.

   CPU-utilization HPA calculates usage relative to CPU requests. If relevant requests are missing from some containers, Pod utilization is undefined and HPA takes no action for that metric. Set and inspect effective requests for all relevant containers, then load-test limits against startup and long-request latency. The supplied documents establish these mechanisms, not suitable numeric values for this API.

   Sources: `concepts/configuration/manage-resources-containers.md:16-65`; `tasks/run-application/horizontal-pod-autoscale.md:89-102`.

6. **HPA deliberately modifies the raw ratio.**

   The basic calculation is `ceil(current replicas × current metric / desired metric)`, but default tolerance is 0.1. Deleted and failed Pods are excluded; missing metrics and qualifying not-yet-ready CPU samples are set aside.

   Missing metrics are conservatively assumed to be 100% of the target during downscale and 0% during upscale. Not-yet-ready Pods are also treated as consuming zero when dampening an upscale. A recalculated ratio that reverses direction or falls within tolerance produces no scaling action. Reported average utilization still reflects the original calculation.

   Downscale stabilization defaults to five minutes, choosing the highest recommendation in the window. Working resource-metrics infrastructure is a prerequisite; slow startup and metric gaps therefore affect actual scaling.

   Sources: `tasks/run-application/horizontal-pod-autoscale.md:112-117,129-202,212-218`.

7. **Replace default allow with explicit communication permissions.**

   Apply ingress and egress isolation independently to the API and database. Recommend default-deny baselines, then permit only intended client-to-API traffic, API-to-database traffic on required ports, and necessary supporting services. Explicitly allow DNS egress to the cluster’s actual resolver endpoints and required protocols; that rule is an implementation choice to validate.

   Policies are additive unions: a broad allow elsewhere can defeat the intended restriction. A Pod-to-Pod connection requires both source egress and destination ingress permission; replies to allowed connections are implicitly permitted. Ingress isolation also retains the documented node-traffic exception.

   A NetworkPolicy-capable network plugin/controller is mandatory. Creating policy objects without enforcement has no effect.

   Source: `concepts/services-networking/network-policies.md:45-81`.

8. **Base64 is not confidentiality.**

   Reject base64-encoded credentials in Git as a protection strategy: encoding is reversible and the documentation explicitly describes it as obscuring, not securing, credentials. Enable Secret encryption at rest; Secrets are otherwise stored unencrypted in etcd. Configure least-privilege RBAC and restrict Secret exposure to necessary containers.

   Review workload-creation permissions as well as direct Secret permissions. Someone allowed to create Pods in a namespace can read its Secrets through those Pods; creating Deployments provides indirect access too. Encryption at rest does not make repository copies confidential or neutralize authorized workload access.

   Source: `concepts/configuration/secret.md:35-48,286-306`.

9. **Reclamation belongs to each PV; StatefulSet retention is separate.**

   StorageClass reclaim policy supplies the policy for dynamically provisioned PVs, defaulting to `Delete`. Changing the class is not a retroactive update of existing PV policies; inspect and explicitly patch existing PVs as necessary.

   After PVC deletion, `Retain` leaves the PV released with data requiring manual reclamation. For supporting plugins, `Delete` removes both the PV object and external storage asset. Recommend explicit retention decisions for database volumes.

   StatefulSet deletion or scale-down does not inherently mean PVC deletion: PVC retention defaults to `Retain`. Configured `whenDeleted` or `whenScaled: Delete` removes the corresponding claims, after which PV reclamation applies. Dynamic provisioning alone establishes neither backup nor database recovery guarantees.

   Sources: `concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:185-210`; `concepts/workloads/controllers/statefulset.md:406-445`.

10. **Prioritize validation before expanding production exposure.**

   First, remove repository credential exposure, verify encryption/RBAC, confirm network-policy enforcement, and audit database PVC/PV retention. Second, implement probes and graceful shutdown, measuring worst-case startup and request-drain duration. Third, align rollout availability with the PDB, configure zone placement, and verify surge capacity. Fourth, establish CPU requests and metrics, then exercise autoscaling under load.

   Finally, rehearse a rollout, drain, zone loss, database outage, and storage recovery. Acceptance must validate at least these unguaranteed limits: request completion before SIGKILL, sufficient surviving-zone capacity, health-check accuracy during database failures, CNI enforcement, and recoverability of database data. API fields alone establish none of those application or cluster outcomes.

   Sources: `concepts/workloads/pods/pod-lifecycle.md:581-645`; `concepts/scheduling-eviction/topology-spread-constraints.md:82-130`; `concepts/services-networking/network-policies.md:45-49`; `concepts/storage/persistent-volumes.md:185-210`.