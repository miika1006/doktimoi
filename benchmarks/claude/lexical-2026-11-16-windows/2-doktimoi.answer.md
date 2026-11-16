I collected the evidence. Here is the memo.

---

# Decision memo: production review of the API Deployment (Kubernetes v1.32 docs)

**Verdict:** Do not approve the design as proposed. The Deployment's `maxUnavailable: 2` can take the app below the PDB's floor of five during a rollout. The 30-second grace period is a default value, and nothing in the docs ties it to how long requests take. Default-allow networking and base64 Secrets in Git provide no isolation and no confidentiality. All paths below are relative to `docs/`.

**Labels used below:** **G** = guarantee the docs state. **C** = configuration choice. **P** = prerequisite. **N** = not established by the docs.

## 1. PDB `minAvailable: 5`

- **Node failure (involuntary).** Not protected. Hardware failure, a VM that disappears, a kernel panic and similar events are involuntary (`concepts/workloads/pods/disruptions.md:21-65`). "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (G, `disruptions.md:92-131`). A node holding two replicas would leave four.
- **Node drain (voluntary).** Protected only for tools that use the Eviction API. `kubectl drain` evicts Pods and retries rejected evictions until a timeout (G, `disruptions.md:92-131`). Deleting Pods or Deployments directly bypasses the PDB (`disruptions.md:21-65`). With six replicas and a floor of five, only one Pod can be evicted at a time. By default, a drain waits for unhealthy Pods to become healthy. `AlwaysAllow` for unhealthy Pod eviction is recommended (C, `disruptions.md:133-145`).
- **Rolling update.** Not protected. Pods taken down by a rolling upgrade count against the budget, but "Deployment and StatefulSet are not limited by PDBs when doing rolling upgrades" (G, `disruptions.md:133-145`). `maxUnavailable` is the maximum number of Pods that can be unavailable during an update, and its default is 25% (`concepts/workloads/controllers/deployment.md:1189-1199`). With `maxUnavailable: 2`, availability can drop to four.
- **Recommendation.** Use `maxUnavailable: 0` with `maxSurge: 1`. Both values cannot be zero at the same time (`deployment.md:1201-1310`). This only works if surge capacity exists in the cluster (P).

## 2. Zone spreading

- **`topologyKey`** names a node label. Nodes with the same value for that label form one domain (`concepts/scheduling-eviction/topology-spread-constraints.md:95-140`). Use the zone label, and make sure every node carries it (P, `concepts/scheduling-eviction/assign-pod-node.md:234-267`).
- **`maxSkew`** must be greater than 0. With `DoNotSchedule`, it is the maximum allowed difference between a domain's count of matching Pods and the global minimum. With `ScheduleAnyway`, the scheduler only gives higher precedence to placements that reduce skew (`topology-spread-constraints.md:76-93`). `DoNotSchedule` is the default and leaves the Pod unscheduled. `ScheduleAnyway` still schedules it (`:95-140`). The scheduler's preference under `ScheduleAnyway` is weighed together with other scoring factors (`:335-354`).
- **Recommendation (C).** Use `maxSkew: 1` on the zone key with `DoNotSchedule` for a 2/2/2 layout. Add `minDomains: 3`, which is only valid with `DoNotSchedule`; while fewer domains are eligible, the global minimum is treated as 0 (`:95-140`).
- **When a zone is unavailable.**
  - The scheduler learns about zones only from existing nodes. A zone scaled to zero nodes is not considered (N/limitation, `:605-623`).
  - With `DoNotSchedule`, replacement Pods can stay Pending.
  - The constraints are not kept when Pods are removed, so a scale-down can leave Pods unbalanced (`:605-623`).

## 3. Probes for slow startup

- **Startup probe.** Use the same check as liveness, with `failureThreshold × periodSeconds` covering the worst-case startup time. For example, 30 × 10 gives 300 s. If the startup probe never succeeds, the container is killed and handled by its `restartPolicy` (G, `tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:311-347`).
- **Order of probes.** All other probes are disabled until the startup probe succeeds (G, `concepts/workloads/pods/pod-lifecycle.md:474-500`; same task page `:2-41`).
- **Traffic stops when readiness fails.** The Pod's IP is removed from the endpoints of every matching Service (`pod-lifecycle.md:474-500`).
- **Restarts happen when liveness or startup fails.**
- **Readiness keeps running for the container's whole life.** Readiness and liveness do not depend on each other (`probes.md:349-388`).
- **Liveness tuning.** Point liveness at a cheap endpoint with a higher `failureThreshold`, so the Pod shows as not ready before it is killed. Liveness should indicate only unrecoverable failure (`probes.md:2-41`).
- **N:** Whether the database being unreachable should fail readiness is an application decision. Do not tie liveness to the database.

## 4. Termination

The sequence is (`pod-lifecycle.md:559-582, 584-610, 612-634, 636-650`):

1. The Pod is marked Terminating with a deadline.
2. The `preStop` hook runs. The grace-period countdown starts *before* `preStop` runs (`reference/kubernetes-api/workload-resources/pod-v1.md:1688-1713`). If `preStop` is still running when the grace period ends, the kubelet grants a one-time 2-second extension.
3. TERM is sent to PID 1 of each container. The order across containers is arbitrary, and the image's `STOPSIGNAL` may replace TERM.
4. When the grace period expires, SIGKILL is sent to any process still running.

In parallel, the control plane evaluates removing the Pod from EndpointSlices. Terminating endpoints stay listed with `ready: false` and a `serving` condition, so load balancers stop sending them regular traffic (G, `:612-634`).

**30 s is not guaranteed to be enough.** It is only the default (`:584-610`), and `preStop` time is taken from it. A `preStop` that needs longer requires a larger `terminationGracePeriodSeconds`. Measure the longest request time (N) and size the grace period above `preStop` time plus drain time.

## 5. Resources

- **CPU limit:** enforced by throttling, as a hard limit.
- **Memory limit:** enforced reactively by OOM kills, and only under memory pressure.
- **Requests:** a container may use more than its request (G, `concepts/configuration/manage-resources-containers.md:27-67`). If only a limit is set, the request is copied from the limit.
- **HPA:** utilization is a percentage of the request. If any container lacks a CPU request, the Pod's CPU utilization is undefined and the HPA takes no action for that metric (G, `tasks/run-application/horizontal-pod-autoscale.md:89-121`).
- **Action (C):** set CPU requests on every container, including sidecars, and set memory limits. Decide on CPU limits knowing they cause throttling, which can slow startup and long requests.

## 6. HPA behavior

- Pods with a deletion timestamp are ignored, failed Pods are discarded, and Pods missing metrics are set aside. When scaling on CPU, Pods not yet ready, or whose last metric predates readiness, are also set aside (`horizontal-pod-autoscale.md:140-166`).
- **Missing metrics** are filled in conservatively: 100% of target for a scale-down, 0% for a scale-up.
- **Not-yet-ready Pods** count as 0% for a scale-up.
- If the recalculated ratio reverses direction or falls within tolerance, the HPA does nothing (`:167-202`). The default tolerance is 0.1 (`:140-166`).
- **Readiness windows:** a 30 s initial-readiness delay and a 5-minute CPU initialization period, both controller flags (`:167-202`). A slow-starting app interacts with these, and the docs do not say how for this app (N).
- **Scale-down** uses a default 300 s stabilization window. **Scale-up** has none and can add up to 4 Pods or 100% every 15 s (`:455-486`).
- **Prerequisite:** the Metrics Server must be installed separately (P, `:89-121`).

## 7. Least-privilege networking

- **Isolation.** Pods are non-isolated by default. A Pod becomes isolated for ingress or egress once any policy selects it with that entry in `policyTypes`. Allowed lists combine additively and policies never conflict (G, `concepts/services-networking/network-policies.md:51-81`).
- **Both ends must allow.** A connection succeeds only if the source's egress *and* the destination's ingress both allow it (`:51-81`).
- **Plan (C):**
  1. Apply default-deny for ingress and egress (`:254-262`).
  2. Allow ingress to the API port from known clients or the ingress tier.
  3. Allow egress from the API to the database's selector or `ipBlock` on the database port.
  4. Allow the database's ingress if it runs in the cluster.
- **IP rewriting.** For `ipBlock`, it is undefined whether source NAT happens before or after policy evaluation (`:142-203`).
- **DNS.** The policy page I searched does not document DNS egress. Adding an explicit egress rule to cluster DNS is a step to validate, not one the docs establish (N).
- **CNI support (P).** Policies need a network plugin that implements them, or they have no effect (`:45-49`). `endPort` also needs plugin support (`:281-307`).

## 8. Secrets

Base64 is not protection.

- Secrets are stored unencrypted in etcd by default. Anyone with API or etcd access can read them.
- Anyone who can create a Pod in a namespace can read every Secret in it, including indirectly by creating a Deployment.

The required steps are encryption at rest, least-privilege RBAC, limiting Secret access to specific containers, and considering an external secret store (G, `concepts/configuration/secret.md:1-53`). With encryption at rest, someone holding etcd backups cannot read the objects (`tasks/administer-cluster/securing-a-cluster.md:251-265`). Encryption is verified through `etcdctl` (`tasks/administer-cluster/kms-provider.md:339-368`). The `edit` role can access Secrets and run Pods as any ServiceAccount in the namespace. `view` deliberately excludes Secrets (`reference/access-authn-authz/rbac.md:667-686`).

The docs do not cover a Git workflow. Remove plaintext-equivalent Secret manifests from Git (N, a policy decision).

## 9. Reclaim policy

- **Inheritance.** Dynamically provisioned PVs take the class's `reclaimPolicy` when they are created, and it defaults to `Delete` (`concepts/storage/storage-classes.md:126-135`; `reference/kubernetes-api/config-and-storage-resources/storage-class-v1.md:83-99`).
- **Changing the class does not change existing PVs.** If the class did not meet expectations, "the PV must be edited or patched after it is created" (`concepts/storage/persistent-volumes.md:201-210`). Patch each existing PV to `Retain`.
- **Delete vs Retain.** `Delete` removes both the PV and the external storage asset. `Retain` keeps the PV in a "Released" state with its data, and an administrator must clean it up and delete the asset by hand (`persistent-volumes.md:185-199`).
- **PVC deletion** triggers the reclaim policy.
- **StatefulSet deletion or scale-down** affects PVCs only through `persistentVolumeClaimRetentionPolicy` (`whenDeleted` / `whenScaled`). Both default to `Retain`, and they do not apply when a node fails and a Pod is replaced (`concepts/workloads/controllers/statefulset.md:387-436`). That page also says the `StatefulSetAutoDeletePVC` feature gate must be enabled (P, as documented).

## 10. Prioritized checklist

1. Encrypt Secrets at rest and verify it in etcd. Remove Secrets from Git. Restrict RBAC for reading Secrets and for creating Pods and Deployments.
2. Patch existing database PVs to `Retain`, and set `reclaimPolicy: Retain` on the class for future PVs.
3. Confirm the CNI enforces NetworkPolicy. Apply default-deny, then the allow rules, and test DNS and database reachability from both ends.
4. Set the rollout to `maxUnavailable: 0`, `maxSurge: 1`. Keep the PDB, add `AlwaysAllow` for unhealthy Pod eviction, and confirm that drain tooling uses the Eviction API.
5. Add a startup probe sized to measured worst-case startup, a readiness probe, and a conservative liveness probe.
6. Size `preStop` and the grace period from measured request duration. Test draining using the `serving` condition.
7. Add a zone spread constraint (`maxSkew: 1`, `DoNotSchedule`, `minDomains: 3`).
8. Set CPU requests on all containers, confirm the Metrics Server is installed, and review HPA behavior during startup.

**Limits that still need application or cluster validation:**
- Whether long requests finish within the grace period.
- Whether there is spare capacity for a surge Pod, and for rescheduling after a zone loss (pending Pods under `DoNotSchedule`).
- DNS egress needs and CNI or `ipBlock` NAT behavior.
- The actual startup time relative to HPA initialization windows.
- Whether the database tolerates connection churn and failover.
- That node autoscaling is aware of zones.
- That surviving replicas can carry the load after an involuntary loss of one zone (two replicas), which the PDB cannot prevent.