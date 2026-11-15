Revise the design before production approval. Kubernetes provides controls for disruption, scheduling, health, scaling, isolation, and storage lifecycle; these controls do not establish an end-to-end availability guarantee. The recommendations below are configuration choices grounded solely in the supplied v1.32 documentation.

All cited paths are relative to `/var/folders/3t/t35161bs2slggt46tnrk0b4c0000gn/T/doktimoi-bench-3-doktimoi-CAHPlH/docs`; numbers identify source line ranges.

1. **PDB protection depends on the disruption.** A node failure is involuntary: the PDB cannot prevent it, although unavailable Pods count against the budget. During an ordinary eviction-based node drain, `minAvailable: 5` permits evictions only while five selected healthy Pods remain; drain can block while replacements start or await capacity. Direct deletion bypasses this protection. A Deployment rolling update counts against the budget but is not constrained by it. Thus, `maxUnavailable: 2` permits availability to fall to four at six desired replicas. Recommend `maxUnavailable: 0, maxSurge: 1`, with capacity for the replacement and terminating Pods. `maxUnavailable: 1` also matches a five-replica rollout floor, but neither choice prevents concurrent failures.

   Sources: `concepts/workloads/pods/disruptions.md:92–145,190–232`; `tasks/run-application/configure-pdb.md:107–139`; `concepts/workloads/controllers/deployment.md:1183–1213,327–332`.

2. **Configure explicit zone spreading.** Use an API label selector, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`, targeting two replicas per zone when scheduling permits. The topology key groups nodes with equal label values into domains. With `DoNotSchedule`, skew limits the difference between the target domain’s matching-Pod count and the global minimum; violating placements remain pending. `ScheduleAnyway` prefers reduced skew without enforcing that bound.

   Choose the outage tradeoff explicitly. `minDomains: 3` with strict scheduling makes the global minimum zero when fewer than three eligible domains remain, potentially blocking replacement placement in surviving zones. Omitting it defaults to one minimum domain, but failure behavior still depends on eligible nodes, labels, taints, and capacity. Constraints neither guarantee redistribution after removals nor recovery time. Losing a two-replica zone already leaves only four replicas.

   Sources: `concepts/scheduling-eviction/topology-spread-constraints.md:76–126,605–623`.

3. **Protect startup; separate traffic eligibility from restart decisions.** Configure a startup probe with `failureThreshold × periodSeconds` covering measured worst-case initialization. Readiness and liveness probes, including their delays, begin only after startup succeeds. Startup failure beyond its threshold triggers container restart; liveness should detect an unrecoverable condition such as deadlock. Readiness should represent ability to serve requests, including necessary dependencies: failure marks the Pod unready and removes it from Service load balancing while leaving the container running. Avoid making transient database trouble a liveness failure without evidence that restarting helps.

   Sources: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:14–48,311–355,398–429`.

4. **Thirty seconds does not guarantee request completion.** The grace-period countdown begins before `preStop`; hook execution consumes that budget. The kubelet runs the hook before asking the runtime to send TERM to container process 1. A still-running hook can receive a small, one-off two-second extension. At grace expiry, remaining processes receive SIGKILL.

   Endpoint processing occurs concurrently with local shutdown. Terminating endpoints are not immediately removed from EndpointSlices, but their `ready` condition becomes false for regular traffic; `serving` supports draining-aware consumers. Implement TERM handling and connection draining, then size grace time for hook execution and measured long-request completion. These mechanics do not establish instantaneous routing convergence or successful completion.

   Sources: `reference/kubernetes-api/workload-resources/pod-v1.md:1000–1008`; `concepts/workloads/pods/pod-lifecycle.md:584–640`.

5. **Resource settings affect placement, runtime behavior, and HPA.** CPU requests inform scheduling and provide the denominator for utilization-based autoscaling. Containers may consume above requests when resources permit. CPU limits enforce a ceiling through throttling; memory limits can cause reactive OOM termination rather than CPU-style throttling. Set requests and limits from workload measurements, including initialization and long requests.

   For Pod CPU utilization, missing relevant requests in some containers makes utilization undefined, and HPA takes no action for that metric. Account for admission defaults: when a limit exists without a request and no other default applies, Kubernetes copies the limit into the request.

   Sources: `concepts/configuration/manage-resources-containers.md:23–67`; `tasks/run-application/horizontal-pod-autoscale.md:89–102`.

6. **HPA deliberately moderates the raw ratio.** Its baseline is the ceiling of current replicas multiplied by current/desired metric value, with default tolerance of 0.1. Missing metrics are set aside, then conservatively treated as 100% of target for downscaling and 0% for upscaling. Not-yet-ready CPU Pods are also set aside and can dampen scale-up through an assumed zero contribution. Recalculation can cancel scaling if direction reverses or falls within tolerance.

   Default readiness-related windows are 30 seconds and five minutes for CPU initialization. Default downscale stabilization selects the highest recommendation within five minutes. Therefore reported utilization and the simple ratio need not predict the actual replica change. A functioning metrics API is a prerequisite, usually requiring separately deployed Metrics Server.

   Sources: `tasks/run-application/horizontal-pod-autoscale.md:109–115,129–218,455–486`.

7. **Replace unrestricted networking with explicit allowances.** Establish ingress and egress isolation using policies selecting the API and database Pods, then permit only required callers, API-to-database traffic on the database port, DNS, and identified operational dependencies. Ingress and egress isolation are independent. Once isolated, a direction permits the union of applicable policy allowances; policies are additive, so another broad policy can reopen access. For Pod-to-Pod connections, source egress and destination ingress must both allow the connection; reply traffic is implicitly allowed.

   Select DNS destinations according to the cluster’s actual deployment. NetworkPolicy enforcement requires a supporting network plugin; otherwise resources are ignored. Validate allowed and denied paths.

   Sources: `concepts/services-networking/network-policies.md:51–81`; `concepts/security/multi-tenancy.md:208–234`.

8. **Base64 is insufficient protection.** The documentation explicitly calls base64-encoded credentials obscured rather than secret. Reject encoded production credentials in Git as a confidentiality measure. Kubernetes Secrets are also unencrypted in etcd by default: enable encryption at rest, apply least-privilege RBAC, and expose Secrets only to containers needing them.

   Pod-creation permission matters because someone authorized to create a Pod in a namespace can read that namespace’s Secrets through the Pod; indirect creation through a Deployment also counts. Restrict workload creation as well as direct Secret access. Cluster encryption does not protect repository copies.

   Sources: `concepts/configuration/secret.md:35–53,280–307`.

9. **Review existing PVs individually.** Dynamically provisioned PVs inherit their StorageClass reclaim policy, defaulting to `Delete`. A changed class policy does not retroactively rewrite existing PV policies; edit or patch those PVs separately. With supported plugins, `Delete` removes both the PV object and backing storage. `Retain` leaves a released PV and its data after PVC deletion, requiring manual reclamation.

   PVC deletion differs from StatefulSet deletion or scale-down. StatefulSet-generated PVCs are retained by default; `persistentVolumeClaimRetentionPolicy.whenDeleted` and `whenScaled` can independently request deletion. Any resulting PVC deletion then encounters the PV’s reclaim policy. Active-use protection can postpone PVC removal.

   Sources: `concepts/storage/storage-classes.md:126–135`; `concepts/storage/persistent-volumes.md:123–137,185–210`; `reference/kubernetes-api/workload-resources/stateful-set-v1.md:130–146`.

10. **Prioritize validation before rollout.**

   - First remove exposed credentials, establish Secret controls, and inspect database PVC retention and every existing PV’s reclaim policy. Test restoration before deletion experiments.
   - Next measure startup and request duration; implement probes and draining, size grace periods and resources, and verify metrics availability.
   - Then enforce and test network allowances, configure explicit zone spreading, retain six as the recommended HPA minimum, and reserve surge capacity.
   - Finally rehearse rollout, eviction-based drain, node/zone loss, missing metrics, and database recovery under representative load.

   Acceptance must validate at least these limits: application throughput with reduced replicas; successful draining of long requests; surviving-zone capacity and scheduling; actual network-plugin enforcement; and database recovery/data durability. The cited documents establish mechanisms, not those application or cluster outcomes.

   Sources: `concepts/workloads/pods/disruptions.md:190–232`; `concepts/workloads/pods/pod-lifecycle.md:612–640`; `tasks/run-application/horizontal-pod-autoscale.md:129–218`; `concepts/security/multi-tenancy.md:208–234`; `concepts/storage/persistent-volumes.md:185–210`.