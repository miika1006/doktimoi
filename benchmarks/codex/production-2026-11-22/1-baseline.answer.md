**Decision memo — revise before production approval**

The proposed design does not establish five-replica availability, safe request draining, credential confidentiality, or database durability. Approve deployment only after the configuration changes and validation below. All references are to the supplied Kubernetes v1.32 corpus; recommendations are configuration choices, not additional Kubernetes guarantees.

1. **PDB protection differs by disruption.** During **node failure**, `minAvailable: 5` cannot prevent replica loss; involuntary disruptions count against the budget but are not prevented. During **node drain**, an Eviction API–respecting tool constrains voluntary evictions: with six healthy replicas, one can be evicted before replacements become healthy. Drain can block or time out; direct deletion bypasses this protection. During a **Deployment update**, the controller is not constrained by the PDB. Proposed `maxUnavailable: 2` permits an update availability floor of four at six desired replicas.

   Keep the PDB and choose `maxUnavailable: 1, maxSurge: 1`, or preferably `maxUnavailable: 0, maxSurge: 1` with sufficient capacity. These govern rollout behavior; concurrent failures remain possible.  
   Sources: `docs/concepts/workloads/pods/disruptions.md:99–136`; `docs/concepts/workloads/controllers/deployment.md:1185–1211`.

2. **Spread by zone, with an explicit recovery tradeoff.** Configure a workload-matching selector, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`; six replicas can then distribute 2/2/2. `topologyKey` identifies domains through node-label values. With `DoNotSchedule`, skew limits the target domain’s count relative to the global minimum; violating placements remain pending. `ScheduleAnyway` instead prefers placements reducing skew without enforcing that bound.

   Zone unavailability does not have one unconditional outcome: eligible-domain calculation and remaining capacity matter. With `minDomains: 3`, fewer than three eligible domains makes the global minimum zero, potentially blocking replacements in surviving zones. Omitting it defaults to one, permitting balancing across remaining eligible domains. Choose that recovery flexibility deliberately. Verify labels and taint handling; topology constraints do not guarantee continued balance after removals. Losing a zone containing two replicas initially leaves four, regardless of the PDB.  
   Sources: `docs/concepts/scheduling-eviction/topology-spread-constraints.md:82–126,179–185,480–488,605–619`.

3. **Separate startup, traffic eligibility, and recovery.** Use a startup probe with a failure budget sized from measured worst-case initialization. Until it succeeds, readiness and liveness probes are disabled. Startup failure beyond its configured threshold kills the container, subject to restart policy.

   Readiness should test ability to serve requests, including required database availability where appropriate. Failure removes the Pod from matching Service endpoints; readiness failure alone does not restart it. Liveness should detect an unhealthy application requiring restart, rather than merely duplicate database dependency checks. Liveness failure kills the container, again subject to restart policy. This avoids treating ordinary slow startup as a recurring liveness failure.  
   Sources: `docs/concepts/workloads/pods/pod-lifecycle.md:479–497,512–527,544–557`.

4. **Thirty seconds is a deadline, not a completion guarantee.** The termination grace countdown starts **before** `preStop`. The kubelet runs the hook, then requests TERM delivery to container process 1. A still-running hook can receive a one-off two-second extension; it does not receive a separate full grace period. Remaining processes receive SIGKILL when grace expires.

   Concurrently, Service endpoint handling progresses: terminating EndpointSlice entries are not immediately removed, but have `ready: false` for regular traffic; `serving` supports draining-aware consumers. Configure application shutdown to stop accepting work and finish existing requests, and size grace for hook time plus draining. The documents establish neither instantaneous propagation through this production traffic path nor completion of arbitrarily long requests.  
   Sources: `docs/reference/kubernetes-api/workload-resources/pod-v1.md:1006–1008`; `docs/concepts/workloads/pods/pod-lifecycle.md:591–639`.

5. **Resource settings are necessary inputs, not performance assurances.** CPU requests inform scheduling and the utilization denominator; containers may exceed requests when resources permit. CPU limits enforce throttling. Memory limits instead produce reactive OOM enforcement: excess allocation can cause termination rather than CPU-style throttling.

   Set explicit, measured CPU requests for every relevant container. Without relevant requests on some containers, Pod CPU utilization is undefined and HPA does not act for that metric. Inspect admitted configuration: an omitted request can be copied from a specified limit if admission has not supplied another default. Choose limits through load testing, including startup and long-request workloads.  
   Sources: `docs/concepts/configuration/manage-resources-containers.md:18–23,27–66`; `docs/tasks/run-application/horizontal-pod-autoscale.md:89–102`.

6. **HPA deliberately departs from the raw ratio.** Its baseline is the ceiling of current replicas multiplied by current/target metric value. Missing metrics are set aside, then conservatively assumed at 100% of target for downscale and 0% for upscale. CPU metrics for not-yet-ready Pods are also set aside; during prospective upscale, these Pods are assumed at 0%, dampening expansion.

   Default readiness-delay and CPU-initialization windows are 30 seconds and five minutes. Recalculation can cancel scaling if direction reverses or falls within tolerance, default 10%. Downscale stabilization selects the highest recommendation over the preceding five minutes by default. Reported average utilization excludes these conservative adjustments, so status alone may not explain the replica decision.  
   Sources: `docs/tasks/run-application/horizontal-pod-autoscale.md:130–202,213–218`.

7. **Require enforced least-privilege networking.** Establish default-deny ingress and egress, then allow approved callers to the API port, API-to-database traffic on its required port, and necessary DNS queries. Select the actual DNS destination using cluster-specific configuration.

   Ingress and egress isolation are independent. Policies combine additively: their allowed traffic is a union, so an existing broad allow defeats narrower intentions. Pod-to-Pod connections require both source egress and destination ingress permission; replies to allowed connections are implicitly permitted. Confirm the CNI implements NetworkPolicy—creating objects without enforcement has no effect. Validate Service/address rewriting because policy behavior around rewritten IPs varies.  
   Sources: `docs/concepts/services-networking/network-policies.md:45–81,193–206,254–262`; `docs/concepts/security/multi-tenancy.md:215–220`.

8. **Reject base64 Secrets in Git as protection.** Base64 is reversible: the documentation demonstrates decoding and explicitly describes encoded credentials as obscured, not secret. Remove exposed credentials from the repository and rotate them as a security decision.

   Enable Secret encryption at rest; the documented default is unencrypted etcd storage. Apply least-privilege RBAC and restrict container access. Restrict workload creation too: someone authorized to create Pods—or indirectly Deployments—in a namespace can read its Secrets through workloads. Denying direct Secret reads alone therefore does not establish confidentiality. Encryption at rest also does not protect a readable Git copy.  
   Sources: `docs/concepts/configuration/secret.md:36–48,282–286,305–307`.

9. **Treat PVC retention and PV reclamation separately.** Dynamically provisioned PVs inherit their StorageClass reclaim policy, defaulting to `Delete`. Changing the class is not a retroactive repair: inspect and explicitly patch existing PVs requiring another policy.

   After PVC deletion, `Retain` leaves the PV released with its data, requiring manual reclamation. For supporting plugins, `Delete` removes both PV and backing storage. StatefulSet deletion or downscaling retains template PVCs by default. Optional `whenDeleted` and `whenScaled: Delete` policies cause corresponding PVC deletion, after which PV reclamation applies. Verify the documented feature-gate prerequisites before using those fields.  
   Sources: `docs/concepts/storage/storage-classes.md:126–135`; `docs/concepts/storage/persistent-volumes.md:178–210`; `docs/concepts/workloads/controllers/statefulset.md:391–423`.

10. **Prioritize validation before exposure.** First secure credentials and verify existing PV reclaim policies and intended StatefulSet PVC retention. Next prove CNI enforcement, deploy explicit allows with isolation, and test DNS and database connectivity. Then configure probes, measured resources, compatible rollout settings, zone placement, and application draining.

    Finally rehearse rollout, eviction-based drain, zone loss, database interruption, and HPA metric loss under representative load. Validate at least these unresolved limits: **five replicas’ peak-load capacity; startup and shutdown duration; actual traffic-drain propagation; database/storage recovery across zones**. Also verify resource metrics availability—Metrics Server is a separate add-on—and capacity for surge Pods. These checks follow the documented scheduling, disruption, and termination constraints; none establishes application-level safety by field presence alone.  
    Sources: `docs/concepts/configuration/manage-resources-containers.md:230–241`; `docs/tasks/run-application/horizontal-pod-autoscale.md:115–118`; `docs/concepts/workloads/pods/disruptions.md:130–136`; `docs/concepts/workloads/pods/pod-lifecycle.md:612–639`.