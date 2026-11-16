# Decision memo: production readiness review of the six-replica API

**Scope:** Kubernetes v1.32 documentation in `docs/` only. Line ranges point to the local files. Labels used below: **[G]** documented guarantee, **[C]** configuration choice, **[P]** prerequisite, **[N]** not established by these docs.

**Verdict:** Not ready as proposed. The PDB, rollout settings and Secrets handling don't give the protection the team expects. Networking and storage defaults need explicit changes before go-live.

---

### 1. Does `minAvailable: 5` guarantee five replicas?

No, in none of the three cases.

- **Node failure:** This is an involuntary disruption (`docs/concepts/workloads/pods/disruptions.md:26-34`). PDBs "cannot be prevented by PDBs; however they do count against the budget" (`:130-131`). The task doc says outright that a budget "does not truly guarantee" the minimum, because a node can fail while the set is already at the minimum (`docs/tasks/run-application/configure-pdb.md:148-154`). **[G: no guarantee]**
- **Node drain:** `kubectl drain` uses the Eviction API and is refused when an eviction would breach the budget (`disruptions.md:107-121`). With `minAvailable: 5`, an eviction is allowed only if 5 or more healthy pods remain (`configure-pdb.md:131-132`). With six replicas that means **one eviction at a time**, and a drain blocks until the replacement is available (`disruptions.md:195-197`). The protection holds only if tools call the Eviction API: deleting pods or Deployments bypasses PDBs (`:62-65`). **[G, with P: tools must use eviction]**
- **Rolling update:** Rolling-upgrade pods count against the budget, but "Deployment and StatefulSet … are not limited by PDBs when doing rolling upgrades" (`disruptions.md:133-136`). `maxUnavailable: 2` lets availability fall to 4 (`docs/concepts/workloads/controllers/deployment.md:1191-1199`). That conflicts with the PDB's intent. **[C conflict]**

**Recommendation:** use `maxUnavailable: 0` with `maxSurge: 1` (or 25%, which rounds up). This is allowed because only one of the two fields may be 0 (`deployment.md:1194, 1203-1206`). Add `unhealthyPodEvictionPolicy: AlwaysAllow` so that misbehaving pods don't block drains (`disruptions.md:138-141`). Note that with this PDB any single pre-existing failure blocks all drains.

### 2. Zone spreading

Add a `topologySpreadConstraint` with:

- `topologyKey: topology.kubernetes.io/zone` (the well-known key, `docs/concepts/scheduling-eviction/topology-spread-constraints.md:206-209`)
- `maxSkew: 1`
- a `labelSelector` that matches the pod template
- `matchLabelKeys: [pod-template-hash]`, so each revision is spread on its own (`:134-160`)

How the fields behave:

- `topologyKey` groups nodes that share a label value into domains (`:117-122`).
- With `DoNotSchedule` (the default), `maxSkew` is a hard limit on the difference from the global minimum. With `ScheduleAnyway`, skew is only a scoring preference (`:82-93, 124-126`).
- Nodes that lack the key are bypassed (`:480-490`).

**Zone loss:** the docs don't state the outcome directly. **[N]** From the definitions, an eligible domain must still have matching nodes (`:121-122`), and `minDomains` affects the global minimum only when it is set (`:95-115`). Whether the replacement pods fit in the two surviving zones depends on their capacity. **Recommendation:** run `DoNotSchedule` for zones only after validating that the remaining zones have headroom. Otherwise use `ScheduleAnyway` and accept that pods may end up unbalanced.

### 3. Probes for slow startup

- **Startup probe:** all other probes are disabled until it succeeds. If it fails, the container is killed and restarted under the restart policy (`docs/concepts/workloads/pods/pod-lifecycle.md:492-497`; `docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md:31-35`). Size `failureThreshold × periodSeconds` above the worst-case startup time; for example 30 × 10 s gives 300 s (`:342-347`). Point it at the liveness endpoint and leave the liveness defaults unchanged (`pod-lifecycle.md:552-557`).
- **Readiness probe:** if it fails, the Pod IP is removed from Service endpoints, so **traffic stops**. The container is **not** restarted (`pod-lifecycle.md:485-490`). It runs for the container's whole lifecycle (`configure-...probes.md:360-362`). Check the database dependency here, not in liveness (`pod-lifecycle.md:524-528`).
- **Liveness probe:** if it fails, the container is **restarted** (`:479-483`). Keep it limited to the process itself.

### 4. Termination order

1. The API server records the deletion time and grace period. The clock starts when the Pod is marked Terminating (`pod-lifecycle.md:584-589`).
2. The `preStop` hook runs first, inside that same grace period. If the hook is still running when the period expires, the kubelet grants a one-off extension of only 2 seconds (`:591-601`).
3. SIGTERM (or the image's STOPSIGNAL) is sent next. Containers receive it in an arbitrary order (`:572, 603-610`).
4. At the same time, the control plane marks the endpoints as terminating with `ready=false`, so load balancers stop sending regular traffic. The `serving` condition can be used for draining (`:612-632`).
5. When the period expires, any remaining processes get SIGKILL (`:636-639`, `:573-575`).

Eviction honours `terminationGracePeriodSeconds` (`disruptions.md:143-145`).

**Is 30 seconds enough?** It isn't guaranteed. **[N]** Long requests plus the `preStop` time must fit inside one budget. Set the grace period from the measured p99 request duration plus the `preStop` time.

### 5. CPU and memory resources

- **Requests:** a container may use more than its request if the node has spare capacity (`docs/concepts/configuration/manage-resources-containers.md:29-34`).
- **CPU limit:** enforced by **throttling**, a hard cap (`:43-46`).
- **Memory limit:** enforced reactively by **OOM kill**, and only under memory pressure (`:48-53`).
- If a limit is set without a request, the request defaults to the limit (`:63-67`).
- **HPA dependency:** if any container lacks a CPU request, CPU utilization is undefined and the HPA **takes no action** for that metric (`docs/tasks/run-application/horizontal-pod-autoscale.md:97-101`). **[P]**

**Throttling and slow startup:** these docs don't establish how throttling interacts with startup time. **[N]** Measure it, because a tight CPU limit could stretch startup past the startup-probe budget.

### 6. HPA behaviour

- **Basic formula:** desired replicas = ceil(current × current metric ÷ target). Changes within a 0.1 tolerance of the target are skipped (`horizontal-pod-autoscale.md:131-147`).
- **Excluded pods:** terminating pods are ignored and failed pods are discarded. Pods with missing metrics, and pods that are not yet ready, are set aside (`:153-165`).
- **"Not yet ready" timing:** governed by the initial readiness delay (default 30 s) and the CPU initialization period (default 5 min) (`:167-178`).
- **Missing metrics:** these pods are counted as 100 % of target on scale-down and 0 % on scale-up. Not-yet-ready pods are counted as 0 % on scale-up (`:183-191`).
- **Result:** if the recomputed ratio reverses direction or falls within tolerance, nothing happens (`:193-197`). The HPA status still shows the raw average (`:199-202`).
- **Downscale stabilization:** the highest recommendation within a 5-minute window is used (`:213-218`).

With slow startup, new pods hold scale-ups back for a while, so scale-ups are damped.

### 7. Least-privilege networking

- **Prerequisite:** a CNI plugin that enforces NetworkPolicy. Without one, NetworkPolicy objects "will have no effect" (`docs/concepts/services-networking/network-policies.md:45-49, 92-94`). **[P]**
- **Default:** pods are non-isolated in both directions (`:59, 67, 208-212`).
- **Isolation:** a pod becomes isolated for ingress or egress once any policy that selects it lists that direction in `policyTypes` (`:59-73`).
- **Additive rules:** policies are additive (a union), so order of evaluation doesn't matter (`:75-77`). Only the pod's own node is always allowed for ingress (`:33-36, 70-71`).
- **Both ends:** a connection needs egress allowed at the source **and** ingress allowed at the destination (`:79-81`).

**Plan:**

1. Default-deny all traffic in the namespace (`:254-262`).
2. Allow ingress from the ingress or load-balancer path to the API port.
3. Allow egress to the database, plus ingress at the database.

**DNS:** these docs, as searched, don't give a DNS egress rule. **[N]** After default-deny egress, explicitly allow DNS to the cluster DNS and verify name resolution.

Also note that, depending on the plugin, the source IP a policy sees may be a load balancer's or a node's (`:200-206`).

### 8. Is base64 encoding enough for Secrets?

No. Secrets are stored **unencrypted in etcd by default**. Anyone with API or etcd access can read them. Anyone who can create a Pod, or indirectly a Deployment, in the namespace can read every Secret in that namespace (`docs/concepts/configuration/secret.md:35-53`).

Required controls:

- Encryption at rest **[P]**. It applies to newly created or updated objects after the API server restarts (`docs/tasks/administer-cluster/encrypt-data.md:524-528`), so existing Secrets must be rewritten. Losing the keys means deleting the entries from etcd (`:194-198`).
- Least-privilege RBAC.
- Restricting Secret access to specific containers.
- An external secret store (`secret.md:42-48`).

**Why Pod creation rights matter:** anyone who can create or edit workloads can mount arbitrary Secrets and use arbitrary ServiceAccounts (`docs/reference/access-authn-authz/authorization.md:348-370`). Treat those rights as Secret-read rights.

Base64 is only a data encoding: `stringData` exists so you don't have to encode it yourself (`secret.md:259-262`). Base64 Secrets committed to Git are effectively plaintext.

### 9. Storage reclaim policy

- **Inheritance:** dynamically provisioned PVs take the StorageClass's `reclaimPolicy`, and the class defaults to `Delete` (`docs/concepts/storage/storage-classes.md:126-135`).
- **Changing the class doesn't touch existing PVs:** their policy has to be "edited or patched after it is created" (`docs/concepts/storage/persistent-volumes.md:205-210`). **[G]**
- **Delete:** deleting the PVC removes the PV object *and* the backing storage asset (`:201-205`).
- **Retain:** the PV becomes `Released`, keeps its data, and needs manual cleanup (`:185-199`).
- **PVC deletion vs StatefulSet deletion or scale-down:** deleting or scaling down a StatefulSet does **not** delete its volumes by default (`docs/concepts/workloads/controllers/statefulset.md:52-55`). `persistentVolumeClaimRetentionPolicy` (`whenDeleted`/`whenScaled`, default `Retain`, requires a feature gate) controls whether the PVCs are deleted (`:388-423`). Once a PVC is deleted, the PV's reclaim policy decides the data's fate.

**Recommendation:** use `Retain` for the database's volumes, and patch the existing PVs explicitly.

### 10. Prioritized rollout and validation checklist

1. **Secrets:** enable encryption at rest and rewrite existing Secrets. Remove Secrets from Git. Audit who can create workloads (Q8).
2. **Storage:** patch existing database PVs to `Retain`. Set the StorageClass `reclaimPolicy` and confirm the StatefulSet retention policy (Q9).
3. **Rollout:** `maxUnavailable: 0`, `maxSurge: 1`. Add the PDB with `AlwaysAllow`. Confirm that drain automation uses the Eviction API (Q1).
4. **Probes and termination:** a startup probe sized to measured startup, a readiness probe that includes the database dependency, a liveness probe limited to the process. A `preStop` hook plus a grace period sized to long requests (Q3, Q4).
5. **Resources:** CPU requests on every container, a memory limit, and a CPU limit that has been tested (Q5, Q6).
6. **Zone spreading:** the constraint from Q2 with `matchLabelKeys`. Run a zone-loss drill.
7. **Networking:** confirm the CNI enforces policy, then apply default-deny, explicit allows and DNS. Test both ends of each connection (Q7).

**Limits that still need application or cluster validation (not guaranteed by these documents):**

- That the 30-second (or revised) grace period actually finishes the longest requests (Q4). **[N]**
- That the surviving zones have the capacity to keep five replicas when one zone is lost. A PDB can't protect against that loss (Q1, Q2). **[N]**
- That the CNI really enforces NetworkPolicy and that DNS still works after default-deny (Q7). **[P/N]**
- The HPA's reaction time with slow-starting pods and the 5-minute stabilization window under real load (Q6). **[N]**
- That cluster or provider automation honours PDBs instead of deleting pods directly (`disruptions.md:62-65, 81-89`). **[P]**