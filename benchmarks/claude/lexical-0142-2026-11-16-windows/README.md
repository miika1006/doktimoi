# Production task: Doktimoi 0.14.2, Claude Code, Windows

16 November 2026, three Doktimoi runs (`--arm doktimoi`) compared with the same day's
[Read/Grep/Glob controls](../lexical-2026-11-16-windows/README.md). Same task, corpus,
model and settings. **Real-time antivirus scanning was on.**

| Arm | Total tokens | vs control | Agent time | Cost | Tool calls | Index build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Read/Grep/Glob control | 1,092,232 | — | 140.7 s | $0.85 | 31.3 | — |
| Doktimoi 0.14.1 | 580,316 | −46.9% | 99.4 s | $0.63 | 10.3 | 146.2 s |
| **Doktimoi 0.14.2** | **385,461** | **−64.7%** | **93.6 s** | $0.69 | 10.7 | **21.9 s** |

0.14.2 builds the index about 6.7 times faster and made no denied Read attempts. Two of
three answers state the `StatefulSetAutoDeletePVC` prerequisite; the third cites the
range containing it (`statefulset.md:387-463`) without stating it, which the strict
rubric counts as an omission. These runs used 0.14.2 before its `--path` fallback was
added; the agents' four guessed paths still cost a round each. Unpaired with the
control, and three runs vary: token means of 276k–441k per run.
