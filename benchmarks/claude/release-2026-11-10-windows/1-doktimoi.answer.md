# Decision memo: production design review of the API Deployment (Kubernetes v1.32 docs)

**Verdict:** Do not approve the design as proposed. The rollout setting `maxUnavailable: 2` conflicts with `minAvailable: 5`. Storing Secrets base64-encoded in Git is not protection. Default-allow networking and the default `Delete` reclaim policy need explicit replacements. Each finding is tagged **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, or **[N]** not established by the docs.

---

**1. PDB under node failure, drain and rolling update**

- **Node failure:** The PDB gives no protection here. "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:129-130`). A node can fail while the app is already at the minimum, which takes availability below five **[G]** (`tasks/run-application/configure-pdb.md:149-156`).
- **Node drain:** The PDB does protect this case, but only when the drain goes through the Eviction API, as `kubectl drain` does. The tool retries rejected evictions until it succeeds or hits a timeout (`disruptions.md:107-121`). With 6 replicas and `minAvailable: 5`, only one Pod can be evicted at a time. Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:61-64`). The docs recommend the `AlwaysAllow` unhealthy-pod eviction policy so that a drain is not blocked by unhealthy Pods (`disruptions.md:137-140`) **[C]**.
- **Rolling update:** The PDB does not limit it. Pods taken down by a rollout "do count against the disruption budget, but workload resources (such as Deployment…) are not limited by PDBs" (`disruptions.md:132-135`). With `maxUnavailable: 2`, availability can drop to 4/6 (`concepts/workloads/controllers/deployment.md:1189-1199`).
- **Recommendation:** Use `maxUnavailable: 0` with `maxSurge: 1`. `maxSurge` cannot be 0 when `maxUnavailable` is 0 (`deployment.md:1201-1206`). Consider replacing `minAvailable` with a PDB `maxUnavailable: 1`, which the docs recommend because it follows replica changes (`configure-pdb.md:174-176`). Setting `minAvailable` equal to the replica count would block drains forever (`configure-pdb.md:158-162`).

**2. Zone spreading**

- `topologyKey` names a node label. Nodes that share a value form one domain, and the scheduler balances Pods across domains (`concepts/scheduling-eviction/topology-spread-constraints.md:118-123`).
- `maxSkew` is the allowed imbalance between domains. It defaults to 1, and 0 is not allowed (`reference/kubernetes-api/workload-resources/pod-v1.md:209-263`).
- `DoNotSchedule` (the default) refuses to place a Pod that would violate the constraint. `ScheduleAnyway` places it anyway and prefers lower skew (`topology-spread-constraints.md:124-126`). That preference is weighed together with other scoring, such as resource usage (`topology-spread-constraints.md:345-354`).
- **Recommendation [C]:** Use the zone label as `topologyKey`, `maxSkew: 1`, and `DoNotSchedule`, so the layout is 2/2/2.
- **If a zone is unavailable:** With `DoNotSchedule`, replacement Pods can stay Pending rather than pile into the surviving zones. With `ScheduleAnyway`, they get scheduled but the spread becomes uneven. Domains are discovered only from existing nodes, so a node pool scaled to zero is invisible to the scheduler (`topology-spread-constraints.md:615-623`). Constraints are not re-enforced when Pods are removed; scale-down can leave an imbalance (`topology-spread-constraints.md:607-611`) **[N]**: rebalancing is not automatic.

**3. Probes for slow startup**

- **Startup probe:** Use one with `failureThreshold × periodSeconds` covering the worst-case startup time (`tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **When the other probes begin:** All other probes are disabled until the startup probe succeeds (`concepts/workloads/pods/pod-lifecycle.md:494-499`) **[G]**.
- **When the container restarts:** If the startup probe never succeeds, the kubelet kills the container after the budget runs out and applies `restartPolicy`. After startup, a failed liveness probe also kills the container (`pod-lifecycle.md:480-484`).
- **When traffic stops:** A failed readiness probe removes the Pod's IP from Service endpoints. Traffic stops, but the container is not restarted (`pod-lifecycle.md:486-491`).
- **[N]:** The real worst-case startup time has to be measured.

**4. Termination order**

1. The Pod is marked Terminating, and the grace-period clock starts.
2. The `preStop` hook runs. If it is still running when the grace period ends, the kubelet grants a one-off 2-second extension (`pod-lifecycle.md:584-603`).
3. TERM is sent to PID 1 in each container (`pod-lifecycle.md:605-610`).
4. When the grace period expires, SIGKILL is sent (`pod-lifecycle.md:637-642`).

In parallel, the endpoint for the terminating Pod stays in the EndpointSlice with `ready: false`, so load balancers stop sending it regular traffic. The `serving` condition can be used for draining (`pod-lifecycle.md:612-632`). The default grace period is 30 s, and the `preStop` hook uses part of that same budget (`pod-lifecycle.md:597-603`).

**Is 30 s enough?** No guarantee. Requests that run past the grace period are killed. Set `terminationGracePeriodSeconds` to at least preStop delay + longest request duration + margin **[C/N]**.

**5. Resources**

- A container may use more than its request when the node has spare capacity (`concepts/configuration/manage-resources-containers.md:27-33`).
- The CPU limit is enforced by throttling, so the container is slowed but not killed. The memory limit is enforced reactively by OOM kills when the kernel detects memory pressure (`manage-resources-containers.md:43-54`).
- If only a limit is set, the limit is copied as the request (`manage-resources-containers.md:63-67`).
- **HPA impact:** If any container lacks a CPU request, CPU utilization is undefined and the HPA takes no action on that metric (`tasks/run-application/horizontal-pod-autoscale.md:99-102`) **[G]**. Set CPU requests on **every** container, sidecars included.

**6. HPA behaviour**

- **Missing metrics:** The average is recomputed conservatively. Pods without metrics count as 100% of target when scaling down and 0% when scaling up (`horizontal-pod-autoscale.md:182-185`).
- **Not-yet-ready Pods:** They count as 0% when scaling up (`horizontal-pod-autoscale.md:187-190`). Whether a Pod counts as "not yet ready" depends on two windows: 30 s initial-readiness delay and a 5-minute CPU initialization period (`horizontal-pod-autoscale.md:167-178`). A slow-starting app can fall outside them.
- **Why scaling differs from the raw ratio:** If the recomputed ratio reverses direction or falls within tolerance, the HPA does nothing (`horizontal-pod-autoscale.md:192-196`). Scale-down also has a default 300 s stabilization window. Scale-up has no window and may add up to the larger of 4 Pods or 100% every 15 s (`horizontal-pod-autoscale.md:455-486`).

**7. Least-privilege networking**

- **Prerequisite [P]:** The CNI plugin must enforce NetworkPolicy. Without that, policies have no effect (`concepts/services-networking/network-policies.md:46-48`).
- **Isolation:** Ingress and egress isolation are independent. A Pod becomes isolated in a direction once any policy selects it with that direction in `policyTypes`. Allowed traffic is the union of all applicable policies, so policies are additive (`network-policies.md:52-77`).
- **Both ends:** A connection needs both egress permission on the source and ingress permission on the destination (`network-policies.md:79-81`).
- **Recommended policy set [C]:**
  - default-deny for both ingress and egress (`network-policies.md:210-262`);
  - allow ingress to the API only from the ingress or caller Pods, on the service port;
  - allow egress from the API only to the database port;
  - add the matching ingress rule on the database side;
  - allow DNS egress explicitly.
- **DNS [N]:** The sources I checked do not give the DNS allow rule. Default-deny egress blocks everything, so DNS lookups are blocked unless allowed; validate this.
- **Timing [N]:** New Pods can start unprotected until the plugin applies a policy, and the API gives no way to tell when that has happened (`network-policies.md:362-382`).

**8. Secrets**

- **Base64 is not protection.** Values are "obscured but not secret" (`concepts/configuration/secret.md:305-307`). Secrets are stored unencrypted in etcd by default (`secret.md:35-37`).
- **Required steps:**
  - Enable encryption at rest (`secret.md:42-47`; `tasks/administer-cluster/securing-a-cluster.md:251-265`).
  - Use least-privilege RBAC on Secrets.
  - Restrict Secret access to specific containers.
  - Consider an external secret store.
- **Pod-creation permission:** Anyone who can create a Pod, or a Deployment, in the namespace can read any Secret there (`secret.md:37-40`). So RBAC must also restrict workload creation.
- **[N]:** The docs I read say nothing about storing base64 Secret manifests in Git. Treat the Git copies as plaintext and remove them.

**9. Storage reclaim**

- Dynamically provisioned PVs take the StorageClass `reclaimPolicy`, which defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`). That policy is applied at provisioning time (`storage-classes.md:33-36`).
- **Existing PVs:** To change an existing PV, "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). Changing the class does not update existing PVs **[N]**: the docs never say it does.
- **`Delete`:** Removes the PV and the backing storage asset (`persistent-volumes.md:201-206`).
- **`Retain`:** Leaves the PV "Released" after its PVC is deleted. Cleanup is manual, and the storage asset survives PV deletion (`persistent-volumes.md:185-199`).
- **StatefulSet deletion or scale-down:** This does *not* delete volumes (`concepts/workloads/controllers/statefulset.md:52-54`). Deleting the PVCs can delete the data, depending on the reclaim policy (`tutorials/stateful-application/cassandra.md:241-247`).
- **Recommendation [C]:** Use `Retain` for the database volumes, and patch existing PVs individually.

**10. Prioritized rollout and validation checklist**

1. Remove Secrets from Git and rotate them. Enable encryption at rest. Tighten RBAC on Secrets and on Pod/Deployment creation.
2. Set the PVs backing the database to `Retain`, and patch existing PVs.
3. Set the rollout to `maxUnavailable: 0`, `maxSurge: 1`. Use a PDB with `maxUnavailable: 1` and `unhealthyPodEvictionPolicy: AlwaysAllow`.
4. Add the startup, readiness and liveness probes. Set `terminationGracePeriodSeconds` and a `preStop` hook from measured request times.
5. Set CPU and memory requests on every container, and decide on limits. Then enable the HPA. Check `minReplicas` against the zone count and the PDB.
6. Add the zone spread constraint (`maxSkew: 1`, `DoNotSchedule`), and test what happens when a zone is lost.
7. Confirm the CNI enforces NetworkPolicy. Apply default-deny, then the allow rules including DNS and the database. Test from both ends.
8. Validate the result with a drain, a rollout and a simulated node failure.

**Limits that still need validation (the docs do not guarantee them):**

- Real startup and request durations against the probe budgets and the grace period.
- Whether the CNI enforces policies, and how long it takes to apply them.
- Whether cluster or provider automation honours the Eviction API (`disruptions.md:103-105`).
- How the node autoscaler behaves with spread constraints and zones scaled to zero.
- How the database itself survives the API's connection churn and failover. The documents do not cover the database's behaviour.