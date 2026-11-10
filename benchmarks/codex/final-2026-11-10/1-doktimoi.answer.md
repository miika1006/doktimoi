**Decision memo — revise before production.** The proposed configuration does not establish five-replica availability, graceful completion of long requests, credential confidentiality, or database durability. The recommendations below distinguish documented behavior from configuration choices and validation requirements. All citations are local paths relative to the supplied `docs/` directory; ranges refer to source lines.

1. **PDB protection depends on the disruption.** During **node failure**, `minAvailable: 5` cannot prevent lost replicas; involuntary disruptions merely count against the budget. During **node drain**, eviction-aware tooling respects the PDB: with six healthy replicas, one eviction is permitted, and further evictions can wait. Direct deletion bypasses this protection. During a **Deployment update**, unavailable Pods count against the budget, but the Deployment controller is not constrained by it.

   Replace `maxUnavailable: 2`, which permits rollout availability of four, with `maxUnavailable: 1`, or preferably `0` with `maxSurge: 1` and capacity for the extra Pod. This controls rollout behavior; it does not guarantee availability during concurrent failures. Keep the HPA replica floor consistent with the six-replica design.

   Sources: `concepts/workloads/pods/disruptions.md:60–65,92–145`; `concepts/workloads/controllers/deployment.md:1189–1211`.

2. **Explicitly spread replicas across zones.** Configure a selector matching the API Pods, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`. The topology key groups nodes by their zone-label value. With `DoNotSchedule`, skew limits the difference between the target domain’s matching-Pod count and the global minimum. With `ScheduleAnyway`, reducing skew is a scheduling preference, not a hard requirement.

   Recommend hard spreading normally, with a deliberate zone-outage strategy. `minDomains: 3` makes the global minimum zero when fewer than three eligible domains remain; this can block replacements in surviving zones. Without it, the default is one, potentially allowing redistribution across remaining eligible domains. Actual behavior depends on eligible nodes, affinity, taints, and capacity—not simply whether operators call a zone “unavailable.” Two replicas per zone also means losing a zone initially leaves four. Spreading does not maintain five survivors or guarantee continued balance after removals.

   Source: `concepts/scheduling-eviction/topology-spread-constraints.md:76–139,604–618`.

3. **Use startup protection, traffic readiness, and conservative liveness.** Configure a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Readiness and liveness begin only after startup succeeds. Repeated startup failure kills the container, with restart governed by its restart policy.

   Readiness should indicate whether this instance can serve requests; failure makes the Pod unready and removes it from Service load balancing, without itself restarting the container. Liveness should detect unrecoverable local failure, such as deadlock. Avoid making a transient database outage trigger liveness failures across every replica. Thresholds and endpoint semantics require application testing.

   Source: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:18–48,311–347`.

4. **Thirty seconds is a deadline, not a completion guarantee.** The termination grace-period clock starts **before** `preStop`. The hook therefore consumes the same shutdown budget. After the hook, the runtime sends TERM to the container’s main process; remaining processes receive SIGKILL when grace expires. A still-running hook can receive a small, one-off two-second extension.

   Endpoint updates occur alongside shutdown. Terminating endpoints are not immediately removed from EndpointSlices, but their `ready` condition becomes false, excluding them from regular load balancing; `serving` supports draining-aware consumers. Implement graceful signal handling and measure hook time, request duration, and draining behavior before choosing a longer grace period. These documents do not promise every existing request finishes.

   Sources: `reference/kubernetes-api/workload-resources/pod-v1.md:992–1008`; `concepts/workloads/pods/pod-lifecycle.md:584–643`.

5. **Requests and limits serve different purposes.** CPU requests inform placement and provide the denominator for utilization-based HPA. They are not a consumption ceiling: spare resources can be used above requests. CPU limits enforce throttling. Memory limits instead produce reactive OOM enforcement: exceeding the limit can cause termination under memory pressure, rather than CPU-style throttling.

   Set realistic CPU requests for every relevant container and validate limits under startup and sustained load. If relevant requests are missing, Pod CPU utilization is undefined and HPA takes no action for that metric. A specified limit can become the default request when no other default applies, so inspect admitted Pod settings.

   Sources: `concepts/configuration/manage-resources-containers.md:16–67`; `tasks/run-application/horizontal-pod-autoscale.md:89–102`.

6. **HPA deliberately adjusts the raw ratio.** The basic calculation rounds up current replicas multiplied by current/desired metric value. Deleting and failed Pods are excluded; missing metrics and qualifying not-yet-ready CPU samples are set aside. Missing metrics are conservatively assumed to consume 100% of target during downscale and 0% during upscale. Not-yet-ready Pods further dampen upscale through a zero-consumption assumption.

   If recalculation reverses direction or falls within tolerance, scaling does not occur. Default readiness-delay and CPU-initialization windows are 30 seconds and five minutes. Default downscale stabilization retains the highest recommendation over five minutes. Consequently, reported average utilization and the resulting scale decision can differ. Verify the resource metrics API, commonly supplied by separately installed Metrics Server.

   Source: `tasks/run-application/horizontal-pod-autoscale.md:110–118,129–218`.

7. **Replace default allow with explicit connection permissions.** Establish ingress and egress isolation, then allow approved callers to the API port, API egress to the database port, and database ingress from API Pods. Permit required DNS traffic to the cluster’s actual resolver endpoints and ports; discover and test those details rather than assuming them.

   Ingress and egress isolation are independent. Policies combine additively: a broad allow policy defeats a narrower intended restriction. Pod-to-Pod connections require both source egress and destination ingress permission; allowed reply traffic is implicit. A supporting CNI/network-policy implementation is a prerequisite—creating policy objects alone has no effect.

   Source: `concepts/services-networking/network-policies.md:43–81`. The specific DNS and database allowlists are design choices requiring cluster validation.

8. **Base64 is not confidentiality.** Reject base64-encoded credentials in Git as a protection mechanism: the documentation explicitly describes base64 data as obscured, not secret. Enable Secret encryption at rest; Secrets otherwise reside unencrypted in etcd by default. Restrict Secret access with least-privilege RBAC and expose credentials only to containers requiring them.

   Pod-creation permission is also sensitive: someone authorized to create Pods in a namespace can obtain Secrets there, including indirectly through Deployment creation. Restrict workload creation as well as direct Secret reads. Verify encryption in stored data; enabling cluster encryption does not protect credential copies already committed to Git.

   Sources: `concepts/configuration/secret.md:35–48,305–307`; `tasks/administer-cluster/encrypt-data.md:534–588`.

9. **Existing PVs require their own reclaim-policy review.** Dynamically provisioned PVs inherit their StorageClass reclaim policy at creation; changing the class does not retroactively change existing PVs. Inspect and patch existing PVs explicitly. `Delete`, the default, removes both the PV and backing storage for supporting plugins. `Retain` leaves a released PV and its data for manual reclamation after PVC deletion.

   StatefulSet deletion or scale-down is different: its PVC retention policies default to `Retain`. Explicit `whenDeleted` or `whenScaled: Delete` can delete affected claims, after which PV reclaim behavior matters. In-use PVC protection postpones deletion; it is not a backup.

   Sources: `concepts/storage/storage-classes.md:126–135`; `concepts/storage/persistent-volumes.md:123–137,185–210`; `concepts/workloads/controllers/statefulset.md:387–421`.

10. **Prioritize validation before rollout.** First, remove credential exposure, verify encryption/RBAC, and audit database PV reclaim settings and recovery procedures. Second, enforce and test network allowlists, including DNS. Third, deploy measured probes, resource requests, graceful shutdown, and the compatible rollout strategy. Finally, exercise drain, rollout, zone loss, and HPA scaling under realistic load.

    Acceptance must validate at least: **startup duration**, **long-request completion within shutdown time**, **surviving-zone and surge capacity**, **CNI enforcement**, and **database recovery/durability**. The cited mechanisms do not establish these application or cluster outcomes. Observe availability and request failures, not merely successful object creation.

    Supporting limits: `concepts/workloads/pods/disruptions.md:129–145`; `concepts/workloads/pods/pod-lifecycle.md:619–639`; `concepts/services-networking/network-policies.md:43–49`; `concepts/storage/persistent-volumes.md:185–210`.