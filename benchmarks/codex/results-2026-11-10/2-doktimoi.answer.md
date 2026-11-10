**Decision: revise before production approval.** The proposed configuration does not establish five-replica availability, safe request draining, credential confidentiality, or database recoverability. The recommendations below distinguish Kubernetes behavior from configuration choices and application guarantees. Citations refer to paths beneath the supplied `docs/` directory.

1. **PDB and rollout availability.** `minAvailable: 5` constrains voluntary evictions using the Eviction API. With six healthy replicas, a compliant node drain can evict one; further evictions wait for sufficient availability. Direct deletion bypasses this protection. Node failure is involuntary: PDBs cannot prevent it, although unavailable Pods count against the budget. Deployment rolling updates also bypass PDB enforcement; their unavailable Pods still count against it.

   The proposed `maxUnavailable: 2` therefore permits rollout availability to fall to four. Recommend `maxUnavailable: 0, maxSurge: 1`, with capacity for the surge; `maxUnavailable: 1` is another configuration compatible with a five-of-six rollout floor. Neither protects against concurrent failures.  
   Sources: `concepts/workloads/pods/disruptions.md:95-141`; `concepts/workloads/controllers/deployment.md:1189-1211`.

2. **Zone placement and failure.** Configure an application-matching selector, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`; verify node labels. With three eligible zones and six replicas, balanced placement is two per zone. `topologyKey` groups equally labelled nodes into domains. Under `DoNotSchedule`, skew limits the difference between the target domain’s matching-Pod count and the global minimum. Under `ScheduleAnyway`, reducing skew is a scheduling preference.

   Losing a zone can immediately leave four replicas. Replacement placement depends on domain eligibility, taints, capacity, and constraints. Explicit `minDomains: 3` makes the global minimum zero when fewer than three domains remain eligible; strict skew can then block replacements. Choose strict spreading if preserving distribution outweighs scheduling progress, or soft spreading if degraded-zone capacity is preferred. Neither guarantees recovery.  
   Sources: `concepts/scheduling-eviction/topology-spread-constraints.md:82-135,177-190`; `concepts/architecture/nodes.md:253-267`.

3. **Probes for slow startup.** Use a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Readiness and liveness probes begin only after startup succeeds. Exhausting startup failures kills the container, with restart governed by its restart policy.

   Readiness should reflect ability to serve requests, including essential database dependency readiness; failure removes the Pod from Service traffic without itself requiring restart. Liveness should detect an unrecoverable condition such as deadlock. Avoid making transient database failure a liveness failure that restarts every API replica. Thresholds and health endpoints are application choices requiring tests.  
   Sources: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:27-48,311-347,349-366`.

4. **Termination and long requests.** The termination grace deadline is established before local shutdown. A configured `preStop` runs before TERM, consuming the same grace budget; it does not receive an additional 30 seconds. The runtime then sends TERM to process 1. At expiry, remaining processes receive SIGKILL; an overrunning hook can receive a one-off two-second extension.

   Endpoint handling proceeds concurrently. Terminating endpoints are not immediately removed from EndpointSlices, but have `ready: false`, excluding them from regular traffic; `serving` supports draining-aware consumers. Thirty seconds does **not** guarantee request completion. Implement signal handling and draining, then size the grace period for hook execution and outstanding work. Validate routing propagation and existing connections.  
   Source: `concepts/workloads/pods/pod-lifecycle.md:581-644`.

5. **Requests, limits, and CPU autoscaling.** CPU requests inform scheduling and provide the denominator for utilization-based HPA; they are not CPU usage caps. Containers can exceed requests when resources are available. CPU limits enforce throttling, potentially affecting long-request latency. Memory limits instead use reactive OOM killing: over-allocation may lead to termination rather than throttling.

   Set realistic CPU requests for every relevant container. If some containers lack the relevant request, Pod CPU utilization is undefined and HPA cannot act on that metric. Check effective admitted configuration: absent another default, specifying a limit without a request causes Kubernetes to copy the limit into the request.  
   Sources: `concepts/configuration/manage-resources-containers.md:15-53,63-69`; `tasks/run-application/horizontal-pod-autoscale.md:89-101`.

6. **HPA’s conservative adjustments.** The raw formula rounds up current replicas multiplied by current-to-target metric ratio, but it is only the starting point. HPA sets aside missing metrics and certain CPU samples from not-yet-ready Pods. Missing samples are assumed at 100% of target for downscaling and 0% for upscaling; not-yet-ready Pods also dampen potential upscaling using 0%. If recalculation reverses direction or falls within tolerance, no scaling occurs.

   Default readiness-delay and CPU-initialization windows are 30 seconds and five minutes. Downscale stabilization defaults to 300 seconds and selects the highest recommendation within the window. Thus displayed utilization and the raw ratio need not predict the actual replica change. A working metrics API is a prerequisite.  
   Source: `tasks/run-application/horizontal-pod-autoscale.md:109-115,128-202,212-218`.

7. **Least-privilege networking.** Establish ingress and egress default denial, then permit intended callers to the API, API connections to the database’s required port, DNS resolution, and explicitly justified dependencies. Ingress and egress isolation are independent. Policies are additive unions: an overly broad allow policy cannot be cancelled by another restrictive policy. For Pod-to-Pod connections, both source egress and destination ingress must permit the connection; response traffic is implicitly allowed.

   Verify that the installed CNI/network-policy implementation enforces these resources. Merely creating NetworkPolicy objects can have no effect. Test approved traffic, rejected traffic, and DNS against actual cluster selectors and addresses.  
   Sources: `concepts/services-networking/network-policies.md:45-82`; `concepts/security/multi-tenancy.md:208-225`.

8. **Secrets and repository exposure.** Reject base64-encoded credentials in Git as a protection mechanism: base64 obscures data but does not make it secret. Enable Secret encryption at rest; etcd storage is unencrypted by default. Apply least-privilege RBAC and expose Secrets only to containers that need them.

   Restrict workload-creation permissions too. Someone authorized to create Pods in a namespace can read its Secrets through those Pods; Deployment creation provides indirect access. Preventing direct Secret reads alone is therefore insufficient. Encryption at rest also does not protect a credential already disclosed through repository access.  
   Source: `concepts/configuration/secret.md:35-49,305-307`.

9. **Storage and deletion semantics.** Dynamically provisioned PVs inherit their StorageClass reclaim policy at creation; the default is `Delete`. Changing the class policy does not retrofit existing PVs: inspect and edit those PVs separately.

   After PVC deletion, `Retain` leaves the PV released with data requiring manual reclamation. For supporting plugins, `Delete` removes both the PV object and backing storage. StatefulSet deletion/scaling is a separate decision: default PVC retention is `Retain`; configured `whenDeleted` or `whenScaled: Delete` can delete affected template-generated PVCs after Pods terminate, then PV reclamation applies. Verify the documented feature-gate prerequisites. The API’s Deployment does not establish how the database is managed.  
   Sources: `concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:185-210`; `concepts/workloads/controllers/statefulset.md:387-425`.

10. **Prioritized rollout and validation checklist.**

   - **Before release:** remove exposed credential material from deployment workflows; establish encryption/RBAC and tested network isolation. Audit existing database PV policies and PVC retention. These safeguards require effective configuration, not just manifests. Sources: `concepts/configuration/secret.md:35-49`; `concepts/services-networking/network-policies.md:45-82`; `concepts/storage/persistent-volumes.md:201-210`.
   - **Before rollout:** configure compatible rollout limits, spreading, startup/readiness/liveness probes, resource requests, and measured termination timing. Test a rolling update, compliant drain, and zone outage separately. Sources: `concepts/workloads/pods/disruptions.md:95-141`; `concepts/workloads/pods/pod-lifecycle.md:581-644`.
   - **Before approval:** validate at least four unresolved limits: worst-case startup time; long-request completion during shutdown; surviving-zone capacity and replacement scheduling; and database recovery with actual storage. Also load-test HPA response, throttling, and database connection capacity. These documents establish mechanisms, not application latency, capacity, backup recoverability, or failover guarantees. Sources: `tasks/run-application/horizontal-pod-autoscale.md:128-202`; `concepts/scheduling-eviction/topology-spread-constraints.md:82-135`; `concepts/storage/persistent-volumes.md:185-210`.