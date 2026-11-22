**Decision memo — revise before production approval.** The proposed fields provide useful controls, but they do not establish end-to-end availability, request completion, or database durability. The recommendations below distinguish documented behavior from configuration choices and validation requirements. All cited paths are local, relative to the supplied `docs/` directory; ranges identify source lines.

1. **The PDB does not guarantee five available replicas in all three cases.** Node failure is involuntary: PDBs cannot prevent it, although unavailable Pods count against the budget. During an eviction-based node drain, `minAvailable: 5` permits one eviction from six healthy replicas; further evictions can be rejected and retried. This protection depends on using the Eviction API, rather than directly deleting Pods. Deployment rolling updates count against the budget but are not constrained by it.  
   **Sources:** `concepts/workloads/pods/disruptions.md:92–145`.

   With six desired replicas, `maxUnavailable: 2` permits four available replicas during rollout. Recommend `maxUnavailable: 0`, `maxSurge: 1`, with capacity for the extra Pod; `maxUnavailable: 1` also aligns with a five-replica rollout floor. These constrain rollout behavior, not concurrent failures. Keep the autoscaling minimum consistent with the availability objective.  
   **Sources:** `concepts/workloads/controllers/deployment.md:1183–1199,1201–1212`.

2. **Spread replicas deliberately, while deciding whether placement or recovery takes priority.** Use an API-specific `labelSelector`, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`, targeting two replicas per zone. `topologyKey` identifies the node label whose values define domains. Under `DoNotSchedule`, skew bounds the difference between the destination domain’s matching-Pod count and the global minimum; violating placements remain pending. `ScheduleAnyway` instead prefers placements that reduce skew, subject to other scheduling priorities.  
   **Sources:** `concepts/scheduling-eviction/topology-spread-constraints.md:76–93,95–132,335–354`.

   Zone loss can immediately leave only four replicas. Recovery depends on capacity and which domains remain eligible. Setting `minDomains: 3` with strict scheduling makes the global minimum zero when fewer than three domains qualify, potentially blocking replacements. Omitting it behaves as one, allowing balancing across remaining eligible domains. For this API, prefer recovery-oriented `ScheduleAnyway` unless strict separation outweighs replacement capacity. Neither policy continuously repairs imbalance after removals.  
   **Sources:** `concepts/scheduling-eviction/topology-spread-constraints.md:95–115,603–623`.

3. **Use separate startup, readiness, and liveness checks.** Configure a startup probe with `failureThreshold × periodSeconds` covering measured worst-case initialization. Until startup succeeds, readiness and liveness probes are disabled. Exhausting startup failures kills the container, subject to its restart policy. After startup, readiness should establish whether the API can serve requests, including required database connectivity; liveness should detect an unhealthy application process rather than merely an unavailable database.  
   **Sources:** `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311–347`; `concepts/workloads/pods/pod-lifecycle.md:475–529`.

   Readiness failure removes the Pod from matching Service endpoints; it does not itself restart the container. Liveness failure kills the container and invokes restart-policy behavior. These mechanisms require application checks whose meanings are validated under realistic failures.  
   **Source:** `concepts/workloads/pods/pod-lifecycle.md:475–496`.

4. **Thirty seconds is a shutdown budget, not a request-completion guarantee.** The grace-period countdown begins before `preStop`, so the hook consumes that budget. Kubelet runs the hook before asking the runtime to signal the container’s main process, normally with SIGTERM; some runtimes honor an image-configured stop signal. A still-running hook can receive a one-off two-second extension. At expiry, remaining processes receive SIGKILL.  
   **Sources:** `reference/kubernetes-api/workload-resources/pod-v1.md:1006–1008`; `concepts/workloads/pods/pod-lifecycle.md:572–610,636–645`.

   Endpoint updates happen alongside local shutdown. Terminating endpoints remain represented temporarily with `ready: false`, excluding regular traffic; `serving` supports draining decisions. Set grace time from measured hook duration and request-draining needs, and verify application signal handling and traffic propagation. These documents establish no universal 30-second completion bound.  
   **Source:** `concepts/workloads/pods/pod-lifecycle.md:612–634`.

5. **Set resource requests and limits from measurements.** CPU requests inform scheduling capacity and provide the denominator for utilization-based HPA; requests are not usage ceilings. CPU limits enforce throttling. Memory limits operate reactively through OOM killing, so they are not equivalent to CPU throttling or an immediate allocation barrier. If a limit exists without a request, Kubernetes copies the limit into the request unless admission supplied another default.  
   **Sources:** `concepts/configuration/manage-resources-containers.md:27–67,230–241`.

   For Pod CPU utilization, missing relevant requests in some containers makes utilization undefined, and HPA takes no action for that metric. Explicitly inspect effective requests for every participating container. The resource metrics API is also a prerequisite, commonly supplied by a separately deployed Metrics Server.  
   **Source:** `tasks/run-application/horizontal-pod-autoscale.md:88–118`.

6. **Expect conservative HPA decisions rather than the raw ratio alone.** The basic calculation is the ceiling of current replicas multiplied by current/desired metric value. HPA sets aside missing metrics and certain not-yet-ready CPU samples. Missing samples are assumed to consume 100% of the target during downscale calculations and 0% during upscale calculations. Not-yet-ready Pods additionally dampen upscale by being treated as consuming zero.  
   **Sources:** `tasks/run-application/horizontal-pod-autoscale.md:127–165,167–195`.

   If recomputation reverses direction or falls within tolerance, scaling stops. Default tolerance is 0.1; readiness-delay and CPU-initialization defaults are 30 seconds and five minutes. Downscale stabilization defaults to five minutes and selects the highest recommendation within that window. Reported utilization omits these conservative adjustments, so status can appear inconsistent with scaling.  
   **Sources:** `tasks/run-application/horizontal-pod-autoscale.md:139–143,167–218`.

7. **Replace default allow with explicit ingress and egress isolation.** Select all relevant Pods with deny-by-default policies in both directions, then allow approved API callers, API-to-database connections on the database port, required database peer traffic, and DNS queries to the actual cluster resolver. DNS allowance is necessary for name resolution; resolver identities and required ports remain cluster-specific configuration.  
   **Sources:** `concepts/services-networking/network-policies.md:51–81,120–140`; `concepts/security/multi-tenancy.md:209–222`.

   Policies are additive unions: an existing broad allow cannot be overridden by adding a deny policy. Pod-to-Pod connections require both source egress and destination ingress permission. Enforcement requires a supporting network plugin; creating policy objects without an implementing controller has no effect. Validate external ingress paths because address rewriting can change what policies observe.  
   **Sources:** `concepts/services-networking/network-policies.md:45–81,189–203`.

8. **Reject base64-encoded credentials in Git as sufficient protection.** The documentation explicitly describes a base64 credential as obscured, not secret. Recommend keeping usable credentials out of ordinary repository manifests; encoding supplies no confidentiality. Kubernetes Secrets themselves are stored unencrypted in etcd by default. Enable encryption at rest, restrict Secret RBAC to least privilege, and expose each Secret only to containers that need it.  
   **Sources:** `concepts/configuration/secret.md:35–48,305–307`.

   Restrict workload creation too: permission to create Pods or Deployments in a namespace can expose its Secrets through mounted workloads. Workload creation can also confer service-account privileges available in that namespace. Secret-read restrictions alone therefore do not establish an adequate boundary.  
   **Sources:** `concepts/configuration/secret.md:36–40`; `concepts/security/rbac-good-practices.md:100–120`.

9. **Treat reclaim policy and PVC retention as separate controls.** Dynamically provisioned PVs inherit their StorageClass reclaim policy, defaulting to `Delete`. Changing the class is not a retrofit for existing PVs; inspect and edit or patch those PVs individually. After PVC deletion, `Retain` preserves the released PV and backing data for manual reclamation. With supporting plugins, `Delete` removes both the PV object and external storage asset.  
   **Sources:** `concepts/storage/storage-classes.md:126–135`; `concepts/storage/persistent-volumes.md:185–210`.

   StatefulSet deletion or scale-down retains template PVCs by default. Optional `whenDeleted` and `whenScaled` policies can instead delete affected PVCs; the supplied documentation requires `StatefulSetAutoDeletePVC` enabled on the API server and controller manager. Subsequent storage destruction depends on the PV reclaim policy. Dynamic provisioning alone establishes no database durability guarantee.  
   **Source:** `concepts/workloads/controllers/statefulset.md:388–420,438–453`.

10. **Prioritize rollout and validation as follows.** First, remove repository-exposed credentials and verify encryption, RBAC, network enforcement, and database retention. Second, configure measured requests, functioning metrics, probes, graceful draining, zone spreading, and compatible rollout settings. Third, stage a rolling update and eviction-based drain; then exercise node/zone loss, database outage, startup delays, missing metrics, and PVC lifecycle operations. These checks follow the documented control boundaries above.  
    **Sources:** `concepts/workloads/pods/disruptions.md:106–145`; `concepts/workloads/pods/pod-lifecycle.md:475–529,584–645`; `concepts/storage/persistent-volumes.md:185–210`.

    Release acceptance still needs application or cluster evidence for **request completion during termination**, **surviving-zone scheduling capacity**, **CNI enforcement**, **CPU scaling effectiveness**, and **database recovery and durability**. The cited mechanisms do not establish those outcomes.