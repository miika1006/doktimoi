I have all the evidence I need and am writing the memo now.

# Decision memo: six-replica API on Kubernetes v1.32

**Recommendation:** Do not approve the design as proposed. Four parts conflict with the documentation or are not supported by it: the rollout setting `maxUnavailable: 2`, default-allow networking, plain base64 Secrets in Git and dynamically provisioned storage left on the default reclaim policy. The 30-second grace period and the zone spread also need testing before production.

Each answer is marked with one of these labels: **[G]** something the documentation guarantees, **[C]** a configuration choice, **[P]** a prerequisite, and **[N]** something the documentation does not establish. All paths are relative to `docs/`.

---

### 1. PodDisruptionBudget (PDB) with minAvailable: 5

- **Node drain** is a voluntary disruption (`concepts/workloads/pods/disruptions.md:43-50`). With six replicas and `minAvailable: 5`, the Eviction API allows only one Pod to be evicted at a time. `kubectl drain` retries rejected evictions until they succeed or a timeout is reached (`:107-121`). **[G]**, but only for tools that use the Eviction API (`:107-109`).
- **Node failure** is an involuntary disruption. PDBs cannot prevent it, although it counts against the budget (`disruptions.md:30-34, 130-131`). `tasks/run-application/configure-pdb.md:148-155` says that a budget "does not truly guarantee" the minimum. **[N]**: no guarantee of five replicas.
- **Deployment rolling update:** Pods taken down by a rollout count against the budget, but Deployments "are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-137`). With `maxUnavailable: 2`, availability can fall to four (`concepts/workloads/controllers/deployment.md:1189-1199`). This **directly contradicts** the goal of five available replicas.
- Preemption respects a PDB only on a best-effort basis (`concepts/scheduling-eviction/pod-priority-preemption.md:230-238`).

**Recommendation [C]:** Use `strategy.rollingUpdate: {maxUnavailable: 0, maxSurge: 1}`. This combination is valid because `maxSurge` is not 0 (`reference/kubernetes-api/workload-resources/deployment-v1.md:79-111`). Replace the PDB with `maxUnavailable: 1`, which the documentation recommends because it follows changes in the replica count (`configure-pdb.md:174-176`). Also set `unhealthyPodEvictionPolicy: AlwaysAllow` (`disruptions.md:139-142`). Never set the minimum equal to the replica count, because then drains never complete (`configure-pdb.md:157-161`).

### 2. Spreading replicas across zones

- `maxSkew` is the largest allowed difference between the number of matching Pods in a domain and the global minimum. It must be greater than 0 (`concepts/scheduling-eviction/topology-spread-constraints.md:82-93`).
- `topologyKey` is a node label key. Nodes with the same value for that key form one domain (`:118-123`).
- `DoNotSchedule` is the default and leaves a Pod unscheduled if placing it would break the constraint. `ScheduleAnyway` schedules the Pod anyway and only prefers nodes that reduce the skew (`:125-127`). With `ScheduleAnyway`, that preference is weighed together with other scheduling scores (`:349-354`).
- **[C]:** Use `topologyKey: topology.kubernetes.io/zone`, `maxSkew: 1` and `DoNotSchedule`, and consider `minDomains: 3` (`:95-116`).
- **When a zone is unavailable [N]:** The scheduler learns about zones only from existing nodes. A zone with zero nodes is not considered at all (`:614-619`). Removing Pods does not rebalance the spread (`:607-608`). With `DoNotSchedule`, replacement Pods may stay Pending.
- Capacity in the remaining two zones is not guaranteed.

### 3. Probes for slow startup

- **startupProbe:** "All other probes are disabled" until it succeeds. If it fails, the container is killed and handled by the restart policy (`concepts/workloads/pods/pod-lifecycle.md:474-500`). Point it at the same endpoint as the liveness probe, and size `failureThreshold × periodSeconds` to cover the worst-case startup time. In the documented example that is 30 × 10 s = 300 s (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`; `pod-lifecycle.md:544-557`).
- **readinessProbe:** When it fails, the Pod is removed from the Service endpoints. The Pod gets no traffic until the probe succeeds (`pod-lifecycle.md:487-491, 512-518`). Also checking the database here keeps traffic away from Pods that could only return errors (`:525-529`).
- **livenessProbe:** When it fails, the container is restarted (`:481-484`).
- Liveness and readiness begin only after the startup probe has succeeded once. **[G]**
- **[N]:** The real worst-case startup time is unknown and must be measured.

### 4. Termination order and the 30-second grace period

1. The Pod is marked Terminating, and the grace-period clock starts.
2. The `preStop` hook runs. If it is still running when the grace period expires, the kubelet adds a one-off extension of 2 seconds (`pod-lifecycle.md:580-600`).
3. SIGTERM is sent, or the image's STOPSIGNAL. Containers receive it in arbitrary order (`:570-574, 602-610`).
4. SIGKILL is sent when the grace period expires (`:635-640`).

The `preStop` hook runs inside the same grace period. The documentation tells you to raise `terminationGracePeriodSeconds` if the hook needs more time (`:597-600`).

At the same time, endpoints of terminating Pods get `ready: false` and are removed from regular load-balancer traffic. Their `serving` condition can still be used for connection draining (`:612-632`).

**Is 30 s enough? No guarantee [N].** Requests that are still running when SIGKILL arrives are cut off. Set the grace period to at least the longest request time plus the `preStop` delay, and test it.

### 5. Resources

- **CPU limits** are enforced by throttling. Containers are not killed for using too much CPU (`concepts/configuration/manage-resources-containers.md:43-46, 275-276`).
- **Memory limits** are enforced reactively by OOM kills (`:48-53, 259-263`).
- **CPU requests** set the CPU weighting between containers and are used for scheduling (`:253-257`).
- If you set a limit but no request, the limit is copied as the request (`:61-66`).
- **HPA impact:** CPU utilization is calculated as a percentage of the request. If any container in the Pod lacks a CPU request, utilization is undefined and the HPA takes no action for that metric (`tasks/run-application/horizontal-pod-autoscale.md:89-102`). **[P]:** Set CPU requests on every container, sidecars included (`:255-281`).

### 6. HPA behavior

- Pods with missing metrics are set aside. During a scale-down they are assumed to use 100% of the target, and during a scale-up 0%.
- Pods that are not yet ready are assumed to use 0% during a scale-up (`horizontal-pod-autoscale.md:155-166, 180-197`).
- The readiness window defaults to 30 s and the CPU initialization period to 5 minutes (`:167-178`). A slow-starting Pod therefore holds back further scale-ups.
- Ratios within the 0.1 tolerance are ignored (`:140-148`).
- The default scale-down stabilization window is 300 s. The HPA uses the highest desired replica count from that window (`:433-485`).
- For these reasons, actual scaling can differ from the raw `current/target` ratio.
- **[P]:** Metrics Server must be installed separately (`:114-118`).

### 7. Least-privilege networking

- **Default state:** Pods are not isolated in either direction.
- **Isolation:** A Pod becomes isolated for ingress or egress when any policy that selects it lists that direction in `policyTypes`.
- **Additive policies:** Allowed connections are the union of what all applicable policies allow.
- **Both ends:** The source Pod's egress policy and the destination Pod's ingress policy must both allow a connection (`concepts/services-networking/network-policies.md:51-81`).

**[C]:** Start with a default deny for all ingress and egress (`:254-262`). Then add allow rules for:

- traffic from the ingress or load-balancer source to the API port;
- traffic from the API to the database port;
- the ingress rule on the database side.

**DNS [N]:** The corpus confirms that DNS runs as the `kube-dns` Service on 53/UDP and 53/TCP (`tutorials/services/connect-applications-service.md:221-235`). The policy pages I searched did not state that DNS needs its own rule. My inference is that a default-deny egress policy blocks name lookups unless egress to that Service is allowed.

**[P]:** The CNI plugin must enforce NetworkPolicy (`network-policies.md:16`). The deny guarantee covers only TCP, UDP and SCTP (`:276-280`).

### 8. Secrets

Base64 is not protection. Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them, and so can anyone who can create a Pod or Deployment in the namespace (`concepts/configuration/secret.md:36-41`). The documentation calls base64 "obscured but not secret" (`:305-307`).

**[C]:**

- Turn on encryption at rest.
- Grant least-privilege RBAC.
- Restrict Secrets to the containers that need them.
- Consider an external secret store (`:43-48`).
- Use separate namespaces, and note that privileged containers can read every Secret on their node (`:667-674`).

Keep plaintext-equivalent Secrets out of Git.

### 9. Storage reclaim policy

- Dynamically provisioned PVs inherit the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`).
- **Delete** removes the PV and the storage asset behind it.
- **Retain** keeps the PV in the Released state for manual reclamation, and the storage asset still exists after the PV is deleted (`concepts/storage/persistent-volumes.md:185-209`).
- The documentation says that if the class does not match expectations, "the PV must be edited or patched after it is created" (`:205-210`). It does **not** establish that changing the StorageClass affects existing PVs **[N]**. Patch each existing PV.
- **Deleting a PVC** triggers the PV's reclaim policy.
- **Deleting or scaling down a StatefulSet** does not delete its volumes by default (`concepts/workloads/controllers/statefulset.md:52-54`). It deletes them only if `persistentVolumeClaimRetentionPolicy` is set to `Delete` (`reference/kubernetes-api/workload-resources/stateful-set-v1.md:130-145`; `statefulset.md:438-453`).

**[C]:** Use `Retain` for database volumes.

### 10. Prioritized checklist

1. **Security:** Turn on encryption at rest and least-privilege RBAC (including who can create Pods). Remove base64 Secrets from Git (Q8).
2. **Data:** Set `Retain` on the class and patch existing PVs. Check the StatefulSet PVC retention policy (Q9).
3. **Networking:** Confirm the CNI enforces NetworkPolicy. Apply default deny, then add the API, database and DNS allow rules, and test both directions of each path (Q7).
4. **Probes:** Add startup, readiness and liveness probes sized from measured startup times (Q3).
5. **Rollout and PDB:** Use `maxUnavailable: 0` with `maxSurge: 1`, a PDB with `maxUnavailable: 1` and `AlwaysAllow`. Run a test drain (Q1).
6. **Termination:** Add a `preStop` hook and a grace period of at least the longest request time plus that delay. Test with real traffic (Q4).
7. **Scaling:** Set CPU requests on every container, install Metrics Server and tune the HPA behavior (Q5–Q6).
8. **Zones:** Spread across zones with `maxSkew: 1`, then run a zone-loss drill (Q2).

**Limits these documents do not guarantee:**

- Five replicas staying available during node failure or a rolling update (`configure-pdb.md:148-155`; `disruptions.md:133-137`).
- Long requests finishing within the grace period (`pod-lifecycle.md:635-640`).
- Capacity and rescheduling when a zone fails or has zero nodes (`topology-spread-constraints.md:605-619`).
- CNI enforcement and behavior for protocols other than TCP, UDP and SCTP (`network-policies.md:16, 276-280`).
- Database failover and data consistency. The searched documents do not cover these at all.