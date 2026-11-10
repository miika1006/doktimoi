**Decision: revise before production approval.** The proposed settings do not establish five-replica availability, completion of long requests, secret confidentiality, or database durability. The following recommendations distinguish documented behavior from design choices and validation requirements. Citations are local paths relative to the supplied `docs/` directory.

1. **PDB and rollout availability.** `minAvailable: 5` cannot prevent involuntary node failures; those failures nevertheless consume the disruption budget. During an Eviction-API-respecting node drain, it constrains permitted evictions, potentially blocking the drain until replacements become healthy. Direct Pod deletion bypasses that protection. Deployment rolling updates are not constrained by PDBs, although unavailable rollout Pods count against the budget. Consequently, `maxUnavailable: 2` permits rollout-driven availability to fall to four at six desired replicas.

   Recommend `maxUnavailable: 0`, `maxSurge: 1`, with capacity for the extra Pod; `maxUnavailable: 1` is compatible with a five-Pod rollout floor but leaves less headroom. Neither protects against concurrent failures.  
   Sources: `concepts/workloads/pods/disruptions.md:60-65,95-145`; `concepts/workloads/controllers/deployment.md:1183-1211`.

2. **Spread across zones.** Configure a matching Pod selector, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`; verify node labels. The topology key groups identically labelled nodes into domains. With `DoNotSchedule`, skew limits the target domain’s matching-Pod count relative to the global minimum. With `ScheduleAnyway`, reducing skew is a preference, so imbalance remains possible.

   Prefer strict spreading if balanced placement is mandatory, but explicitly choose the outage tradeoff. If fewer than three domains remain eligible, `minDomains: 3` makes the global minimum zero and can block replacement scheduling. Without it, the default minimum is one domain; eligibility and capacity determine placement. Zone disappearance and unhealthy nodes are not equivalent. Six evenly spread replicas lose two on a complete zone failure, leaving four. Constraints also do not guarantee balance after removals.  
   Sources: `concepts/scheduling-eviction/topology-spread-constraints.md:76-132,203-211,605-623`.

3. **Probes for slow startup.** Use a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Readiness and liveness probes begin only after startup succeeds. Exhausting startup failures kills the container, with restart governed by its restart policy.

   Readiness should indicate whether the API can accept requests; failure removes an unready Pod from Service backends without itself requesting a restart. Liveness should detect an unrecoverable condition such as deadlock. Avoid making transient database unavailability a liveness failure merely because requests currently cannot succeed: the docs warn that poorly chosen liveness checks cause cascading failures. These endpoint semantics are application design choices requiring tests.  
   Sources: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:15-48,311-347`.

4. **Termination and long requests.** The grace-period countdown begins before `preStop`. The kubelet runs the hook before asking the runtime to send TERM to process 1; hook execution consumes the shutdown budget. An unfinished hook can receive a small, one-off two-second extension. At grace expiry, remaining processes receive `SIGKILL`.

   Endpoint updates happen alongside shutdown, not as a guaranteed preceding step. Terminating endpoints remain represented temporarily but have `ready: false`, excluding them from regular load-balancer traffic; `serving` supports draining-aware consumers. Thirty seconds is a default, not a request-completion guarantee. Implement draining and TERM handling, then size grace for hook execution and measured request completion.  
   Sources: `reference/kubernetes-api/workload-resources/pod-v1.md:1006-1008`; `concepts/workloads/pods/pod-lifecycle.md:584-645`.

5. **Resource configuration.** CPU requests inform scheduling and provide the denominator for utilization-based HPA; they are not CPU ceilings. A container can exceed its request when resources are available. CPU limits enforce throttling, which can increase latency. Memory limits work differently: kernel OOM kills enforce them reactively, rather than throttling memory consumption or necessarily killing immediately upon overshoot.

   Set explicit, measured CPU requests for every relevant container. If some containers lack requests, Pod CPU utilization is undefined and HPA takes no action for that metric. Check effective admission defaults: when a limit exists without a request, Kubernetes can copy the limit into the request.  
   Sources: `concepts/configuration/manage-resources-containers.md:15-67`; `tasks/run-application/horizontal-pod-autoscale.md:89-101`.

6. **HPA’s conservative adjustments.** The starting calculation is the ceiling of current replicas multiplied by current-to-target metric ratio. Deleting and failed Pods are excluded; missing metrics and certain startup CPU samples are set aside. Missing metrics are conservatively treated as 100% of target during downscale and 0% during upscale. Not-yet-ready Pods further dampen upscale through a 0% assumption.

   A recalculated ratio that reverses direction or falls within tolerance produces no scaling. Default CPU readiness handling uses a 30-second initial-readiness delay and five-minute initialization period. Separately, default downscale stabilization selects the highest recommendation within five minutes. Thus observed scaling can differ from both the raw ratio and reported average utilization.  
   Sources: `tasks/run-application/horizontal-pod-autoscale.md:130-218`.

7. **Least-privilege networking.** Introduce default-deny ingress and egress, then permit only required flows: approved callers to the API port, API Pods to the database port, and necessary DNS queries. Use scoped Pod and namespace selectors and validate actual DNS destinations.

   Ingress and egress isolation are independent. Applicable policies combine additively: a broad allow remains effective despite a restrictive policy. For Pod-to-Pod traffic, source egress and destination ingress must both permit the connection; replies to allowed connections are implicitly allowed. A NetworkPolicy-capable CNI is a prerequisite—otherwise the resources are ignored. Policies’ existence therefore proves neither enforcement nor application connectivity.  
   Sources: `concepts/services-networking/network-policies.md:51-81`; `concepts/security/multi-tenancy.md:208-234`.

8. **Secrets.** Reject base64-encoded production Secrets in Git as a confidentiality mechanism. Base64 values are decodable; the documentation explicitly describes encoded authentication data as obscured, not secret. Kubernetes Secrets are also stored unencrypted in etcd by default.

   Enable and verify encryption at rest, restrict encryption-key access, and apply least-privilege RBAC and container access. Restrict Pod creation as well as direct Secret reads: permission to create Pods, including indirectly through Deployments, can expose any Secret in that namespace. Encryption at rest does not protect a plaintext-equivalent Git copy or prevent authorized API access.  
   Sources: `concepts/configuration/secret.md:35-48,306`; `tasks/administer-cluster/encrypt-data.md:415-421,574-588`.

9. **Storage lifecycle.** Changing the StorageClass reclaim policy does not retroactively rewrite existing PV policies. Dynamically provisioned PVs inherit the class policy at creation; existing PVs require explicit editing or patching. The default is `Delete`.

   With `Retain`, deleting a PVC leaves a released PV and its data for manual reclamation. With supported `Delete` plugins, reclamation removes both the PV and external storage asset. StatefulSet deletion or scale-down is a separate lifecycle decision: template-created PVCs are retained by default. Configurable `whenDeleted` and `whenScaled` policies can delete them; the documented feature-gate prerequisite must hold. Retention is not a backup guarantee.  
   Sources: `concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:185-210`; `concepts/workloads/controllers/statefulset.md:387-422`.

10. **Prioritized rollout and validation checklist.** First, remove production credentials from the proposed Git workflow, verify encryption/RBAC, and test CNI enforcement with positive and negative connection tests. Second, inspect existing PV reclaim policies and database PVC retention before any destructive lifecycle operation. Third, deploy measured probes, resource requests, graceful shutdown, and the revised rollout strategy. Finally, exercise drains, rolling updates, zone loss, and HPA expansion/downscale under representative load.

    Approval requires application or cluster evidence for at least these unresolved limits: worst-case startup duration; longest safely drainable request; database recovery and data durability; remaining-zone capacity; and CPU utilization’s relationship to latency. The documents define mechanisms, not those workload outcomes. Also reserve capacity for lingering terminating Pods, which can temporarily exceed the rollout’s nominal surge count.  
    Sources: `concepts/workloads/controllers/deployment.md:327-332`; `concepts/workloads/pods/pod-lifecycle.md:612-639`; `tasks/run-application/horizontal-pod-autoscale.md:167-218`; `concepts/storage/persistent-volumes.md:185-210`.