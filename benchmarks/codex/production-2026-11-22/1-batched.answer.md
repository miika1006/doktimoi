**Decision memo — revise before production approval**

The proposed settings do not establish five-replica availability or safe completion of long requests. Approval should depend on coordinated rollout, scheduling, shutdown, security, and storage settings, followed by application and cluster testing. References below are local paths within the supplied `docs/` corpus.

1. **PDB protection differs across the three cases.** Node failure is involuntary: a PDB cannot prevent it, although unavailable Pods count against the budget. During an eviction-based node drain, `minAvailable: 5` permits one disruption from six healthy replicas; further evictions can block until replacements recover. This requires tools that honor the Eviction API. A Deployment rolling update is not constrained by the PDB, although its unavailable Pods consume the budget. Consequently, `maxUnavailable: 2` permits a rollout floor of four. Recommend `maxUnavailable: 0`, `maxSurge: 1`, with capacity for the surge; `maxUnavailable: 1` also aligns with a five-replica rollout floor. Neither configuration protects against concurrent failures.

   Sources: `docs/concepts/workloads/pods/disruptions.md:99–136`; `docs/concepts/workloads/controllers/deployment.md:1189–1211`.

2. **Spread by zone, with an explicit outage tradeoff.** Configure a matching Pod selector, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`; validate node labels. The topology key groups equally labeled nodes into domains. Under `DoNotSchedule`, skew limits the target domain’s matching-Pod count relative to the global minimum; violating placements remain pending. Under `ScheduleAnyway`, reducing skew is a preference, allowing placement despite imbalance.

   Prefer hard spreading if balanced placement outweighs replacement capacity during zone loss; choose soft spreading if scheduling into surviving zones takes priority. Unavailable-zone behavior depends on eligible domains, affinity, taints, and remaining nodes. With hard spreading and `minDomains: 3`, fewer than three eligible domains makes the global minimum zero, potentially blocking replacements. Omitting it defaults to one. Six evenly placed replicas imply two per zone, so losing one immediately leaves four. Spread constraints also do not guarantee balance after removals.

   Sources: `docs/concepts/scheduling-eviction/topology-spread-constraints.md:82–130,527–529,605–623`.

3. **Separate startup, traffic eligibility, and restart decisions.** Use a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Other probes remain disabled until startup succeeds; their initial-delay clocks then begin. Use readiness to report whether the API can serve requests, including required database availability where appropriate. Failed readiness removes the Pod from matching Service endpoints without restarting its container. Use liveness for conditions where restarting helps, such as deadlock; avoid treating a temporary database outage as proof the API process needs restarting. Consecutive startup or liveness failures reaching the threshold trigger container restart behavior. Probe endpoints and timings are application choices requiring validation.

   Sources: `docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311–347,398–422`; `docs/concepts/workloads/pods/pod-lifecycle.md:479–497,524–528`.

4. **Thirty seconds is a shutdown budget, not a completion guarantee.** The grace-period countdown begins before `preStop`, so the hook consumes that budget. The kubelet runs the hook before requesting TERM delivery to container processes. An overrunning hook can receive a small, one-off two-second extension; remaining processes are forcibly killed with `SIGKILL` when shutdown expires.

   Endpoint processing happens concurrently with local shutdown. Terminating endpoints remain temporarily in EndpointSlices, marked terminating with `ready: false`, excluding them from regular traffic; `serving` supports draining-aware consumers. These mechanisms do not establish that every long request completes. Implement application draining and signal handling, then size grace time for hook execution, outstanding requests, and cleanup.

   Sources: `docs/reference/kubernetes-api/workload-resources/pod-v1.md:1006–1008`; `docs/concepts/workloads/pods/pod-lifecycle.md:581–639`.

5. **Resource requests and limits serve different purposes.** CPU requests inform scheduling and typically determine CPU weighting under contention; they are not a usage ceiling. Containers can exceed requests when resources are available. CPU limits impose throttling, potentially lengthening requests. Memory limits are enforced reactively through OOM handling and can terminate processes; they are not CPU-style throttling.

   Set measured CPU requests for all relevant containers because utilization-based HPA divides usage by requests. Missing relevant requests leave Pod CPU utilization undefined, preventing action for that metric. Inspect admitted Pods: when a limit exists without a request or admission default, Kubernetes copies the limit into the request.

   Sources: `docs/concepts/configuration/manage-resources-containers.md:18–53,63–66,252–265`; `docs/tasks/run-application/horizontal-pod-autoscale.md:89–102`.

6. **HPA deliberately moderates the raw ratio.** The basic calculation is the rounded-up current replica count multiplied by current/desired metric value. However, terminating and failed Pods are excluded; missing metrics and certain not-yet-ready CPU samples are set aside. Missing metrics are conservatively assumed at 100% of target for downscaling and 0% for upscaling. Not-yet-ready Pods further dampen an otherwise indicated scale-up through a 0% assumption.

   If recalculation reverses direction or falls within tolerance, scaling stops. Default tolerance is 0.1; readiness-related defaults include a 30-second initial-readiness delay and five-minute CPU initialization period. Downscale stabilization defaults to five minutes, selecting the highest recommendation within that window. Therefore observed utilization, HPA status, and actual scaling can differ. Resource metrics availability is a prerequisite.

   Sources: `docs/tasks/run-application/horizontal-pod-autoscale.md:113–118,130–218`.

7. **Replace default allow with explicit communication paths.** Establish namespace-wide ingress and egress isolation, then allow approved callers to the API port, API egress to database destinations and ports, matching database ingress, and necessary DNS queries. Identify actual resolver destinations and required ports in this cluster.

   Ingress and egress isolation are independent. Policies are additive unions: an overly broad allow remains effective despite another restrictive policy. For Pod-to-Pod connections, source egress and destination ingress must both permit traffic; replies to allowed connections are implicitly allowed. Enforcement requires a supporting network plugin/CNI: creating policy objects alone can have no effect. Test allowed and denied paths before promotion.

   Sources: `docs/concepts/services-networking/network-policies.md:45–81,105–122`; `docs/concepts/security/multi-tenancy.md:215–220`.

8. **Base64 is insufficient protection for Git-held Secrets.** The documentation describes base64 values as obscured, not secret; encoding satisfies the API representation requirement. Remove usable credentials from Git and select a protected delivery mechanism. Kubernetes Secrets are stored unencrypted in etcd by default, so enable encryption at rest and least-privilege RBAC, restricting access to necessary containers.

   Restrict workload creation permissions as well as direct Secret reads: someone authorized to create Pods in a namespace can read its Secrets through those Pods, including indirectly through Deployment creation. Encryption at rest does not resolve repository exposure or authorized API access.

   Sources: `docs/concepts/configuration/secret.md:35–48,306,453–457`.

9. **Treat PV reclamation and StatefulSet PVC retention separately.** Dynamically provisioned PVs inherit the StorageClass reclaim policy, defaulting to `Delete`. Changing the class is not a retroactive migration of existing PV policies; inspect and explicitly patch existing PVs. With `Retain`, deleting a PVC leaves a released PV containing previous data and requiring manual reclamation. With supported `Delete` behavior, reclamation removes both the PV and backing storage asset.

   StatefulSet deletion or scaling normally retains template PVCs. Its optional retention policy independently controls `whenDeleted` and `whenScaled`; `Delete` removes affected PVCs after Pods disappear, then PV reclamation determines storage disposal. The supplied documentation specifies the feature-gate prerequisite. Dynamic provisioning alone establishes no database durability or recovery guarantee.

   Sources: `docs/concepts/storage/persistent-volumes.md:178–210`; `docs/concepts/storage/storage-classes.md:126–135`; `docs/concepts/workloads/controllers/statefulset.md:387–423`.

10. **Prioritize rollout and validation as follows.**

   - **Before deployment:** remove exposed credentials, verify encryption and authorization, inspect actual PV reclaim and PVC retention policies, and test network isolation.
   - **Before enabling automatic changes:** measure startup and shutdown, configure probes and grace time, establish requests and limits, and verify resource metrics.
   - **Before production rollout:** validate zone labels and outage scheduling, reserve surge capacity, apply compatible rollout settings, and set an HPA minimum consistent with the intended six-replica baseline.
   - **Exercise failure paths:** test drains, failed rollouts, zone loss, missing metrics, database unavailability, long-request termination, and storage recovery.

   At least four limits remain empirical: request completion during shutdown, CPU utilization’s relationship to API latency, surviving-zone capacity, and database recovery/durability. The documents explain controls without establishing these outcomes. Topology-constrained storage also needs driver validation; supported `WaitForFirstConsumer` provisioning can account for Pod scheduling constraints.

   Sources: `docs/reference/kubernetes-api/workload-resources/horizontal-pod-autoscaler-v2.md:86–99`; `docs/concepts/storage/storage-classes.md:171–199`; validation follows the documented boundaries cited in answers 1–9.