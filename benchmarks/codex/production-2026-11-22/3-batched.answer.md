Decision: revise the design before production approval. Kubernetes supplies useful controls, but the proposed settings do not establish five available replicas, completed long requests, enforced network isolation, or database durability. The recommendations below distinguish documented behavior from configuration choices and validation requirements. All paths are relative to the supplied corpus root.

1. **The PDB does not guarantee five replicas in all three cases.** During node failure, involuntary disruption cannot be prevented; losing a zone containing two replicas would leave four. During node drain, an Eviction API client respects `minAvailable: 5`, rejecting further budget-breaking evictions until availability recovers; direct deletion bypasses that protection. During Deployment updates, unavailable Pods count against the budget, but the Deployment is not constrained by the PDB. Thus, `maxUnavailable: 2` permits rollout availability to fall to four. Recommend `maxUnavailable: 0`, `maxSurge: 1`, with capacity for the extra Pod, or at minimum `maxUnavailable: 1`. These govern rollout behavior, not simultaneous infrastructure failures.

   Sources: `docs/concepts/workloads/pods/disruptions.md:99–136`; `docs/concepts/workloads/controllers/deployment.md:1189–1209`.

2. **Configure zone spreading explicitly.** Use an API label selector, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`, aiming for two replicas per zone. `topologyKey` groups nodes by matching label values. With `DoNotSchedule`, skew is the permitted difference between the target domain’s matching-Pod count and the global minimum; an incoming Pod violating it remains unscheduled. `ScheduleAnyway` instead prefers placements reducing skew without enforcing the bound.

   Choose the outage tradeoff deliberately: strict spreading can block replacements when a failed zone remains counted. If only two eligible domains remain, omitted `minDomains` behaves as one and permits balancing across those domains; setting `minDomains: 3` makes the global minimum zero and can block additional placements. Eligibility depends on affinity and taint policies. Spreading neither guarantees healthy replicas nor automatically preserves balance after removals.

   Sources: `docs/concepts/scheduling-eviction/topology-spread-constraints.md:82–130, 527–529, 605–619`.

3. **Use separate probes for separate decisions.** Configure a startup probe whose `failureThreshold × periodSeconds` accommodates measured worst-case initialization. Until it succeeds, readiness and liveness probes—and their initial delays—do not begin. Use readiness to indicate whether this instance can serve requests, including required database access where appropriate. Readiness failure removes the Pod from matching Service endpoints without restarting its container. Use liveness for conditions a restart can repair, such as deadlock; avoid making database unavailability itself a restart trigger. Startup or liveness failure at the configured threshold triggers container shutdown and restart according to restart policy. Probe endpoints and thresholds remain application choices.

   Sources: `docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311–318, 342–358, 398–422`; `docs/concepts/workloads/pods/pod-lifecycle.md:479–497`.

4. **Thirty seconds is a deadline, not a request-completion guarantee.** The termination clock starts before `preStop`; the hook consumes part of the same budget. The kubelet runs the hook before requesting TERM delivery to the container’s main process. An overrunning hook can receive a one-off two-second extension. At grace expiry, remaining processes receive SIGKILL.

   Endpoint processing occurs concurrently with local shutdown. Terminating EndpointSlice entries are not immediately removed, but have `ready: false`, excluding them from regular traffic; `serving` supports drain-aware consumers. Configure application signal handling and draining, then size the grace period from measured hook duration, request duration, and traffic convergence. The docs do not guarantee that existing requests finish within thirty seconds.

   Sources: `docs/reference/kubernetes-api/workload-resources/pod-v1.md:1006–1008`; `docs/concepts/workloads/pods/pod-lifecycle.md:591–639`.

5. **Set resource requests and limits from measurements.** Requests determine scheduling capacity checks; CPU requests also typically determine relative CPU weighting under contention. They are not CPU ceilings. CPU limits impose ceilings through throttling, potentially delaying long requests. Memory limits use reactive OOM enforcement: exceeding a limit may lead to termination when pressure is detected, rather than immediate enforcement like CPU throttling.

   CPU utilization-based HPA calculates usage relative to requests. If relevant requests are absent from some containers, Pod CPU utilization is undefined and HPA cannot act on that metric. Set appropriate CPU requests for every relevant container and validate the resulting utilization target.

   Sources: `docs/concepts/configuration/manage-resources-containers.md:18–51, 230–265`; `docs/tasks/run-application/horizontal-pod-autoscale.md:89–101`.

6. **Expect conservative HPA decisions.** The starting calculation is the ceiling of current replicas multiplied by current-to-target metric ratio, with a default 10% tolerance. Missing metrics are initially set aside, then assumed to equal 100% of target for downscaling or zero for upscaling, damping changes. CPU metrics for not-yet-ready Pods are also set aside; during prospective upscaling those Pods are conservatively assigned zero usage. A revised ratio that reverses direction or enters tolerance causes no scaling.

   Default readiness-delay and CPU-initialization windows are thirty seconds and five minutes. Downscale stabilization defaults to five minutes and selects the highest recommendation in that window. Consequently, reported utilization and the raw ratio need not match the eventual scaling action.

   Source: `docs/tasks/run-application/horizontal-pod-autoscale.md:132–216`.

7. **Replace default allow with explicit ingress and egress isolation.** Start with policies selecting all relevant Pods and denying both directions, then allow approved callers to the API port, API egress to the database port, and corresponding database ingress. Add only other required dependencies, including DNS. Allow DNS to the actual cluster resolver; the documented kube-dns example exposes both UDP and TCP port 53.

   Isolation is independent per direction. Policies are additive unions, so an existing broad allow must be removed or narrowed. Both source egress and destination ingress must permit a Pod-to-Pod connection; replies to allowed connections are implicitly permitted. A NetworkPolicy object provides no enforcement without a supporting network plugin. Validate the installed CNI and actual resolver path.

   Sources: `docs/concepts/services-networking/network-policies.md:45–81, 254–262`; `docs/tasks/administer-cluster/dns-debugging-resolution.md:158–168`.

8. **Base64 is insufficient protection.** Secret `data` uses base64 as serialization; the documentation explicitly describes encoded credentials as “obscured but not secret.” Do not approve base64 credentials in Git as a security measure. Enable API-storage encryption at rest, restrict Secret access to necessary containers, and apply least-privilege RBAC. Restrict `get`, `list`, and `watch`: all can disclose contents.

   Pod-creation permissions also matter. Someone allowed to create Pods—or Deployments—in a namespace can use that ability to read its Secrets. Restrict workload creation alongside direct Secret access. Encryption at rest addresses API storage, not copies committed to Git.

   Sources: `docs/reference/kubernetes-api/config-and-storage-resources/secret-v1.md:45–47`; `docs/concepts/configuration/secret.md:35–47, 306`; `docs/concepts/security/rbac-good-practices.md:93–108`.

9. **Audit existing PVs independently of the StorageClass.** Dynamically provisioned PVs inherit their class’s reclaim policy at creation; the default is `Delete`. Changing the class does not retroactively change existing PV policies: edit or patch those PVs separately.

   After PVC deletion, `Retain` leaves the PV released with data requiring manual reclamation. With a supporting plugin, `Delete` removes both PV and backing storage. StatefulSet deletion or scaling normally retains PVCs. Optional `persistentVolumeClaimRetentionPolicy` can separately configure deletion through `whenDeleted` and `whenScaled`, subject to the documented feature-gate prerequisite. PVC retention and PV reclamation are distinct decisions. Recommend explicit retention for production database data.

   Sources: `docs/concepts/storage/storage-classes.md:126–135`; `docs/concepts/storage/persistent-volumes.md:178–210`; `docs/concepts/workloads/controllers/statefulset.md:391–423`.

10. **Prioritize validation before broad rollout.**

   - First, secure credentials and workload permissions; confirm network enforcement and storage retention.
   - Next, establish resource requests, probes, draining, compatible rollout settings, and zone placement.
   - Configure HPA `minReplicas: 6` if six is the intended operating floor; verify resource metrics availability.
   - Finally, test slow startup, database outage, missing metrics, long-request termination, node drain, zone loss, rolling updates, and disposable PVC deletion.

   Release evidence must establish at least these limits: actual startup duration; request completion and signal handling; surviving-zone and surge capacity; CNI/DNS behavior; and database recovery, backups, and storage accessibility. The documented mechanisms do not establish those application or cluster properties.

   Sources: `docs/concepts/configuration/manage-resources-containers.md:230–241`; `docs/tasks/run-application/horizontal-pod-autoscale.md:113–118`; `docs/reference/kubernetes-api/workload-resources/horizontal-pod-autoscaler-v2.md:86–99`; probe, termination, topology, networking, and storage ranges cited above.