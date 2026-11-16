# Production task: Claude Code, Windows, Doktimoi 0.14.1 vs Read/Grep/Glob

16 November 2026, three alternating pairs on the unchanged [production-design task](../../task.md)
and the 409 pinned Kubernetes v1.32 files. Claude Code 2.1.325, `claude-opus-5-5`, medium
effort. **Real-time antivirus scanning was on**; times compare within this day's runs.

| Arm | Total tokens | Agent time | Cost | Tool calls | Index build |
| --- | ---: | ---: | ---: | ---: | ---: |
| Read/Grep/Glob control | 1,092,232 | 140.7 s | $0.85 | 31.3 | — |
| Doktimoi 0.14.1 lexical | 580,316 (−46.9%) | 99.4 s | $0.63 | 10.3 | 146.2 s |

These controls also serve the [0.14.2 Doktimoi arm](../lexical-0142-2026-11-16-windows/),
the [competitor arms](../competitors-2026-11-16/README.md) and the hybrid arm. All three
Doktimoi answers state the `StatefulSetAutoDeletePVC` prerequisite; one control omits it.
Doktimoi answers cite the grace-period countdown in the EphemeralContainer copy of the
sentence (`pod-v1.md:1688-1713`) rather than the Container section (line 1008).

An earlier start of this arm stopped at its first Doktimoi run: Claude tried the Read tool on
the corpus, which the host denied, and the audit then counted the denied calls as
violations. That run is in git history;
the SKILL.md wording and the audit were corrected before this run.
