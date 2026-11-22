**Decision memo — revise before production approval.** The proposed settings do not establish five-replica availability, safe request draining, or database durability. Adopt the changes below and make approval conditional on measured application behavior and verified cluster capabilities.

All citations identify local files relative to `/var/folders/3t/t35161bs2slggt46tnrk0b4c0000gn/T/doktimoi-bench-2-doktimoi-SlhYET/docs`; suffixes are source line ranges.

1. **PDB protection differs by disruption.** During node failure, `minAvailable: 5` cannot prevent involuntary losses, although those losses count against the budget. During an eviction-based node drain, the PDB constrains evictions: with six healthy replicas, one may be voluntarily disrupted; further evictions can wait. Direct deletion bypasses that protection. During a Deployment rolling update, unavailable Pods count against the budget, but the Deployment is not constrained by it. Thus `maxUnavailable: 2` permits an update availability floor of four. Recommend `maxUnavailable: 1, maxSurge: 1`, with capacity for replacement Pods; this aligns the rollout allowance with five available out of six, without guaranteeing availability through concurrent failures.

   Sources: `concepts/workloads/pods/disruptions.md:59-65,92-145`; `concepts/workloads/controllers/deployment.md:1184-1208`.

2. **Configure explicit zone spreading.** Use a selector matching the API Pods, `topologyKey: topology.kubernetes.io/zone`, and `maxSkew: 1`. The topology key groups nodes by their label values. With `DoNotSchedule`, skew limits the difference between the target domain’s matching-Pod count and the global minimum; `ScheduleAnyway` merely favors placements that reduce imbalance. Six replicas can target two per zone when capacity and eligibility permit.

   Choose outage behavior deliberately. With `minDomains: 3`, fewer than three eligible domains makes the global minimum zero, potentially blocking replacements in surviving zones. Omitting it behaves as one minimum domain, permitting different redistribution when a domain disappears. An unavailable zone’s effect depends on eligibility, not simply its name. Losing two replicas still leaves four. Spreading governs scheduling; removals need not preserve balance.

   Sources: `concepts/scheduling-eviction/topology-spread-constraints.md:76-126,532-551,605-623`.

3. **Separate startup, readiness, and liveness.** Configure a startup probe whose `failureThreshold × periodSeconds` covers measured worst-case initialization. Readiness and liveness begin only after startup succeeds. Startup failure exhausts its budget and causes container termination, with restart governed by `restartPolicy`. Readiness should represent the ability to accept useful requests, including necessary database access; failure removes the Pod from Service backends. Liveness should detect unrecoverable conditions such as deadlock and trigger restart. Avoid treating every database interruption as a liveness failure: inappropriate checks can cause cascading restarts.

   Sources: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:13-48,311-347`.

4. **Thirty seconds does not guarantee request completion.** The grace-period countdown begins **before** `preStop`; the hook consumes part of that budget. The kubelet runs the hook, then asks the runtime to send TERM to process 1. A still-running hook can receive a one-off two-second extension. At expiry, remaining processes receive SIGKILL.

   Endpoint handling occurs concurrently: terminating endpoints are not immediately removed from EndpointSlices, but have `ready: false` and are excluded from regular load balancing; `serving` supports draining decisions. Implement application shutdown that stops accepting work and finishes open requests. Set the grace period from measured hook, request, and shutdown durations; the default is a deadline, not a completion promise.

   Sources: `reference/kubernetes-api/workload-resources/pod-v1.md:998-1008`; `concepts/workloads/pods/pod-lifecycle.md:584-643`.

5. **Requests and limits serve different purposes.** CPU requests contribute to scheduling capacity checks and provide the denominator for utilization-based HPA; they are not a usage ceiling. Containers may use spare resources above requests. CPU limits impose throttling. Memory limits are enforced reactively through OOM killing, so exceeding one does not necessarily cause immediate termination. Set requests from measurements and select limits with latency and failure behavior in mind.

   If relevant CPU requests are missing from some containers, Pod CPU utilization is undefined and HPA takes no action for that metric. Check effective admitted requests: absent another defaulting mechanism, specifying only a limit makes Kubernetes copy it into the request.

   Sources: `concepts/configuration/manage-resources-containers.md:27-67,230-241`; `tasks/run-application/horizontal-pod-autoscale.md:89-103`.

6. **HPA deliberately modifies the raw ratio.** Its basic calculation is the ceiling of current replicas multiplied by current/desired metric value. Terminating and failed Pods are excluded; missing metrics and CPU metrics from not-yet-ready Pods are set aside. For missing metrics, recomputation assumes 100% of target during downscale and 0% during upscale. Not-yet-ready Pods also dampen potential upscale through a zero-consumption assumption. A reversed direction or result within tolerance causes no scaling.

   Default readiness-related windows are 30 seconds and five minutes. Default downscale stabilization selects the highest recommendation within five minutes, delaying reductions after peaks. Therefore displayed utilization and the final scaling decision can differ.

   Sources: `tasks/run-application/horizontal-pod-autoscale.md:129-202,213-219`.

7. **Replace default allow with explicit connection permissions.** Apply default-deny ingress and egress to the relevant workloads, then permit approved callers to the API port, API egress to the database port, and necessary DNS queries. For an in-cluster database, also permit ingress from the API. Restrict peers with appropriate Pod and namespace selectors and verified ports.

   Ingress and egress isolation are independent. Policies combine additively: a broad allow cannot be overridden by adding a narrower policy. Both source egress and destination ingress must permit a Pod-to-Pod connection; replies to allowed connections are implicitly permitted. A network implementation supporting NetworkPolicy is a prerequisite—creating objects alone provides no enforcement.

   Sources: `concepts/services-networking/network-policies.md:51-118`; `concepts/security/multi-tenancy.md:210-234`.

8. **Base64 is insufficient protection for Secrets in Git.** The documentation describes base64 credentials as obscured, not secret. Reject ordinary committed manifests containing production credentials. Enable Secret encryption at rest, configure least-privilege RBAC, and expose credentials only to containers needing them. Secrets are stored unencrypted in etcd by default.

   Review workload-creation permissions alongside Secret-read permissions: someone allowed to create Pods in a namespace can read that namespace’s Secrets through a Pod, including indirectly through Deployment creation. Encryption at rest protects stored cluster data; it does not establish confidentiality for a separately committed repository copy.

   Sources: `concepts/configuration/secret.md:34-47,305-307,448-463`; `tasks/administer-cluster/encrypt-data.md:574-588`.

9. **Treat PV reclamation and PVC retention separately.** A StorageClass supplies the reclaim policy when dynamically provisioning a PV; changing that choice does not retroactively update existing PV policies. Inspect and edit or patch existing PVs explicitly. `Delete`, where supported by the volume plugin, removes the PV and backing storage asset. `Retain` leaves a released PV and its data after PVC deletion, requiring manual reclamation.

   StatefulSet deletion or scale-down retains template PVCs by default. Optional `persistentVolumeClaimRetentionPolicy` can independently choose `Delete` for those events; its documented prerequisite is enabling `StatefulSetAutoDeletePVC` on the API server and controller manager. PVC deletion then engages PV reclamation. Dynamic provisioning alone establishes neither database backup nor recovery guarantees.

   Sources: `concepts/storage/storage-classes.md:126-135`; `concepts/storage/persistent-volumes.md:185-209`; `concepts/workloads/controllers/statefulset.md:387-427`.

10. **Prioritize rollout and validation as follows.**

   - First remove production credentials from ordinary Git manifests, verify encryption/RBAC, inventory existing PV policies, and choose explicit PVC retention behavior.
   - Next verify NetworkPolicy enforcement and HPA’s metrics prerequisites, then deploy narrow connection permissions.
   - Configure measured resources and probes, compatible rollout limits, explicit zone spreading, and a tested shutdown budget.
   - Exercise drain, rolling update, zone loss, slow startup, missing metrics, long-request termination, and database recovery before approval.

   Required application or cluster validation includes at least: worst-case startup and drain duration; CPU scaling’s relationship to request latency and database capacity; surviving-zone capacity and storage accessibility; and backup restoration. Also reconcile HPA minimum replicas with the five-available objective. These documents establish mechanisms and prerequisites, not this application’s service-level performance or recoverability.

   Sources: `tasks/run-application/horizontal-pod-autoscale.md:89-121,350-370`; `concepts/workloads/controllers/deployment.md:327-332`; `concepts/workloads/pods/pod-lifecycle.md:619-639`; `concepts/storage/persistent-volumes.md:185-209`.