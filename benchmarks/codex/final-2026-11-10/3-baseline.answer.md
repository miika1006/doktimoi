**Decision memo: revise before production approval.** The proposed fields provide useful controls, but do not guarantee five serving replicas, completed requests, or database durability. Citations below refer to local paths relative to the supplied corpus’s parent directory.

1. **PDB and rollout availability.** `minAvailable: 5` cannot guarantee five replicas during node failure: involuntary disruptions cannot be prevented, although they consume the budget. During a drain using the Eviction API, the PDB restricts permitted evictions; with six healthy replicas, one can be disrupted before replacement readiness is required. Direct deletion bypasses that protection. Deployment rolling updates are not constrained by PDBs, so `maxUnavailable: 2` permits rollout availability to fall to four.

   Keep the PDB and choose `maxUnavailable: 1, maxSurge: 1`; alternatively, choose zero unavailable with one surge for greater rollout conservatism. Reserve surge capacity. These control rollout behavior, not simultaneous infrastructure failures.  
   Sources: `docs/concepts/workloads/pods/disruptions.md:99–135`; `docs/concepts/workloads/controllers/deployment.md:1188–1211`.

2. **Zone placement.** Configure a selector matching the API Pods, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`, targeting two replicas per zone. The key identifies node-label domains. With `DoNotSchedule`, skew limits the difference between the target domain’s matching-Pod count and the global minimum; violating placements remain pending. `ScheduleAnyway` instead prefers lower skew without enforcing that bound.

   Choose deliberately between strict distribution and replacement capacity during an outage. If an unavailable zone remains eligible, strict skew can block replacements elsewhere. If it ceases to be eligible, `minDomains` matters: setting three makes the global minimum zero when fewer than three eligible domains remain, potentially blocking further placements. Omitting it behaves as one. Soft spreading permits greater imbalance but cannot guarantee capacity. Losing a two-Pod zone initially leaves four replicas; spreading does not preserve five. Nor is balance guaranteed after removals.  
   Sources: `docs/concepts/scheduling-eviction/topology-spread-constraints.md:82–130,607–619`.

3. **Slow-start probes.** Use a startup probe with `failureThreshold × periodSeconds` covering measured worst-case initialization. Until it succeeds, readiness and liveness probes are disabled. Afterward, use readiness to indicate ability to accept requests and liveness to detect a condition for which restarting is useful, such as deadlock. Avoid making a transient database outage automatically imply that restarting the API helps.

   Readiness failure removes the Pod from matching Service endpoints without restarting its container. Startup or liveness failure at the configured threshold triggers container termination and restart handling under its restart policy. Endpoint withdrawal is the documented traffic-selection mechanism, not a guarantee that existing requests finish.  
   Sources: `docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311–347,412–422`; `docs/concepts/workloads/pods/pod-lifecycle.md:479–497`.

4. **Termination and long requests.** The grace-period countdown begins **before** `preStop`, so hook execution consumes the shutdown budget. The hook precedes the runtime’s TERM signal to container process 1. A still-running hook can receive a one-off two-second extension; remaining processes ultimately receive SIGKILL.

   Endpoint processing happens concurrently with local shutdown. Terminating endpoints are not immediately removed from EndpointSlices, but have `ready: false`; `serving` supports consumers implementing draining. Thirty seconds is a default deadline, not a request-completion guarantee. Measure hook duration, maximum supported request duration, application signal handling, and traffic-draining behavior, then configure sufficient grace and explicit application shutdown logic.  
   Sources: `docs/reference/kubernetes-api/workload-resources/pod-v1.md:1008`; `docs/concepts/workloads/pods/pod-lifecycle.md:591–639`.

5. **Resource sizing and CPU HPA.** CPU requests inform scheduling and provide the denominator for utilization-based HPA; they are not CPU consumption ceilings. Containers can use resources above requests when available. CPU limits enforce throttling, whereas memory limits are enforced reactively through OOM killing rather than CPU-style throttling.

   Set measured CPU requests for every relevant container and memory requests/limits appropriate to startup and concurrency. Benchmark CPU limits against long-request latency. If some containers lack the relevant request, Pod CPU utilization is undefined and HPA takes no action for that metric. Inspect effective configuration: when a limit exists without a request or admission default, Kubernetes copies the limit into the request.  
   Sources: `docs/concepts/configuration/manage-resources-containers.md:18–53,64–66`; `docs/tasks/run-application/horizontal-pod-autoscale.md:89–102`.

6. **HPA’s conservative adjustments.** The raw calculation is the ceiling of current replicas multiplied by current/target metric. HPA sets aside missing metrics and certain not-yet-ready CPU samples. Missing samples are conservatively treated as 100% of target for downscaling and zero for upscaling; not-yet-ready Pods are also treated as zero when damping scale-up.

   If recalculation reverses direction or enters tolerance, no scaling occurs. Defaults include a 30-second initial readiness delay, five-minute CPU initialization period, and 10% tolerance. Downscale stabilization defaults to five minutes, selecting the highest recommendation in that window. Thus scaling can differ from the raw ratio, while status still reports the original average utilization. Verify actual controller settings and metric delivery.  
   Source: `docs/tasks/run-application/horizontal-pod-autoscale.md:129–218`.

7. **Least-privilege networking.** Establish default-deny ingress and egress, then allow approved callers to the API port, API egress to the database port, and corresponding database ingress. Allow necessary DNS traffic to the actual cluster resolver; the documented DNS Service example exposes UDP and TCP 53. Add other dependencies only after identifying them.

   Ingress and egress isolation are independent. Policies combine additively: a broad allow policy defeats the intended restriction even alongside default-deny. Both source egress and destination ingress must permit a connection; reply traffic is implicitly allowed. A NetworkPolicy-capable CNI/controller is a prerequisite—creating policy objects without enforcement has no effect. Node-originated ingress is also a documented exception to isolation.  
   Sources: `docs/concepts/services-networking/network-policies.md:45–81,210–259`; `docs/tasks/administer-cluster/dns-debugging-resolution.md:158–168`.

8. **Secrets.** Reject base64-encoded credentials in Git as a protection mechanism: the documentation explicitly describes base64 credentials as obscured, not secret. Kubernetes Secrets are also stored unencrypted in etcd by default. Enable encryption at rest, configure least-privilege Secret RBAC, and restrict exposure to containers that need credentials.

   Restrict workload-creation privileges too: permission to create a Pod in a namespace—including indirectly through a Deployment—can be used to read any Secret there. Denying direct Secret reads alone is therefore insufficient. Encryption at rest protects datastore representation; it does not make a committed base64 value confidential.  
   Source: `docs/concepts/configuration/secret.md:35–48,306`.

9. **Storage lifecycle.** Changing a StorageClass reclaim setting does not retroactively change existing PV policies. Dynamically provisioned PVs inherit their policy; existing PVs requiring correction must be edited or patched individually. The default is `Delete`.

   `Retain` leaves the released PV and its data for manual reclamation. With a supporting plugin, `Delete` removes both the PV object and backing storage. PVC deletion initiates reclamation, although deletion is postponed while a Pod uses the claim. StatefulSet deletion/scaling is separate: PVC retention defaults to `Retain`; explicit `whenDeleted`/`whenScaled: Delete` can delete template-created PVCs after affected Pods terminate, subject to the documented feature prerequisites. Retention is not a backup.  
   Sources: `docs/concepts/storage/storage-classes.md:126–135`; `docs/concepts/storage/persistent-volumes.md:123–136,178–210`; `docs/concepts/workloads/controllers/statefulset.md:391–423`.

10. **Prioritized rollout and validation checklist.**

   - **First, protect credentials and data:** remove exposed credentials from the proposed Git workflow, establish Secret controls, inspect existing PV policies, and validate database recovery.
   - **Next, establish prerequisites:** verify NetworkPolicy enforcement, metrics availability, zone labels, surge capacity, and storage topology compatibility. For topology-constrained storage, assess `WaitForFirstConsumer` and driver support.
   - **Then, stage configuration:** deploy probes, measured resources, compatible rollout settings, spreading, explicit network allows, and tested shutdown handling.
   - **Finally, exercise failures:** test drains, rolling updates, zone loss, missing metrics, database unavailability, long-request termination, and storage recovery before promotion.

   Unproven limits include application shutdown correctness, sufficient surviving-zone capacity, database failover/recovery, and actual CNI enforcement. The documents define mechanisms, not this application’s latency, durability, or recovery objectives.  
   Sources: `docs/concepts/workloads/pods/disruptions.md:108–135`; `docs/concepts/workloads/pods/pod-lifecycle.md:619–639`; `docs/concepts/services-networking/network-policies.md:45–49`; `docs/concepts/storage/storage-classes.md:171–195`.