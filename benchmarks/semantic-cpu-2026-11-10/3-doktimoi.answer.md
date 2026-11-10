**Decision memo — revise before production approval.** The proposed configuration does not establish five-replica availability, safe request draining, or database durability. The recommendations below distinguish documented behavior from configuration choices and validation requirements.

Citations use paths relative to `/var/folders/3t/t35161bs2slggt46tnrk0b4c0000gn/T/doktimoi-bench-3-doktimoi-HBLwcm/docs`; ranges refer to original source lines.

1. **PDB, failures, drains, and rollouts.** `minAvailable: 5` does **not** guarantee five available replicas during node failure: involuntary disruptions cannot be prevented, although they count against the budget. During a drain using the Eviction API, the PDB restricts voluntary eviction; requests can be rejected and retried until replacement availability permits progress. Direct deletion bypasses that protection. Deployment rolling updates are not constrained by PDBs, although their unavailable Pods count against the budget. Thus, `maxUnavailable: 2` permits rollout availability to fall to four at six desired replicas. Recommend `maxUnavailable: 0`, `maxSurge: 1`, with capacity for the surge; `maxUnavailable: 1` is compatible with a five-replica rollout floor but leaves less margin. Neither prevents simultaneous failures.  
   Sources: `concepts/workloads/pods/disruptions.md:107–135`; `concepts/workloads/controllers/deployment.md:1183–1211`.

2. **Zone distribution.** Configure a selector matching the API Pods, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`. The key groups nodes by their zone-label values. With `DoNotSchedule`, skew limits the difference between the destination domain’s matching-Pod count and the global minimum; violating placements remain unscheduled. `ScheduleAnyway` makes balancing a preference, subject to other scheduling requirements. Six Pods can be balanced 2/2/2, but losing one such zone immediately leaves four.

   Choose strict spreading only with an explicit outage policy: if `minDomains: 3` and fewer than three domains remain eligible, the global minimum becomes zero, potentially blocking replacements in surviving zones. Omission behaves as `minDomains: 1`. Actual behavior depends on domain eligibility and remaining nodes; the scheduler derives domains from existing nodes. Pod removal does not guarantee continued balance.  
   Sources: `concepts/scheduling-eviction/topology-spread-constraints.md:82–129,335–354,606–622`.

3. **Probes for slow startup.** Use a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Until it succeeds, both readiness and liveness probes are disabled. Exhausting startup failures kills the container, subject to its restart policy. Thereafter, use readiness to indicate whether requests can succeed, including required database availability, and liveness to detect an unhealthy application such as a deadlock. Readiness failure removes the Pod from matching Service endpoints without itself restarting the container; liveness failure kills it and invokes restart policy. Avoid making database unavailability alone a liveness failure. Probe thresholds and endpoints are application choices requiring tests.  
   Sources: `concepts/workloads/pods/pod-lifecycle.md:474–500,512–531`; `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311–347`.

4. **Termination and long requests.** The grace-period countdown begins **before** `preStop`; the hook consumes the same shutdown budget. Normally the hook runs before the runtime sends SIGTERM to the main process, although an image’s configured stop signal may be used. A still-running hook can receive a small, one-off two-second extension. Remaining processes receive SIGKILL when grace expires.

   Concurrently, terminating endpoints remain temporarily in EndpointSlices with `ready: false`, excluding regular traffic; `serving` can support draining-aware consumers. This is not a guarantee that existing requests finish. Thirty seconds is a default, not a request-completion promise. Implement signal handling and draining, then size grace for hook execution and measured request completion.  
   Sources: `reference/kubernetes-api/workload-resources/pod-v1.md:1006–1008`; `concepts/workloads/pods/pod-lifecycle.md:559–642`.

5. **Resource requests, limits, and HPA.** CPU requests influence scheduling capacity checks and, typically on Linux, CPU allocation under contention. They are not ceilings: containers may consume spare capacity. CPU limits enforce a ceiling through throttling; memory limits are enforced reactively through OOM kills, not CPU-style throttling. Set requests and limits from observed workload behavior, including startup and long-request peaks.

   CPU-utilization HPA divides usage by requests. If relevant requests are missing from some containers, Pod utilization is undefined and the autoscaler takes no action for that metric. Inspect effective requests: absent admission defaults, specifying a limit without a request copies the limit into the request.  
   Sources: `concepts/configuration/manage-resources-containers.md:27–67,230–262`; `tasks/run-application/horizontal-pod-autoscale.md:89–102`.

6. **HPA’s conservative adjustments.** The basic recommendation is the ceiling of current replicas multiplied by current/desired metric value, but that is only the starting point. Terminating and failed Pods are excluded; missing metrics and qualifying not-yet-ready CPU Pods are set aside. Missing metrics are conservatively treated as 100% of target during downscale and 0% during upscale. Not-yet-ready Pods can further dampen upscale using a 0% assumption. A revised ratio that reverses direction or falls within tolerance produces no scaling action.

   Defaults include 10% tolerance, a 30-second initial-readiness delay, and a five-minute CPU initialization period. Downscale stabilization selects the highest recommendation within the default five-minute window. Therefore, displayed average utilization need not explain the eventual scaling decision.  
   Sources: `tasks/run-application/horizontal-pod-autoscale.md:129–218`.

7. **Least-privilege networking.** Select API and database Pods with policies isolating both ingress and egress. Explicitly allow approved callers into the API, API-to-database traffic on required ports, and necessary infrastructure dependencies. DNS egress must reach the resolvers actually configured for these Pods; determine their destinations and required protocols during cluster validation.

   Ingress and egress isolation are independent. Policies are additive unions, so an existing broad allow cannot be overridden by adding a restrictive policy. Both source egress and destination ingress must permit a Pod-to-Pod connection; replies to allowed connections are implicitly allowed. NetworkPolicy enforcement requires a supporting network plugin—creating objects alone has no effect.  
   Sources: `concepts/services-networking/network-policies.md:45–81,120–137`; `concepts/services-networking/dns-pod-service.md:294–317`.

8. **Secrets.** Reject base64-encoded credentials in Git as protection. The docs explicitly describe base64 credentials as “obscured but not secret.” Enable encryption at rest for Secrets: the underlying etcd store is unencrypted by default. Apply least-privilege RBAC, limit which containers receive credentials, and separate trust boundaries with namespaces.

   Restricting direct Secret reads is insufficient. Permission to create Pods—or Deployments—in a namespace enables access to that namespace’s Secrets through workloads. Review workload-creation permissions and service-account privileges alongside Secret permissions. Encryption at rest does not protect a credential copied into a repository; use a separately controlled delivery mechanism.  
   Sources: `concepts/configuration/secret.md:34–49,306`; `concepts/security/rbac-good-practices.md:100–120`.

9. **Storage lifecycle.** Dynamically provisioned PVs inherit their StorageClass reclaim policy, defaulting to `Delete`. Changing the class is not a retroactive protection mechanism for existing PVs: inspect and edit those PVs’ policies individually. With supported plugins, `Delete` removes both the PV and external storage asset after reclamation. `Retain` leaves the volume released after PVC deletion, requiring manual reclamation.

   PVC deletion is distinct from StatefulSet deletion or scaling. StatefulSet template PVCs default to retention; configurable `whenDeleted` and `whenScaled` policies can instead delete affected claims. The documented retention-policy mechanism requires `StatefulSetAutoDeletePVC` enabled on the API server and controller manager. Choose retention deliberately for database data; dynamic provisioning itself establishes neither backup nor recovery guarantees.  
   Sources: `concepts/storage/persistent-volumes.md:179–210`; `concepts/storage/storage-classes.md:126–135`; `concepts/workloads/controllers/statefulset.md:391–423`.

10. **Prioritized rollout and validation checklist.**

   - **Before deployment:** replace repository credentials, verify encryption/RBAC and actual CNI enforcement, and inspect existing PV reclaim policies. These protect confidentiality and data retention.
   - **Before rollout:** configure probes, measured shutdown grace, surge capacity, zone spreading, and compatible rollout settings. Keep an HPA minimum consistent with the six-replica baseline; do not treat the PDB as a scaling floor.
   - **Before production acceptance:** test drains, rolling updates, zone loss, cold starts, long-request termination, missing metrics, denied network paths, DNS, and database recovery.

   Acceptance must establish at least four limits absent from these guarantees: startup duration, request-drain completion time, surviving-zone capacity, and database recovery/data integrity. Also verify the resource metrics API, normally supplied by a separately deployed Metrics Server.  
   Sources: `concepts/workloads/pods/disruptions.md:107–135`; `concepts/workloads/pods/pod-lifecycle.md:612–639`; `concepts/scheduling-eviction/topology-spread-constraints.md:606–622`; `tasks/run-application/horizontal-pod-autoscale.md:112–117`; storage sources in answer 9.