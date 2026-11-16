# Held-out task: Claude Code, Windows, Doktimoi 0.14.2

16 November 2026. [heldout-task.md](../../heldout-task.md) is a batch-platform review on
the same pinned 409-file Kubernetes v1.32 corpus, written after all workflow changes so
none was tuned on it: CronJobs, Jobs, taints and affinity, priority and preemption,
quotas, ConfigMap updates, node-pressure eviction, Pod Security Standards and
ServiceAccount tokens. Claude Code 2.1.325, `claude-opus-5-5`, medium effort, three
alternating pairs. **Real-time antivirus scanning was on**; times compare within this run.

| Arm | Total tokens | Agent time | Cost | Tool calls | Index build |
| --- | ---: | ---: | ---: | ---: | ---: |
| Read/Grep/Glob control | 1,247,728 | 118.8 s | $0.99 | 34.0 | — |
| Doktimoi lexical | **642,117 (−48.5%)** | **93.8 s (−21.0%)** | **$0.70** | 14.3 | 22.2 s |

All six answers pass the tool-use audit, have ten numbered sections and only existing
citation ranges ([check-answers.mjs](../../check-answers.mjs)). A manual screen of the
decision-relevant qualifications found both arms equivalent: CronJobs may create two or
no Jobs, `activeDeadlineSeconds` takes precedence over `backoffLimit`, a toleration does
not keep Pods on tainted nodes without required node affinity, preemption honors PDBs
only on a best-effort basis, quotas do not affect running Pods, subPath mounts and
environment variables do not see ConfigMap updates, node-pressure eviction ignores PDBs
and the grace period, and `automountServiceAccountToken: false` disables token mounting.
No answer states the 100-missed-schedules limit. All answers exceed the 1,400-word target.

In all three Doktimoi runs an agent guessed a `--path` from a link to a page outside the
corpus; 0.14.2 widened that request to all sources with a label instead of returning an
error, so no extra round was needed.
